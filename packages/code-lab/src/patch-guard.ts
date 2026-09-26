/**
 * 服务端补丁范围检查（T38，验收 A16/A24；用例 9）。
 * 全部检查以服务端冻结基线为准：开放单位是登记的文件、固定符号与可编辑区域；
 * 未开放节点、导入集合、导出签名与保护内容必须保持不变。
 * 不依赖 Monaco 锁行、注释标记或客户端报告的行号。
 */
import ts from "typescript";
import type { EditRegion, LessonEditPolicy } from "@agentglass/contracts";
import { sha256 } from "@agentglass/source-map";

export interface GuardPatchInput {
  baseFiles: Record<string, string>;
  candidateFiles: Record<string, string>;
  policy: LessonEditPolicy;
}

export interface GuardPatchResult {
  ok: boolean;
  errors: string[];
}

export const EDIT_ERRORS = {
  PATH_ESCAPE: "PATH_ESCAPE",
  EXTRA_FILE: "EXTRA_FILE",
  FILE_DELETED: "FILE_DELETED",
  EDIT_OUTSIDE_ALLOWED_SCOPE: "EDIT_OUTSIDE_ALLOWED_SCOPE",
  SYMBOL_MISSING: "SYMBOL_MISSING",
  SIGNATURE_CHANGED: "SIGNATURE_CHANGED",
  REGION_BODY_MISMATCH: "REGION_BODY_MISMATCH",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  TOO_MANY_FILES: "TOO_MANY_FILES",
  PATCH_TOO_LARGE: "PATCH_TOO_LARGE",
  DISALLOWED_IMPORT: "DISALLOWED_IMPORT",
  FORBIDDEN_CONSTRUCT: "FORBIDDEN_CONSTRUCT",
  PARSE_ERROR: "PARSE_ERROR",
  BASELINE_MISMATCH: "BASELINE_MISMATCH",
} as const;

const FORBIDDEN_PATTERNS: Array<[RegExp, string]> = [
  [/\brequire\s*\(/, "require()"],
  [/\beval\s*\(/, "eval()"],
  [/\bnew\s+Function\b/, "new Function"],
  [/\bimport\s*\(/, "动态 import()"],
  [/\bprocess\b/, "process 全局"],
  [/\bglobalThis\b/, "globalThis"],
  [/\b__dirname\b|\b__filename\b/, "__dirname/__filename"],
];

export function guardPatch(input: GuardPatchInput): GuardPatchResult {
  const errors: string[] = [];
  const { baseFiles, candidateFiles, policy } = input;

  // 1) 路径规范化与穿越检查
  const normalize = (p: string): string | null => {
    if (p.includes("\\") || p.includes("..") || p.startsWith("/") || /^[a-zA-Z]:/.test(p)) {
      return null;
    }
    const parts = p.split("/").filter((s) => s.length > 0 && s !== ".");
    if (parts.length === 0) return null;
    return parts.join("/");
  };

  const basePaths = new Map<string, string>();
  for (const [p, content] of Object.entries(baseFiles)) {
    const n = normalize(p);
    if (!n) return { ok: false, errors: [`${EDIT_ERRORS.PATH_ESCAPE}: ${p}`] };
    basePaths.set(n, content);
  }
  const candPaths = new Map<string, string>();
  for (const [p, content] of Object.entries(candidateFiles)) {
    const n = normalize(p);
    if (!n) return { ok: false, errors: [`${EDIT_ERRORS.PATH_ESCAPE}: ${p}`] };
    candPaths.set(n, content);
  }
  for (const p of candPaths.keys()) {
    if (!basePaths.has(p)) errors.push(`${EDIT_ERRORS.EXTRA_FILE}: ${p}`);
  }
  for (const p of basePaths.keys()) {
    if (!candPaths.has(p)) errors.push(`${EDIT_ERRORS.FILE_DELETED}: ${p}`);
  }
  if (errors.length > 0) return { ok: false, errors };

  // 2) 变更文件集合
  const changed: string[] = [];
  for (const [p, content] of candPaths) {
    if (basePaths.get(p) !== content) changed.push(p);
  }
  if (changed.length === 0) return { ok: true, errors: [] };
  if (changed.length > policy.maxChangedFiles) {
    errors.push(`${EDIT_ERRORS.TOO_MANY_FILES}: ${changed.length} > ${policy.maxChangedFiles}`);
  }
  const patchBytes = changed.reduce((s, p) => {
    const size = Math.abs((candPaths.get(p) ?? "").length - (basePaths.get(p) ?? "").length);
    return s + Math.max(size, (candPaths.get(p) ?? "").length);
  }, 0);
  if (patchBytes > policy.maxPatchBytes) {
    errors.push(`${EDIT_ERRORS.PATCH_TOO_LARGE}: ${patchBytes} > ${policy.maxPatchBytes}`);
  }

  // 3) 逐文件区域检查
  for (const path of changed) {
    const regions = policy.regions.filter((r) => r.path === path);
    if (regions.length === 0) {
      errors.push(`${EDIT_ERRORS.EDIT_OUTSIDE_ALLOWED_SCOPE}: ${path}`);
      continue;
    }
    const base = basePaths.get(path)!;
    const cand = candPaths.get(path)!;
    for (const region of regions) {
      const r = checkRegion(base, cand, region, policy.allowedImports);
      errors.push(...r.map((e) => `${e}: ${path}${region.kind === "function_body" ? `#${region.symbol}` : ""}`));
    }
  }

  return { ok: errors.length === 0, errors };
}

function checkRegion(base: string, cand: string, region: EditRegion, allowedImports: string[]): string[] {
  if (region.kind === "whole_file") {
    if (cand.length > region.maxBytes) {
      return [`${EDIT_ERRORS.FILE_TOO_LARGE}: ${cand.length} > ${region.maxBytes}`];
    }
    return [];
  }
  // function_body：签名与函数体外的所有内容必须与基线一致
  const errors: string[] = [];
  const baseFn = extractFunction(base, region.symbol);
  const candFn = extractFunction(cand, region.symbol);
  if (!candFn) {
    return [`${EDIT_ERRORS.SYMBOL_MISSING}: ${region.symbol}`];
  }
  if (!baseFn) {
    return [`${EDIT_ERRORS.BASELINE_MISMATCH}: 基线中找不到 ${region.symbol}`];
  }
  // 签名（导出修饰 + 名称 + 参数 + 返回类型）必须一致
  if (baseFn.signatureText !== candFn.signatureText) {
    errors.push(EDIT_ERRORS.SIGNATURE_CHANGED);
  }
  // 重建：基线 + 候选函数体；必须与候选文件完全一致（保证其他内容零改动）
  const rebuilt = base.replace(baseFn.bodyRange.text, candFn.bodyRange.text);
  if (rebuilt !== cand) {
    errors.push(EDIT_ERRORS.REGION_BODY_MISMATCH);
  }
  if (candFn.bodyRange.text.length > region.maxBytes) {
    errors.push(`${EDIT_ERRORS.FILE_TOO_LARGE}: 函数体 ${candFn.bodyRange.text.length} > ${region.maxBytes}`);
  }
  // 导入集合必须一致且在白名单内
  const baseImports = collectImports(base);
  const candImports = collectImports(cand);
  if (baseImports !== candImports) {
    errors.push(`${EDIT_ERRORS.DISALLOWED_IMPORT}: 导入集合发生变化`);
  } else if (baseImports.length > 0) {
    for (const imp of baseImports.split("\n")) {
      if (imp.trim().length === 0) continue;
      const allowed = allowedImports.some((a) => imp.includes(a));
      if (!allowed) errors.push(`${EDIT_ERRORS.DISALLOWED_IMPORT}: ${imp.trim().slice(0, 80)}`);
    }
  }
  // 防御性扫描（真实隔离在客体执行层）
  for (const [re, label] of FORBIDDEN_PATTERNS) {
    if (re.test(candFn.bodyRange.text)) {
      errors.push(`${EDIT_ERRORS.FORBIDDEN_CONSTRUCT}: ${label}`);
    }
  }
  return errors;
}

interface ExtractedFunction {
  signatureText: string;
  bodyRange: { text: string; start: number; end: number };
}

/** 用 TS AST 提取具名函数（function 声明或 const 箭头函数） */
export function extractFunction(source: string, symbol: string): ExtractedFunction | null {
  const sf = ts.createSourceFile("patch.ts", source, ts.ScriptTarget.ES2022, true);
  let found: ExtractedFunction | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === symbol && node.body) {
      found = {
        signatureText: signatureOf(node, source),
        bodyRange: { text: node.body.getText(sf), start: node.body.getStart(sf), end: node.body.getEnd() },
      };
      return;
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === symbol && decl.initializer) {
          const arrow = decl.initializer;
          const body = ts.isArrowFunction(arrow)
            ? arrow.body
            : ts.isFunctionExpression(arrow)
              ? arrow.body
              : undefined;
          if (body) {
            found = {
              signatureText: `${source.slice(node.getStart(sf), decl.initializer.getStart(sf))}`,
              bodyRange: { text: body.getText(sf), start: body.getStart(sf), end: body.getEnd() },
            };
          }
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function signatureOf(fn: ts.FunctionDeclaration, source: string): string {
  const sf = fn.getSourceFile();
  const bodyStart = fn.body ? fn.body.getStart(sf) : fn.getEnd();
  return source.slice(fn.getStart(sf), bodyStart).replace(/\s+/g, " ").trim();
}

function collectImports(source: string): string {
  const sf = ts.createSourceFile("patch.ts", source, ts.ScriptTarget.ES2022, true);
  const lines: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) lines.push(stmt.getText(sf));
  }
  return lines.join("\n");
}

/** 固定合同摘要：导出签名的摘要（课程发布时计算；构建时复核） */
export function fixedContractDigest(source: string): string {
  const sf = ts.createSourceFile("contract.ts", source, ts.ScriptTarget.ES2022, true);
  const sigs: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      sigs.push(signatureOf(node, source));
    }
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      sigs.push(node.getText(sf).replace(/\s+/g, " ").trim());
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sha256(sigs.sort().join("\n"));
}
