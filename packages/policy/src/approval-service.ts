/**
 * T20：具体效果审批服务。
 * 审批绑定：谁、哪个 run、哪个工具版本、哪些参数摘要、哪个策略版本、哪个目标、有效期。
 * 任一要素变化 → 失效（复用 packages/policy/src/approval.ts 的绑定摘要）。
 * 依据设计文档 v1.1 §13.4、验收 A07；测试规格用例 3。
 */
import { randomUUID } from "node:crypto";
import type { Database } from "@agentglass/db";
import { nowIso } from "@agentglass/db";
import { bindApproval, type RequestedEffect } from "./approval";

export interface ApprovalRequestRow {
  id: string;
  runId: string;
  actorId: string;
  toolRevision: string;
  argsDigest: string;
  argsSummary: string;
  policyRevision: string;
  target: string;
  expiresAt: string;
  state: "pending" | "granted" | "rejected" | "invalidated";
  decidedBy: string | null;
  decidedAt: string | null;
}

export class ApprovalService {
  constructor(private readonly db: Database) {}

  /**
   * 发起审批：为一次具体能力申请（工具+参数+目标）创建 pending 记录。
   * 返回供 UI 展示的参数摘要（不包含未脱敏大文本）。
   */
  request(spec: {
    runId: string;
    actorId: string;
    toolRevision: string;
    args: Record<string, unknown>;
    policyRevision: string;
    target: string;
    ttlMs?: number;
  }): ApprovalRequestRow {
    const expiresAt = new Date(Date.now() + (spec.ttlMs ?? 10 * 60_000)).toISOString();
    const bound = bindApproval({
      actorId: spec.actorId,
      runId: spec.runId,
      toolRevision: spec.toolRevision,
      args: spec.args,
      policyRevision: spec.policyRevision,
      target: spec.target,
      expiresAt,
    });
    const id = `apr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.db
      .prepare(
        `INSERT INTO approval_requests (id, run_id, actor_id, tool_revision, args_digest, args_summary, policy_revision, target, expires_at, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        spec.runId,
        spec.actorId,
        spec.toolRevision,
        bound.argsDigest,
        stableSummary(spec.args),
        spec.policyRevision,
        spec.target,
        expiresAt,
        nowIso(),
      );
    return this.get(id)!;
  }

  get(id: string): ApprovalRequestRow | undefined {
    const r = this.db.prepare("SELECT * FROM approval_requests WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return undefined;
    return {
      id: String(r.id),
      runId: String(r.run_id),
      actorId: String(r.actor_id),
      toolRevision: String(r.tool_revision),
      argsDigest: String(r.args_digest),
      argsSummary: String(r.args_summary),
      policyRevision: String(r.policy_revision),
      target: String(r.target),
      expiresAt: String(r.expires_at),
      state: r.state as ApprovalRequestRow["state"],
      decidedBy: (r.decided_by as string | null) ?? null,
      decidedAt: (r.decided_at as string | null) ?? null,
    };
  }

  pendingForRun(runId: string): ApprovalRequestRow | undefined {
    const r = this.db
      .prepare(
        "SELECT id FROM approval_requests WHERE run_id = ? AND state = 'pending' ORDER BY created_at DESC LIMIT 1",
      )
      .get(runId) as { id: string } | undefined;
    return r ? this.get(r.id) : undefined;
  }

  /** 决策（批准/拒绝）。幂等保护：已决策的请求不可二次决策。 */
  decide(id: string, decision: "grant" | "reject", decidedBy: string): ApprovalRequestRow {
    const row = this.get(id);
    if (!row) throw new Error(`APPROVAL_NOT_FOUND: ${id}`);
    if (row.state !== "pending") {
      throw new Error(`APPROVAL_ALREADY_DECIDED: ${id} 当前状态 ${row.state}`);
    }
    this.db
      .prepare(
        "UPDATE approval_requests SET state = ?, decided_by = ?, decided_at = ? WHERE id = ? AND state = 'pending'",
      )
      .run(decision === "grant" ? "granted" : "rejected", decidedBy, nowIso(), id);
    return this.get(id)!;
  }

  /**
   * 派发前核验：把"当前要执行的效果"与批准时的绑定逐项比对。
   * 参数摘要（digest）、目标、工具版本、run、用户、策略任一变化或过期 → invalid。
   */
  verifyForDispatch(
    approvalId: string,
    requested: RequestedEffect,
    now: string,
  ): { valid: boolean; reason?: string } {
    const row = this.get(approvalId);
    if (!row) return { valid: false, reason: "APPROVAL_NOT_FOUND" };
    if (row.state === "pending") return { valid: false, reason: "APPROVAL_PENDING" };
    if (row.state === "rejected") return { valid: false, reason: "APPROVAL_REJECTED" };
    if (row.state === "invalidated") return { valid: false, reason: "APPROVAL_INVALIDATED" };
    if (new Date(row.expiresAt).getTime() <= new Date(now).getTime()) {
      return { valid: false, reason: "APPROVAL_EXPIRED" };
    }
    const rebound = bindApproval({
      actorId: requested.actorId,
      runId: requested.runId,
      toolRevision: requested.toolRevision,
      args: requested.args,
      policyRevision: requested.policyRevision,
      target: requested.target,
      expiresAt: row.expiresAt,
    });
    if (rebound.argsDigest !== row.argsDigest) {
      return { valid: false, reason: "APPROVAL_ARGS_CHANGED" };
    }
    const metaOk =
      row.actorId === requested.actorId &&
      row.runId === requested.runId &&
      row.toolRevision === requested.toolRevision &&
      row.policyRevision === requested.policyRevision &&
      row.target === requested.target;
    if (!metaOk) return { valid: false, reason: "APPROVAL_META_MISMATCH" };
    return { valid: true };
  }

  /** 显式失效（例如目标路径或策略版本变化后由平台调用）。 */
  invalidate(runId: string, reason?: string): number {
    void reason;
    const r = this.db
      .prepare(
        "UPDATE approval_requests SET state = 'invalidated' WHERE run_id = ? AND state IN ('pending','granted')",
      )
      .run(runId);
    return Number(r.changes);
  }

  listPending(): ApprovalRequestRow[] {
    const rows = this.db
      .prepare("SELECT id FROM approval_requests WHERE state = 'pending' ORDER BY created_at ASC")
      .all() as Array<{ id: string }>;
    return rows.map((r) => this.get(r.id)!);
  }
}

/** 参数摘要（UI 展示 + 日志安全）：小字段明文，长文本截断。核验使用 argsDigest（不可逆）。 */
function stableSummary(args: Record<string, unknown>): string {
  const entries = Object.entries(args).map(([k, v]) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return `${k}=${s.length > 80 ? s.slice(0, 80) + "…" : s}`;
  });
  return entries.join("; ").slice(0, 400);
}
