/**
 * 隔离构建与可信校验（T39）。
 * 五道安全门槛（scope/syntax/types/contracts/isolation）全部通过才允许执行；
 * 教学行为断言（learning checks）失败只标记探索试跑，不能晋级。
 * 构建：esbuild 固定工具链、虚拟文件系统、不允许外部模块解析、无秘密。
 * 报告绑定 sourceDigest + baseManifestId + editPolicyDigest + toolchainDigest +
 * testSuiteDigest + bundleDigest（用例 10）；安全门槛失败的构建不能执行。
 * 依据设计文档 v1.1 第 9.7 节与验收 A15/A16/A18/A23。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as esbuild from "esbuild";
import ts from "typescript";
import type { Database } from "@agentglass/db";
import { newId, nowIso } from "@agentglass/db";
import type { BlobStore } from "@agentglass/events";
import type { CodeValidationReport, LessonEditPolicy } from "@agentglass/contracts";
import { guardPatch } from "./patch-guard";
import { digestFiles } from "./drafts";
import { sha256Text } from "./hash";

export const TOOLCHAIN_VERSION = "esbuild-0.25-typescript-5";

/** 平台安全测试套件（服务端拥有；不从学生草稿导入） */
export function safetySuiteSource(slots: string[]): string {
  return `slots=${slots.sort().join(",")};suite=loop-continue-boolean-v1;toolchain=${TOOLCHAIN_VERSION}`;
}

export interface SafetyRunnerResult {
  passed: boolean;
  failures: Array<{ id: string; detail: string }>;
}

export type SafetyRunner = (
  bundlePath: string,
  slots: string[],
) => Promise<SafetyRunnerResult>;

export interface BuildRequest {
  draftId: string;
  draftRevision: number;
  /** 学习者候选文件全集 */
  files: Record<string, string>;
  /** 服务端冻结基线 */
  baseFiles: Record<string, string>;
  policy: LessonEditPolicy;
  baseManifestId: string;
  /** 扩展槽映射（slot → "path#Symbol"，来自课程 manifest）；bundle 按槽名导出 */
  extensionSlots?: Record<string, string>;
  /** 隔离客体执行的平台安全测试（真实子进程 + 超时） */
  safetyRunner: SafetyRunner;
  outputDir: string;
}

export interface BuildOutcome {
  status: "passed" | "safety_failed";
  report: CodeValidationReport;
  bundle?: { path: string; digest: string };
  revisionId?: string;
}

export class CodeBuildService {
  constructor(
    private readonly db: Database,
    private readonly blobs: BlobStore,
  ) {}

  async validate(req: BuildRequest): Promise<BuildOutcome> {
    const buildId = newId("build");
    const sourceDigest = digestFiles(req.files);
    const policyDigest = req.policy.digest;
    const slots = req.policy.regions
      .filter((r) => r.kind === "function_body")
      .map((r) => (r as { symbol: string }).symbol);
    const toolchainDigest = sha256Text(`${TOOLCHAIN_VERSION}|${esbuild.version}`);
    const testSuiteDigest = sha256Text(safetySuiteSource(slots));

    const safetyGates: CodeValidationReport["safetyGates"] = {
      scope: "not_run",
      syntax: "not_run",
      types: "not_run",
      contracts: "not_run",
      isolation: "not_run",
    };
    const diagnostics: string[] = [];
    let bundle: { path: string; digest: string } | undefined;
    let revisionId: string | undefined;
    let learningChecks: CodeValidationReport["learningChecks"] = [];

    // —— 门槛 1：范围 ——
    const guard = guardPatch({ baseFiles: req.baseFiles, candidateFiles: req.files, policy: req.policy });
    safetyGates.scope = guard.ok ? "passed" : "failed";
    diagnostics.push(...guard.errors.map((e) => `[scope] ${e}`));

    if (guard.ok) {
      const syntaxErrors = checkSyntax(req.files);
      safetyGates.syntax = syntaxErrors.length === 0 ? "passed" : "failed";
      diagnostics.push(...syntaxErrors.map((e) => `[syntax] ${e}`));

      if (safetyGates.syntax === "passed") {
        const contractErrors = checkContracts(req.files, req.policy);
        safetyGates.contracts = contractErrors.length === 0 ? "passed" : "failed";
        diagnostics.push(...contractErrors.map((e) => `[contracts] ${e}`));

        const typeErrors = checkTypes(req.files);
        safetyGates.types = typeErrors.length === 0 ? "passed" : "failed";
        diagnostics.push(...typeErrors.map((e) => `[types] ${e}`));

        const isoErrors = checkIsolation(req.files, req.policy);
        safetyGates.isolation = isoErrors.length === 0 ? "passed" : "failed";
        diagnostics.push(...isoErrors.map((e) => `[isolation] ${e}`));
      }

      const staticPassed = Object.values(safetyGates).every((s) => s === "passed");
      if (staticPassed) {
        // —— 冻结构建（虚拟文件、禁外部解析；按扩展槽名导出） ——
        const entry = generateEntry(req.policy, req.extensionSlots);
        const result = await esbuild.build({
          stdin: { contents: entry, resolveDir: "/virtual", sourcefile: "entry.ts" },
          bundle: true,
          write: false,
          format: "cjs",
          platform: "node",
          target: "node18",
          logLevel: "silent",
          plugins: [virtualFilesPlugin(req.files)],
        });
        if (result.errors.length > 0) {
          safetyGates.isolation = "failed";
          diagnostics.push(...result.errors.map((e) => `[build] ${e.text}`));
        } else {
          const code = result.outputFiles![0]!.text;
          const bundleDigest = sha256Text(code);
          revisionId = newId("rev");
          const revDir = join(req.outputDir, revisionId);
          mkdirSync(revDir, { recursive: true });
          const bundlePath = join(revDir, "bundle.cjs");
          writeFileSync(bundlePath, code, "utf8");
          bundle = { path: bundlePath, digest: bundleDigest };

          // —— 运行期安全测试：隔离子进程 + 硬超时（学生代码忙等会被杀死） ——
          const runner = await req.safetyRunner(bundlePath, slots);
          learningChecks = runner.failures.length === 0
            ? [{ id: "safety.runtime", status: "passed" }]
            : runner.failures.map((f) => ({ id: `safety.${f.id}`, status: "failed" as const }));
          if (!runner.passed) {
            safetyGates.isolation = "failed";
            diagnostics.push(...runner.failures.map((f) => `[safety] ${f.id}: ${f.detail}`));
          }

          if (runner.passed) {
            this.db
              .prepare(
                `INSERT INTO agent_revisions (id, owner_id, project_id, lesson_id, lesson_version,
                  base_agent_revision_id, source_manifest_id, source_digest, bundle_ref, bundle_path,
                  edit_policy_digest, toolchain_digest, test_suite_digest, validation_report_id,
                  author_kind, author_actor_id, state_schema_version, created_at)
                 VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'human', ?, 'lesson-state-v1', ?)`,
              )
              .run(
                revisionId,
                "local-learner",
                "local-project",
                lessonIdFromPolicy(req.policy),
                req.policy.lessonVersion,
                req.baseManifestId,
                sourceDigest,
                this.blobs.putText(code, "text/javascript").id,
                bundlePath,
                policyDigest,
                toolchainDigest,
                testSuiteDigest,
                buildId,
                "local-learner",
                nowIso(),
              );
          } else {
            revisionId = undefined;
          }
        }
      }
    }

    const diagnosticsRef = this.blobs.putJson(diagnostics);
    const report: CodeValidationReport = {
      id: buildId,
      draftId: req.draftId,
      draftRevision: req.draftRevision,
      sourceDigest,
      baseManifestId: req.baseManifestId,
      editPolicyDigest: policyDigest,
      toolchainDigest,
      testSuiteDigest,
      bundleDigest: bundle?.digest,
      safetyGates,
      learningChecks,
      previewAllowed: Object.values(safetyGates).every((s) => s === "passed"),
      diagnosticsRef,
    };
    this.db
      .prepare(
        `INSERT INTO code_builds (id, draft_id, draft_revision, source_digest, base_manifest_id,
          edit_policy_digest, toolchain_digest, test_suite_digest, bundle_ref, bundle_digest,
          safety_gates, learning_checks, diagnostics, preview_allowed, status, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        buildId,
        req.draftId,
        req.draftRevision,
        sourceDigest,
        req.baseManifestId,
        policyDigest,
        toolchainDigest,
        testSuiteDigest,
        bundle ? this.blobs.putText(`bundle-on-disk:${bundle.path}`).id : null,
        bundle?.digest ?? null,
        JSON.stringify(safetyGates),
        JSON.stringify(learningChecks),
        JSON.stringify(diagnostics),
        report.previewAllowed ? 1 : 0,
        report.previewAllowed ? "passed" : "safety_failed",
        nowIso(),
        nowIso(),
      );
    return {
      status: report.previewAllowed ? "passed" : "safety_failed",
      report,
      bundle: report.previewAllowed ? bundle : undefined,
      revisionId,
    };
  }

  getReport(buildId: string): (CodeValidationReport & { diagnostics: string[] }) | undefined {
    const row = this.db.prepare("SELECT * FROM code_builds WHERE id = ?").get(buildId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      id: buildId,
      draftId: String(row.draft_id),
      draftRevision: Number(row.draft_revision),
      sourceDigest: String(row.source_digest),
      baseManifestId: String(row.base_manifest_id),
      editPolicyDigest: String(row.edit_policy_digest),
      toolchainDigest: String(row.toolchain_digest),
      testSuiteDigest: String(row.test_suite_digest),
      bundleDigest: (row.bundle_digest as string | null) ?? undefined,
      safetyGates: JSON.parse(String(row.safety_gates)),
      learningChecks: JSON.parse(String(row.learning_checks)),
      previewAllowed: Number(row.preview_allowed) === 1,
      diagnosticsRef: this.blobs.meta("__unused__"),
      diagnostics: JSON.parse(String(row.diagnostics)) as string[],
    };
  }
}

function lessonIdFromPolicy(policy: LessonEditPolicy): string {
  const m = policy.lessonVersion.match(/^(L\d+)/);
  return m?.[1] ?? "L";
}

// ---- 门槛实现 ----

function checkSyntax(files: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    const result = ts.transpileModule(content, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
      fileName: path,
      reportDiagnostics: true,
    });
    for (const d of result.diagnostics ?? []) {
      errors.push(`${path}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
    }
  }
  return errors;
}

/**
 * 合同门槛：导出签名摘要必须与课程固定合同一致。
 * 课程可声明 "dynamic"（首次生成并回填）；正式课程必须固定摘要。
 */
function checkContracts(files: Record<string, string>, policy: LessonEditPolicy): string[] {
  const errors: string[] = [];
  if (policy.fixedContractDigest === "dynamic") return errors;
  for (const region of policy.regions) {
    if (region.kind !== "function_body") continue;
    const file = files[region.path];
    if (file == null) {
      errors.push(`${region.path}: 文件缺失`);
      continue;
    }
    const dig = exportContractDigest(file);
    if (dig !== policy.fixedContractDigest) {
      errors.push(`${region.path}: 导出签名与课程固定合同不一致（导出签名不可修改）`);
    }
  }
  return errors;
}

export function exportContractDigest(source: string): string {
  const sf = ts.createSourceFile("c.ts", source, ts.ScriptTarget.ES2022, true);
  const sigs: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      const bodyStart = stmt.body.getStart(sf);
      sigs.push(source.slice(stmt.getStart(sf), bodyStart).replace(/\s+/g, " ").trim());
    }
    if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) {
      sigs.push(stmt.getText(sf).replace(/\s+/g, " ").trim());
    }
  }
  return sha256Text(sigs.sort().join("\n"));
}

/** 内存编译器宿主：类型检查只允许访问课程文件与 TS 标准库 */
function checkTypes(files: Record<string, string>): string[] {
  const errors: string[] = [];
  const mem = new Map<string, string>();
  for (const [k, v] of Object.entries(files)) mem.set(norm(k), v);
  const rootNames = [...mem.keys()];
  const defaultHost = ts.createCompilerHost({ strict: true });
  const host: ts.CompilerHost = {
    ...defaultHost,
    getSourceFile: (name, languageVersion, onError, shouldCreate) => {
      const key = norm(name);
      if (mem.has(key)) {
        return ts.createSourceFile(name, mem.get(key)!, languageVersion, true);
      }
      return defaultHost.getSourceFile(name, languageVersion, onError, shouldCreate);
    },
    getCurrentDirectory: () => "/",
    readFile: (name) => mem.get(norm(name)) ?? defaultHost.readFile(name),
    fileExists: (name) => mem.has(norm(name)) || defaultHost.fileExists(name),
  };
  const program = ts.createProgram(
    rootNames,
    { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, skipLibCheck: true, types: [] },
    host,
  );
  for (const d of ts.getPreEmitDiagnostics(program)) {
    // 标准库内部诊断跳过；只报告课程文件的真实类型错误
    if (!d.file || !mem.has(norm(d.file.fileName))) continue;
    errors.push(`${d.file.fileName}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
  }
  return errors;
}

function norm(name: string): string {
  return name.replace(/^\.\//, "").replace(/\\/g, "/").replace(/^\/virtual\//, "");
}

const FORBIDDEN_RUNTIME = /\b(eval|Function|require|process|globalThis|__dirname|__filename)\b|\bimport\s*\(/;

function checkIsolation(files: Record<string, string>, policy: LessonEditPolicy): string[] {
  const errors: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    const sf = ts.createSourceFile(path, content, ts.ScriptTarget.ES2022, true);
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt)) {
        const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
        const allowed = policy.allowedImports.some((a) => spec === a || spec.startsWith(`${a}/`));
        if (!allowed) errors.push(`${path}: 不允许的导入 ${spec}`);
      }
    }
    // 排除接口/类型声明文本后扫描禁用构造
    const jsish = stripTypes(content);
    if (FORBIDDEN_RUNTIME.test(jsish)) {
      errors.push(`${path}: 使用了被禁止的运行时构造（eval/Function/require/动态 import/process/globalThis）`);
    }
  }
  return errors;
}

function stripTypes(source: string): string {
  const sf = ts.createSourceFile("s.ts", source, ts.ScriptTarget.ES2022, true);
  let out = "";
  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)) continue;
    out += stmt.getText(sf) + "\n";
  }
  return out;
}

/**
 * 入口按扩展槽名导出：manifest `loop_continue: path#shouldContinue` →
 * `module.exports.loop_continue = require("./path").shouldContinue`。
 * 宿主通过槽名调用；符号映射由课程包冻结声明。
 */
function generateEntry(
  policy: LessonEditPolicy,
  extensionSlots?: Record<string, string>,
): string {
  const lines: string[] = ["const out = {};"];
  const seen = new Set<string>();
  if (extensionSlots) {
    for (const [slot, ref] of Object.entries(extensionSlots)) {
      const hashIndex = ref.indexOf("#");
      const path = hashIndex >= 0 ? ref.slice(0, hashIndex) : ref;
      const symbol = hashIndex >= 0 ? ref.slice(hashIndex + 1) : slot;
      if (seen.has(path)) continue;
      seen.add(path);
      lines.push(`{ const m = require(${JSON.stringify(`./${path}`)});`);
      lines.push(`  out[${JSON.stringify(slot)}] = m[${JSON.stringify(symbol)}];`);
      lines.push(`  for (const k of Object.keys(m)) { if (!(k in out)) out[k] = m[k]; } }`);
    }
  }
  // 其余开放区域文件也合并导出（符号名导出）
  for (const region of policy.regions) {
    const path = region.path;
    if (seen.has(path)) continue;
    if (!path.endsWith(".ts")) continue;
    seen.add(path);
    lines.push(`{ const m = require(${JSON.stringify(`./${path}`)}); for (const k of Object.keys(m)) { if (!(k in out)) out[k] = m[k]; } }`);
  }
  lines.push("module.exports = out;");
  return lines.join("\n");
}

function virtualFilesPlugin(files: Record<string, string>): esbuild.Plugin {
  return {
    name: "virtual-lesson-files",
    setup(build) {
      build.onResolve({ filter: /^\.\// }, (args) => {
        if (args.kind === "import-statement" || args.kind === "require-call") {
          return { path: args.path, namespace: "virtual" };
        }
        return undefined;
      });
      build.onLoad({ filter: /.*/, namespace: "virtual" }, (args) => {
        const p = norm(args.path);
        const content = files[p];
        if (content == null) return { errors: [{ text: `虚拟文件缺失: ${p}` }] };
        return { contents: content, loader: "ts", resolveDir: "/virtual" };
      });
    },
  };
}
