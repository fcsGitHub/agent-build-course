/**
 * 用例 3/4（§25.2）：审批绑定失效与非幂等效果未知不自动重试。
 * 用例 5（§25.2）：上下文预算不能拆散工具事务消息。
 * 用例 6（§25.2）：子任务不能超额预留父预算。
 */
import { describe, expect, it } from "vitest";
import { bindApproval, isApprovalValid } from "@agentglass/policy";
import { decideRecovery } from "@agentglass/tools";
import { estimateTokens, selectWithinBudget } from "@agentglass/context";
import type { ContextItem } from "@agentglass/contracts";
import { openDatabase } from "@agentglass/db";
import { BudgetLedger } from "@agentglass/policy";

describe("审批绑定（用例 3）", () => {
  const request = {
    actorId: "learner-a",
    runId: "run-a",
    toolRevision: "write-file@1",
    args: { path: "outputs/report.md", content: "draft" },
    policyRevision: "course-policy@1",
    target: "workspace://outputs",
    expiresAt: "2030-01-01T00:00:00Z",
  };

  it("为一个路径批准的审批不能授权另一个路径", () => {
    const approval = bindApproval(request);
    const changed = { ...request, args: { ...request.args, path: "private/key.txt" } };
    expect(isApprovalValid(approval, changed, "2026-09-13T12:00:00Z")).toBe(false);
  });

  it("参数、目标、工具版本、run、用户、策略任一变化都使审批失效", () => {
    const approval = bindApproval(request);
    const now = "2026-09-13T12:00:00Z";
    expect(isApprovalValid(approval, { ...request }, now)).toBe(true);
    expect(isApprovalValid(approval, { ...request, toolRevision: "write-file@2" }, now)).toBe(false);
    expect(isApprovalValid(approval, { ...request, runId: "run-b" }, now)).toBe(false);
    expect(isApprovalValid(approval, { ...request, actorId: "learner-b" }, now)).toBe(false);
    expect(isApprovalValid(approval, { ...request, policyRevision: "course-policy@2" }, now)).toBe(false);
    expect(isApprovalValid(approval, { ...request, target: "workspace://other" }, now)).toBe(false);
  });

  it("过期审批失效", () => {
    const approval = bindApproval({ ...request, expiresAt: "2026-01-01T00:00:00Z" });
    expect(isApprovalValid(approval, request, "2026-09-13T12:00:00Z")).toBe(false);
  });
});

describe("效果恢复决策（用例 4）", () => {
  it("未知非幂等效果必须进入人工核对", () => {
    const decision = decideRecovery({
      state: "dispatched",
      idempotent: false,
      supportsStatusQuery: false,
    });
    expect(decision).toBe("manual_reconciliation");
  });

  it("幂等效果可重试；支持状态查询的先查询；未派发可安全重试", () => {
    expect(decideRecovery({ state: "dispatched", idempotent: true, supportsStatusQuery: false })).toBe("retry");
    expect(decideRecovery({ state: "dispatched", idempotent: false, supportsStatusQuery: true })).toBe("query_status");
    expect(decideRecovery({ state: "prepared", idempotent: false, supportsStatusQuery: false })).toBe("retry");
    expect(decideRecovery({ state: "succeeded", idempotent: false, supportsStatusQuery: false })).toBe("none");
  });
});

function item(partial: Partial<ContextItem> & { id: string; estimatedTokens: number }): ContextItem {
  return {
    kind: "message",
    sourceRef: { id: partial.id, sha256: partial.id, mediaType: "text/plain", bytes: 1 },
    originId: partial.id,
    originVersion: "1",
    trust: "user",
    priority: 10,
    selected: false,
    decision: "budget_excluded",
    transformedFromIds: [],
    ...partial,
  } as ContextItem;
}

describe("预算内选择（用例 5）", () => {
  it("工具请求与结果保持一个原子组", () => {
    const items = [
      item({ id: "call", estimatedTokens: 40, priority: 50, atomicGroupId: "tool-1" }),
      item({ id: "result", estimatedTokens: 80, priority: 50, atomicGroupId: "tool-1", kind: "tool_result" }),
      item({ id: "old-note", estimatedTokens: 30, priority: 10 }),
    ];
    const result = selectWithinBudget(items, {
      contextLimit: 90,
      outputReserveTokens: 0,
      safetyReserveTokens: 0,
    });
    const call = result.all.find((x) => x.id === "call");
    const observation = result.all.find((x) => x.id === "result");
    expect(call?.selected).toBe(observation?.selected);
    expect(call?.selected).toBe(false);
    expect(call?.decision).toBe("budget_excluded");
    expect(call?.decisionReason).toBeTruthy();
  });

  it("原子组整体选入时全部 selected", () => {
    const items = [
      item({ id: "call", estimatedTokens: 10, priority: 50, atomicGroupId: "tool-1" }),
      item({ id: "result", estimatedTokens: 20, priority: 50, atomicGroupId: "tool-1", kind: "tool_result" }),
    ];
    const result = selectWithinBudget(items, { contextLimit: 100, outputReserveTokens: 0, safetyReserveTokens: 0 });
    expect(result.selected.map((i) => i.id).sort()).toEqual(["call", "result"]);
  });

  it("预算扣掉输出预留与安全余量", () => {
    const items = [item({ id: "a", estimatedTokens: 60, priority: 100 })];
    const result = selectWithinBudget(items, { contextLimit: 100, outputReserveTokens: 30, safetyReserveTokens: 20 });
    expect(result.all.find((x) => x.id === "a")!.selected).toBe(false);
  });
});

describe("共享原子预算（用例 6）", () => {
  it("并发子任务共享一个原子上限", async () => {
    const db = openDatabase({ file: ":memory:" });
    const ledger = new BudgetLedger(db);
    const budgetId = ledger.open("run-shared", {
      ...{ maxTurns: 5, maxToolCalls: 5, maxInputTokens: 1000, maxOutputTokens: 1000, maxDepth: 1 },
      maxModelCalls: 1,
      maxWallTimeMs: 60_000,
      maxConcurrency: 2,
    });
    const reservations = await Promise.all([
      Promise.resolve().then(() => ledger.reserve(budgetId, "model_call", "child-a")),
      Promise.resolve().then(() => ledger.reserve(budgetId, "model_call", "child-b")),
    ]);
    expect(reservations.filter((x) => x.granted)).toHaveLength(1);
  });

  it("硬检查：预算耗尽后 hardCheck 返回 false", () => {
    const db = openDatabase({ file: ":memory:" });
    const ledger = new BudgetLedger(db);
    const budgetId = ledger.open("run-hard", {
      maxTurns: 1,
      maxModelCalls: 1,
      maxToolCalls: 1,
      maxWallTimeMs: 60_000,
      maxInputTokens: 1000,
      maxOutputTokens: 1000,
      maxDepth: 1,
      maxConcurrency: 1,
    });
    expect(ledger.reserve(budgetId, "turn", "loop").granted).toBe(true);
    ledger.settleUse(budgetId, "turn", 1);
    expect(ledger.hardCheck(budgetId, "turn")).toBe(false);
    expect(ledger.reserve(budgetId, "turn", "loop").granted).toBe(false);
  });
});

describe("token 估算", () => {
  it("CJK 密度高于拉丁文本（保守估计）", () => {
    const cjk = estimateTokens("库存统计");
    const latin = estimateTokens("stock");
    expect(cjk).toBeGreaterThan(latin);
  });
});
