/**
 * T23 Harness hook 测试：固定阶段、执行顺序、超时、失败策略、mutating diff、长期任务状态。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Database } from "@agentglass/db";
import { BlobStore } from "@agentglass/events";
import {
  HookRegistry,
  toolAuditHook,
  teachingAnnotationHook,
  TaskProgressStore,
} from "@agentglass/harness";

let dataDir: string;
let db: Database;
let blobs: BlobStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ag-harness-"));
  db = openDatabase({ file: ":memory:" });
  blobs = new BlobStore(db, join(dataDir, "blobs"));
});

describe("HookRegistry（T23）", () => {
  it("按注册顺序执行同阶段 hooks（before_tool 观察型）", async () => {
    const registry = new HookRegistry();
    const order: string[] = [];
    registry.register(toolAuditHook.decl, async () => {
      order.push("audit");
      return toolAuditHook.impl({ runId: "r", stage: "before_tool", data: {} });
    });
    registry.register(
      { id: "second", stages: ["before_tool"], mutating: false, timeoutMs: 500, failurePolicy: "continue" },
      async () => {
        order.push("second");
        return {};
      },
    );
    await registry.runStage("before_tool", { runId: "r", stage: "before_tool", data: {} });
    expect(order).toEqual(["audit", "second"]);
  });

  it("mutating hook 产生修改与 diff 摘要（after_model 教学标注）", async () => {
    const registry = new HookRegistry();
    registry.register(teachingAnnotationHook.decl, teachingAnnotationHook.impl);
    const { data, diffs } = await registry.runStage("after_model", {
      runId: "r",
      stage: "after_model",
      data: { messageText: "模型回答" },
    });
    expect(String(data.messageText)).toContain("教学标注");
    expect(diffs[0]!.hookId).toBe("builtin.teaching-annotation");
    expect(diffs[0]!.diff).toContain("messageText");
  });

  it("hook 超时按声明截断（continue 策略不阻断）", async () => {
    const registry = new HookRegistry();
    registry.register(
      {
        id: "slow",
        stages: ["before_model"],
        mutating: false,
        timeoutMs: 50,
        failurePolicy: "continue",
      },
      () => new Promise(() => undefined), // 永不完成
    );
    const { failures } = await registry.runStage("before_model", {
      runId: "r",
      stage: "before_model",
      data: {},
    });
    expect(failures[0]!.error).toContain("HOOK_TIMEOUT");
  });

  it("failurePolicy=fail 的 hook 抛错终止（安全 hook 不可静默跳过）", async () => {
    const registry = new HookRegistry();
    registry.register(
      {
        id: "critical",
        stages: ["before_checkpoint"],
        mutating: false,
        timeoutMs: 500,
        failurePolicy: "fail",
      },
      () => {
        throw new Error("审计写入失败");
      },
    );
    await expect(
      registry.runStage("before_checkpoint", { runId: "r", stage: "before_checkpoint", data: {} }),
    ).rejects.toThrow(/HOOK_FAILED.*审计写入失败/);
  });

  it("重复注册被拒绝", () => {
    const registry = new HookRegistry();
    registry.register(toolAuditHook.decl, toolAuditHook.impl);
    expect(() => registry.register(toolAuditHook.decl, toolAuditHook.impl)).toThrow(/ALREADY_REGISTERED/);
  });
});

describe("TaskProgressStore（T23 长期任务状态）", () => {
  it("进展工件写入 blob 并可重建；done 计数正确", () => {
    const store = new TaskProgressStore(db, blobs);
    const { progressRef, done, total } = store.update("run-p", [
      { id: "s1", title: "检索", status: "done" },
      { id: "s2", title: "核对", status: "done" },
      { id: "s3", title: "写入", status: "pending" },
    ]);
    expect(total).toBe(3);
    expect(done).toBe(2);
    const progress = store.load(progressRef);
    expect(progress.steps[0]!.status).toBe("done");
    expect(progress.updatedAt).toBeTruthy();
    store.record("run-p", progressRef); // 长期记录行不抛错
  });
});
