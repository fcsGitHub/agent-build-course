/**
 * 用例 9（§25.4）：即使绕过前端，保护文件仍不可改。
 * 覆盖：保护文件、签名修改、导入追加、路径穿越、额外文件、区域外修改、禁用构造。
 */
import { describe, expect, it } from "vitest";
import type { LessonEditPolicy } from "@agentglass/contracts";
import { guardPatch, extractFunction, fixedContractDigest } from "@agentglass/code-lab";

function makePolicy(overrides: Partial<LessonEditPolicy> = {}): LessonEditPolicy {
  return {
    id: "L05-edit",
    digest: "a".repeat(64),
    lessonVersion: "L05@1.1.0",
    runtimeId: "reference",
    regions: [
      {
        path: "lesson-agent/loop-policy.ts",
        kind: "function_body",
        symbol: "shouldContinue",
        maxBytes: 4096,
      },
    ],
    allowedImports: [],
    fixedContractDigest: "b".repeat(64),
    maxChangedFiles: 2,
    maxPatchBytes: 8192,
    toolchainDigest: "c".repeat(64),
    safetyTestSuiteDigest: "d".repeat(64),
    isolationProfileId: "lesson-pure-policy",
    ...overrides,
  };
}

const baseFiles = {
  "lesson-agent/loop-policy.ts":
    "export function shouldContinue(n: number): boolean { return n < 3; }",
  "platform/policy.ts": "export const hardMaxTurns = 6;",
};

describe("patch-guard（用例 9）", () => {
  it("保护文件不能通过直接请求修改", () => {
    const candidateFiles = {
      ...baseFiles,
      "platform/policy.ts": "export const hardMaxTurns = Infinity;",
    };
    const result = guardPatch({ baseFiles, candidateFiles, policy: makePolicy() });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("EDIT_OUTSIDE_ALLOWED_SCOPE: platform/policy.ts");
  });

  it("开放函数体内的修改被接受", () => {
    const candidateFiles = {
      ...baseFiles,
      "lesson-agent/loop-policy.ts":
        "export function shouldContinue(n: number): boolean { return n < 5; }",
    };
    const result = guardPatch({ baseFiles, candidateFiles, policy: makePolicy() });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("修改导出签名被拒绝", () => {
    const candidateFiles = {
      ...baseFiles,
      "lesson-agent/loop-policy.ts":
        "export function shouldContinue(n: number, extra: boolean): boolean { return n < 5; }",
    };
    const result = guardPatch({ baseFiles, candidateFiles, policy: makePolicy() });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("SIGNATURE_CHANGED");
  });

  it("函数体之外的任何改动（哪怕一个字符）都被拒绝", () => {
    const candidateFiles = {
      ...baseFiles,
      "lesson-agent/loop-policy.ts":
        "export function shouldContinue(n: number): boolean { return n < 3; } // trailing",
    };
    const result = guardPatch({ baseFiles, candidateFiles, policy: makePolicy() });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("REGION_BODY_MISMATCH");
  });

  it("符号被删除被拒绝", () => {
    const candidateFiles = {
      ...baseFiles,
      "lesson-agent/loop-policy.ts": "export const somethingElse = 1;",
    };
    const result = guardPatch({ baseFiles, candidateFiles, policy: makePolicy() });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/SYMBOL_MISSING/);
  });

  it("路径穿越、绝对路径、反斜杠路径被拒绝", () => {
    for (const p of ["../evil.ts", "/abs/evil.ts", "a\\b.ts", "a/../../b.ts"]) {
      const result = guardPatch({
        baseFiles,
        candidateFiles: { ...baseFiles, [p]: "x" },
        policy: makePolicy(),
      });
      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toContain("PATH_ESCAPE");
    }
  });

  it("新增文件被拒绝", () => {
    const result = guardPatch({
      baseFiles,
      candidateFiles: { ...baseFiles, "lesson-agent/extra.ts": "export const x = 1;" },
      policy: makePolicy(),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("EXTRA_FILE");
  });

  it("删除文件被拒绝", () => {
    const { "platform/policy.ts": _drop, ...onlyLesson } = baseFiles;
    void _drop;
    const result = guardPatch({ baseFiles, candidateFiles: onlyLesson, policy: makePolicy() });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("FILE_DELETED");
  });

  it("追加 import 被拒绝", () => {
    const candidateFiles = {
      ...baseFiles,
      "lesson-agent/loop-policy.ts":
        "import { readFileSync } from \"node:fs\";\nexport function shouldContinue(n: number): boolean { return n < 5; }",
    };
    const result = guardPatch({ baseFiles, candidateFiles, policy: makePolicy() });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/DISALLOWED_IMPORT|REGION_BODY_MISMATCH/);
  });

  it("函数体内使用禁用构造（eval/require/process）被拒绝", () => {
    for (const body of [
      "export function shouldContinue(n: number): boolean { return eval(\"true\"); }",
      "export function shouldContinue(n: number): boolean { process.exit(0); return false; }",
    ]) {
      const result = guardPatch({
        baseFiles,
        candidateFiles: { ...baseFiles, "lesson-agent/loop-policy.ts": body },
        policy: makePolicy(),
      });
      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toMatch(/FORBIDDEN_CONSTRUCT|REGION_BODY_MISMATCH/);
    }
  });

  it("无变更时通过", () => {
    const result = guardPatch({ baseFiles, candidateFiles: { ...baseFiles }, policy: makePolicy() });
    expect(result.ok).toBe(true);
  });
});

describe("AST 辅助", () => {
  it("extractFunction 找到具名函数并返回函数体范围", () => {
    const src = baseFiles["lesson-agent/loop-policy.ts"]!;
    const fn = extractFunction(src, "shouldContinue");
    expect(fn).not.toBeNull();
    expect(fn!.bodyRange.text).toBe("{ return n < 3; }");
  });

  it("fixedContractDigest 对签名变化敏感、对函数体变化不敏感", () => {
    const a = "export function f(x: number): boolean { return true; }\ninterface P { a: number }";
    const b = "export function f(x: number): boolean { return false; }\ninterface P { a: number }";
    const c = "export function f(x: string): boolean { return true; }\ninterface P { a: number }";
    expect(fixedContractDigest(a)).toBe(fixedContractDigest(b));
    expect(fixedContractDigest(a)).not.toBe(fixedContractDigest(c));
  });
});
