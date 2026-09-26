/**
 * 用例 10（§25.4）：校验报告不能授权不同内容。
 * 加上 A17：学生代码忙等被外部 watchdog 终止。
 */
import { describe, expect, it } from "vitest";
import { matchesValidatedBuild } from "@agentglass/code-lab";
import type { BuildAttestation } from "@agentglass/code-lab";

const attested: BuildAttestation = {
  sourceDigest: "a".repeat(64),
  baseManifestId: "base-course-1",
  editPolicyDigest: "b".repeat(64),
  toolchainDigest: "c".repeat(64),
  testSuiteDigest: "d".repeat(64),
  bundleDigest: "e".repeat(64),
};

describe("revision 绑定（用例 10）", () => {
  it("完全一致的六元组才有效", () => {
    expect(matchesValidatedBuild(attested, attested)).toBe(true);
  });

  it("修改源码使既有构建证明失效", () => {
    expect(
      matchesValidatedBuild({ ...attested, sourceDigest: "f".repeat(64) }, attested),
    ).toBe(false);
  });

  it("任意一个维度替换都失效", () => {
    for (const key of Object.keys(attested) as Array<keyof BuildAttestation>) {
      const actual = { ...attested, [key]: "0".repeat(64) };
      expect(matchesValidatedBuild(actual, attested)).toBe(false);
    }
  });
});
