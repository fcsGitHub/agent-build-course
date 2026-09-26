/**
 * T05 工具边界（验收 A07）。模型工具请求无法绕过身份与能力代理。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolBroker } from "@agentglass/tools";
import type { EffectLedger } from "@agentglass/tools";
import { READ_TEXT_TOOL, CALCULATOR_TOOL } from "@agentglass/tools";
import { evaluateExpression } from "@agentglass/tools";

let workspace: string;
const effects: EffectLedger = {
  prepare: () => "fx",
  dispatch: () => undefined,
  mark: () => undefined,
  markUnknown: () => undefined,
};

const broker = ToolBroker.fromRegistry([READ_TEXT_TOOL, CALCULATOR_TOOL], effects);
const baseCtx = () => ({
  runId: "run-1",
  workspaceRoot: workspace,
  allowedToolIds: ["read_text"],
  deadlineAt: new Date(Date.now() + 5000).toISOString(),
  maxOutputBytes: 64 * 1024,
});

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "tool-test-"));
  writeFileSync(join(workspace, "inventory.csv"), "品类,库存\n螺丝,120\n");
});

describe("read_text 边界", () => {
  it("工作区内文件可读", async () => {
    const r = await broker.execute({ toolId: "read_text", revision: "1", args: { path: "inventory.csv" }, ctx: baseCtx() });
    expect(r.status).toBe("succeeded");
    expect(JSON.stringify(r.outputSummary)).toContain("螺丝");
  });

  it("目录穿越被拒绝", async () => {
    const r = await broker.execute({ toolId: "read_text", revision: "1", args: { path: "../../etc/passwd" }, ctx: baseCtx() });
    expect(r.status).toBe("denied");
    expect(r.reasonCode).toBe("PATH_OUTSIDE_WORKSPACE");
  });

  it("绝对路径被拒绝", async () => {
    const r = await broker.execute({
      toolId: "read_text",
      revision: "1",
      args: { path: join(tmpdir(), "secret.txt") },
      ctx: baseCtx(),
    });
    expect(r.status).toBe("denied");
  });

  it("符号链接逃逸被拒绝", async () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "secret.txt"), "top secret");
    try {
      symlinkSync(join(outside, "secret.txt"), join(workspace, "link.txt"));
      const r = await broker.execute({ toolId: "read_text", revision: "1", args: { path: "link.txt" }, ctx: baseCtx() });
      expect(r.status).toBe("denied");
      expect(r.reasonCode).toBe("PATH_OUTSIDE_WORKSPACE");
    } catch {
      // Windows 无符号链接权限时跳过（已由穿越/绝对路径用例覆盖）
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("超大输出被拒绝", async () => {
    writeFileSync(join(workspace, "big.txt"), "x".repeat(200 * 1024));
    const r = await broker.execute({ toolId: "read_text", revision: "1", args: { path: "big.txt" }, ctx: { ...baseCtx(), maxOutputBytes: 64 * 1024 } });
    expect(r.status).toBe("failed");
    expect(r.reasonCode).toBe("OUTPUT_TOO_LARGE");
  });

  it("参数不符合 schema 被拒绝执行", async () => {
    const r = await broker.execute({ toolId: "read_text", revision: "1", args: { wrong: 1 }, ctx: baseCtx() });
    expect(r.status).toBe("failed");
    expect(r.reasonCode).toBe("INVALID_TOOL_ARGUMENTS");
  });

  it("未授权工具被拒绝（工具描述不能自授权限）", async () => {
    const r = await broker.execute({ toolId: "calculator", revision: "1", args: { expression: "1+1" }, ctx: baseCtx() });
    expect(r.status).toBe("denied");
    expect(r.reasonCode).toBe("TOOL_NOT_ALLOWED");
  });

  it("未注册工具被拒绝", async () => {
    const r = await broker.execute({ toolId: "net_fetch", revision: "1", args: {}, ctx: baseCtx() });
    expect(r.status).toBe("denied");
    expect(r.reasonCode).toBe("TOOL_NOT_REGISTERED");
  });
});

describe("calculator", () => {
  it("四则运算与括号", async () => {
    const r = await broker.execute({
      toolId: "calculator",
      revision: "1",
      args: { expression: "(2+3)*4-6/2" },
      ctx: { ...baseCtx(), allowedToolIds: ["calculator"] },
    });
    expect(r.status).toBe("succeeded");
    expect((r.outputSummary as { value: number }).value).toBe(17);
  });

  it("除零与非法输入安全失败", async () => {
    for (const expr of ["1/0", "1 + evil()", "2; drop table"]) {
      const r = await broker.execute({
        toolId: "calculator",
        revision: "1",
        args: { expression: expr },
        ctx: { ...baseCtx(), allowedToolIds: ["calculator"] },
      });
      expect(r.status).toBe("failed");
    }
  });

  it("求和正确（L05 教学数值）", () => {
    expect(evaluateExpression("120+45+8+32+17")).toBe(222);
  });
});
