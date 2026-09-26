/**
 * T20 审批安全测试（用例 3 + A07）。
 * 绑定失效矩阵 + 服务层状态机 + 未批准不得派发。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { openDatabase, type Database } from "@agentglass/db";
import { ApprovalService } from "@agentglass/policy";

let db: Database;
let svc: ApprovalService;

beforeEach(() => {
  db = openDatabase({ file: ":memory:" });
  svc = new ApprovalService(db);
});

const base = {
  runId: "run-a",
  actorId: "learner-a",
  toolRevision: "write_file@1.0.0",
  args: { path: "outputs/report.md", content: "draft" },
  policyRevision: "course-policy@1",
  target: "workspace:write_file",
};

describe("审批绑定矩阵（用例 3）", () => {
  it("批准后按原参数派发有效；参数变化失效", () => {
    const row = svc.request({ ...base, ttlMs: 60_000 });
    const granted = svc.decide(row.id, "grant", "instructor");
    expect(granted.state).toBe("granted");
    const ok = svc.verifyForDispatch(row.id, { ...base }, new Date().toISOString());
    expect(ok.valid).toBe(true);
    const changed = svc.verifyForDispatch(
      row.id,
      { ...base, args: { path: "private/key.txt", content: "draft" } },
      new Date().toISOString(),
    );
    expect(changed.valid).toBe(false);
    expect(changed.reason).toBe("APPROVAL_ARGS_CHANGED");
  });

  it("目标、工具版本、run、用户、策略任一变化都失效", () => {
    const row = svc.request({ ...base, ttlMs: 60_000 });
    svc.decide(row.id, "grant", "instructor");
    const now = new Date().toISOString();
    expect(svc.verifyForDispatch(row.id, { ...base, target: "workspace:other" }, now).reason).toBe("APPROVAL_META_MISMATCH");
    expect(svc.verifyForDispatch(row.id, { ...base, toolRevision: "write_file@2.0.0" }, now).reason).toBe("APPROVAL_META_MISMATCH");
    expect(svc.verifyForDispatch(row.id, { ...base, runId: "run-b" }, now).reason).toBe("APPROVAL_META_MISMATCH");
    expect(svc.verifyForDispatch(row.id, { ...base, actorId: "learner-b" }, now).reason).toBe("APPROVAL_META_MISMATCH");
    expect(svc.verifyForDispatch(row.id, { ...base, policyRevision: "course-policy@2" }, now).reason).toBe("APPROVAL_META_MISMATCH");
  });

  it("过期审批失效", () => {
    const row = svc.request({ ...base, ttlMs: -1 });
    svc.decide(row.id, "grant", "instructor");
    const r = svc.verifyForDispatch(row.id, { ...base }, new Date(Date.now() + 1000).toISOString());
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("APPROVAL_EXPIRED");
  });

  it("未决策（pending）与拒绝状态都不得派发", () => {
    const row = svc.request({ ...base, ttlMs: 60_000 });
    expect(svc.verifyForDispatch(row.id, { ...base }, new Date().toISOString()).reason).toBe("APPROVAL_PENDING");
    svc.decide(row.id, "reject", "instructor");
    expect(svc.verifyForDispatch(row.id, { ...base }, new Date().toISOString()).reason).toBe("APPROVAL_REJECTED");
  });

  it("决策幂等：二次决策返回 409 语义错误", () => {
    const row = svc.request({ ...base, ttlMs: 60_000 });
    svc.decide(row.id, "grant", "instructor");
    expect(() => svc.decide(row.id, "grant", "instructor")).toThrow(/APPROVAL_ALREADY_DECIDED/);
  });

  it("显式失效：granted 也能被平台撤销", () => {
    const row = svc.request({ ...base, ttlMs: 60_000 });
    svc.decide(row.id, "grant", "instructor");
    svc.invalidate(base.runId, "policy changed");
    expect(svc.verifyForDispatch(row.id, { ...base }, new Date().toISOString()).reason).toBe("APPROVAL_INVALIDATED");
  });
});
