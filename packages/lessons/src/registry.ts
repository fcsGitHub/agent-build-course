/**
 * 课程包注册表（T34）。从 lessons/ 目录加载 manifest、讲解、案例提示、
 * 编辑策略、开放代码基线与数据集。课程是声明性包；linter 拒绝自动发送等配置。
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  CaseHintsFile,
  LessonCatalogEntry,
  LessonEditPolicy,
  LessonManifest,
} from "@agentglass/contracts";
import { sha256Text } from "@agentglass/code-lab";

export class LessonRegistry {
  private aliasCache: Map<string, string> | null = null;

  constructor(private readonly lessonsDir: string) {}

  /** 支持目录名（L05-observe-act）与 manifest 短 ID（L05）两种引用形式 */
  private resolveId(id: string): string {
    if (existsSync(join(this.lessonsDir, id, "manifest.yaml"))) return id;
    if (this.aliasCache == null) {
      this.aliasCache = new Map();
      for (const dir of this.lessonDirNames()) {
        const m = this.loadManifest(dir);
        if (m) this.aliasCache.set(m.id, dir);
      }
    }
    const alias = this.aliasCache.get(id);
    if (alias) return alias;
    return id;
  }

  catalog(): LessonCatalogEntry[] {
    const entries: LessonCatalogEntry[] = [];
    for (const dir of this.lessonDirNames()) {
      const manifest = this.loadManifest(dir);
      if (!manifest) continue;
      entries.push({
        // 目录名是稳定的外部标识（如 L05-observe-act）；manifest.id 是短 ID
        id: dir,
        title: manifest.title,
        stage: manifest.stage,
        summary: manifest.summary,
        revision: manifest.revision,
        prerequisites: manifest.prerequisites,
        path: dir,
      });
    }
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  }

  has(id: string): boolean {
    return this.loadManifest(this.resolveId(id)) != null;
  }

  manifest(id: string): LessonManifest {
    const m = this.loadManifest(this.resolveId(id));
    if (!m) throw new Error(`LESSON_NOT_FOUND: ${id}`);
    return m;
  }

  lessonDir(id: string): string {
    return join(this.lessonsDir, this.resolveId(id));
  }

  lessonMarkdown(id: string): string {
    const p = join(this.lessonDir(id), "lesson.md");
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  }

  caseHints(id: string): CaseHintsFile {
    const manifest = this.manifest(id);
    const p = join(this.lessonDir(id), manifest.learner_input.case_hints);
    if (!existsSync(p)) return { hints: [] };
    return parseYaml(readFileSync(p, "utf8")) as CaseHintsFile;
  }

  systemPrompt(id: string): string {
    const manifest = this.manifest(id);
    const key = manifest.assets["system_prompt"];
    if (!key) return "";
    // 资产路径相对课程包目录解析；缺失时回退空串（修订包 blob 仍是真相源）
    const p = join(this.lessonDir(id), key);
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  }

  /** 状态图定义（profile=graph 课程；供 API 注入 manifest.runtime.graph 供前端渲染真实拓扑） */
  graphDefinition(id: string): unknown | undefined {
    const manifest = this.manifest(id);
    if (manifest.runtime.profile !== "graph" || !manifest.runtime.graph_file) return undefined;
    const p = join(this.lessonDir(id), manifest.runtime.graph_file);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, "utf8")) as unknown;
  }

  dataset(id: string, key: string): { name: string; content: string } | undefined {
    const manifest = this.manifest(id);
    const rel = manifest.assets[key];
    if (!rel) return undefined;
    const p = join(this.lessonDir(id), rel);
    if (!existsSync(p) || statSync(p).isDirectory()) return undefined;
    return { name: rel, content: readFileSync(p, "utf8") };
  }

  allDatasets(id: string): Array<{ key: string; name: string; content: string }> {
    const manifest = this.manifest(id);
    const out: Array<{ key: string; name: string; content: string }> = [];
    for (const [key, rel] of Object.entries(manifest.assets)) {
      if (key === "system_prompt" || key.startsWith("skill_")) continue;
      const p = join(this.lessonDir(id), rel);
      if (!existsSync(p) || statSync(p).isDirectory()) continue;
      out.push({ key, name: rel, content: readFileSync(p, "utf8") });
    }
    return out;
  }

  /** 服务端编辑策略（含摘要）；学习者只能读取，不能通过提交修改 */
  editPolicy(id: string): LessonEditPolicy | undefined {
    const manifest = this.manifest(id);
    if (!manifest.editing) return undefined;
    const p = join(this.lessonDir(id), manifest.editing.policy);
    if (!existsSync(p)) return undefined;
    const raw = parseYaml(readFileSync(p, "utf8")) as {
      id: string;
      regions: Array<{
        path: string;
        kind: "whole_file" | "function_body";
        symbol?: string;
        maxBytes: number;
      }>;
      allowed_imports?: string[];
      fixed_contract_digest: string;
      max_changed_files: number;
      max_patch_bytes: number;
    };
    const policy: LessonEditPolicy = {
      id: raw.id,
      digest: "",
      lessonVersion: `${id}@${manifest.revision}`,
      runtimeId: manifest.runtime.adapter,
      regions: raw.regions.map((r) =>
        r.kind === "function_body"
          ? { path: r.path, kind: "function_body" as const, symbol: r.symbol!, maxBytes: r.maxBytes }
          : { path: r.path, kind: "whole_file" as const, maxBytes: r.maxBytes },
      ),
      allowedImports: raw.allowed_imports ?? [],
      fixedContractDigest: raw.fixed_contract_digest,
      maxChangedFiles: raw.max_changed_files,
      maxPatchBytes: raw.max_patch_bytes,
      toolchainDigest: "toolchain",
      safetyTestSuiteDigest: "suite",
      isolationProfileId: "lesson-pure-policy",
    };
    policy.digest = sha256Text(JSON.stringify({ ...policy, digest: "" }));
    return policy;
  }

  /** 开放代码基线文件（path → content） */
  baselineFiles(id: string): Record<string, string> {
    const manifest = this.manifest(id);
    const files: Record<string, string> = {};
    // 开放区域由 edit-policy 驱动（含 prompt 等非代码文件），不依赖 lesson-agent 目录存在
    const regions = this.editPolicy(id)?.regions ?? [];
    for (const region of regions) {
      const p = join(this.lessonDir(id), region.path);
      if (existsSync(p)) {
        files[region.path] = readFileSync(p, "utf8");
      }
    }
    void manifest;
    return files;
  }

  graderSource(id: string): string | undefined {
    const manifest = this.manifest(id);
    if (!manifest.grader) return undefined;
    const p = join(this.lessonDir(id), manifest.grader.entrypoint);
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  }

  private loadManifest(id: string): LessonManifest | undefined {
    const p = join(this.lessonsDir, id, "manifest.yaml");
    // id 可能已是解析后的目录名
    if (!existsSync(p)) return undefined;
    const raw = parseYaml(readFileSync(p, "utf8")) as LessonManifest;
    return raw;
  }

  private lessonDirNames(): string[] {
    try {
      return readdirSync(this.lessonsDir).filter((n) => {
        try {
          return statSync(join(this.lessonsDir, n)).isDirectory() && /^L\d+/.test(n);
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }
}
