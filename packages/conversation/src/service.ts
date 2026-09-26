/**
 * 实时输入与会话队列（T37）。
 * 合同（设计文档 v1.1 第 6.6/19.6 节）：
 * - 打开会话/课程不产生消息，不调用模型；
 * - 用户明确提交才创建 InputSubmission；
 * - (session_id, client_message_id) 幂等：同键同文返回既有记录，同键异文返回冲突；
 * - 排队输入可撤回/替换；已接纳（accepted）不可改写历史；
 * - 普通输入只在前一 run 到达终态后接纳，冻结会话前缀。
 */
import { createHash } from "node:crypto";
import type { Database } from "@agentglass/db";
import { newId, nowIso } from "@agentglass/db";
import type { BlobStore } from "@agentglass/events";
import type { BudgetLimit, InputOrigin } from "@agentglass/contracts";
import { USER_CONFIRMED_ORIGINS } from "@agentglass/contracts";

export interface SessionConfig {
  lessonId: string;
  lessonRevision: string;
  agentRevisionId: string;
  modelProfileSnapshotId: string;
  runtimeSnapshotId: string;
  assetSnapshotId: string;
  policySnapshotId: string;
  budget: BudgetLimit;
}

export interface SubmitInputArgs {
  sessionId: string;
  clientMessageId: string;
  text: string;
  origin: InputOrigin;
  caseHintId?: string;
  caseHintRevision?: string;
  /** 提交时的用户配置选择（冻结进 InputSubmission） */
  agentRevisionId?: string;
  /** 提交时携带的断点目标；运行创建事务内播种进 run_breakpoints（首运行无继承来源时唯一可靠通道） */
  breakpoints?: string[];
}

export interface InputRecord {
  id: string;
  sessionId: string;
  clientMessageId: string;
  origin: InputOrigin;
  status: "queued" | "accepted" | "cancelled" | "replaced";
  contentPreview: string;
  acceptedRunId: string | null;
  submittedAt: string;
  caseHintId: string | null;
}

export class InputConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputConflictError";
  }
}

export class SessionService {
  constructor(
    private readonly db: Database,
    private readonly blobs: BlobStore,
  ) {}

  createSession(ownerId: string, projectId: string, config: SessionConfig): string {
    const id = newId("sess");
    this.db
      .prepare(
        `INSERT INTO sessions (id, owner_id, project_id, lesson_id, lesson_revision, agent_revision_id,
          model_profile_snapshot_id, runtime_snapshot_id, asset_snapshot_id, policy_snapshot_id, budget,
          status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(
        id,
        ownerId,
        projectId,
        config.lessonId,
        config.lessonRevision,
        config.agentRevisionId,
        config.modelProfileSnapshotId,
        config.runtimeSnapshotId,
        config.assetSnapshotId,
        config.policySnapshotId,
        JSON.stringify(config.budget),
        nowIso(),
        nowIso(),
      );
    return id;
  }

  getSession(sessionId: string) {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
      | Record<string, unknown>
      | undefined;
  }

  /**
   * 用户明确提交。打开课程/插入案例/保存代码都不调用本方法。
   * 自动作业来源（batch_eval 等）只能由对应服务入口创建并标注 origin。
   */
  submitInput(args: SubmitInputArgs): { submission: InputRecord; duplicate: boolean } {
    if (!USER_CONFIRMED_ORIGINS.includes(args.origin)) {
      throw new InputConflictError(
        `来源 ${args.origin} 不是用户确认提交；自动作业必须使用各自授权入口`,
      );
    }
    const session = this.getSession(args.sessionId);
    if (!session) throw new InputConflictError(`会话不存在: ${args.sessionId}`);
    const contentSha = createHash("sha256").update(args.text, "utf8").digest("hex");

    // 幂等：同键查询
    const existing = this.db
      .prepare("SELECT * FROM input_submissions WHERE session_id = ? AND client_message_id = ?")
      .get(args.sessionId, args.clientMessageId) as Record<string, unknown> | undefined;
    if (existing) {
      if (existing.content_sha256 === contentSha) {
        return { submission: rowToInput(existing), duplicate: true };
      }
      throw new InputConflictError("SAME_KEY_DIFFERENT_CONTENT: 同一 clientMessageId 携带了不同正文");
    }

    const id = newId("in");
    const ref = this.blobs.putText(args.text, "text/plain; charset=utf-8");
    this.db
      .prepare(
        `INSERT INTO input_submissions (id, session_id, client_message_id, submitted_by, origin,
          submitted_at, user_confirmed_at, case_hint_id, case_hint_revision, content_sha256, content_ref,
          attachment_refs, lesson_version, agent_revision_id, runtime_snapshot_id,
          model_profile_snapshot_id, asset_snapshot_id, policy_snapshot_id, budget,
          status, content_preview, breakpoints)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        id,
        args.sessionId,
        args.clientMessageId,
        "local-learner",
        args.origin,
        nowIso(),
        nowIso(),
        args.caseHintId ?? null,
        args.caseHintRevision ?? null,
        contentSha,
        ref.id,
        String(session.lesson_revision),
        args.agentRevisionId ?? String(session.agent_revision_id),
        String(session.runtime_snapshot_id),
        String(session.model_profile_snapshot_id),
        String(session.asset_snapshot_id),
        String(session.policy_snapshot_id),
        String(session.budget),
        args.text.slice(0, 200),
        JSON.stringify(args.breakpoints ?? []),
      );
    return {
      submission: rowToInput(
        this.db.prepare("SELECT * FROM input_submissions WHERE id = ?").get(id) as Record<string, unknown>,
      ),
      duplicate: false,
    };
  }

  /** 只撤回尚未接纳的输入 */
  cancelInput(sessionId: string, inputId: string): boolean {
    const row = this.db
      .prepare("SELECT status FROM input_submissions WHERE id = ? AND session_id = ?")
      .get(inputId, sessionId) as { status: string } | undefined;
    if (!row) return false;
    if (row.status !== "queued") return false;
    this.db
      .prepare("UPDATE input_submissions SET status = 'cancelled' WHERE id = ?")
      .run(inputId);
    return true;
  }

  /** 原子替换排队输入：旧对象 replaced，新对象带新 ID */
  replaceInput(sessionId: string, oldInputId: string, args: SubmitInputArgs): InputRecord {
    const row = this.db
      .prepare("SELECT status FROM input_submissions WHERE id = ? AND session_id = ?")
      .get(oldInputId, sessionId) as { status: string } | undefined;
    if (!row || row.status !== "queued") {
      throw new InputConflictError("只能替换尚未接纳的排队输入");
    }
    const created = this.submitInput({ ...args, origin: "interactive" });
    this.db
      .prepare("UPDATE input_submissions SET status = 'replaced', replaces_submission_id = ? WHERE id = ?")
      .run(oldInputId, created.submission.id);
    return { ...created.submission };
  }

  listInputs(sessionId: string): InputRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM input_submissions WHERE session_id = ? ORDER BY submitted_at ASC")
      .all(sessionId) as Record<string, unknown>[];
    return rows.map(rowToInput);
  }

  /**
   * 接纳下一条排队输入（仅在会话无活动 run 时调用；返回 null 表示不可接纳）。
   * 接纳时冻结会话前缀（已接纳输入的正文序列）为 conversationSnapshotId。
   */
  acceptNextInput(sessionId: string): {
    input: InputRecord;
    conversationSnapshotId: string;
    content: string;
  } | null {
    return this.dbTransaction(() => {
      const active = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM runs WHERE session_id = ? AND state IN
           ('created','queued','running','pause_requested','awaiting_approval','cancel_requested','reconciliation_required')`,
        )
        .get(sessionId) as { n: number };
      if (active.n > 0) return null;
      const next = this.db
        .prepare(
          `SELECT * FROM input_submissions WHERE session_id = ? AND status = 'queued'
           ORDER BY submitted_at ASC LIMIT 1`,
        )
        .get(sessionId) as Record<string, unknown> | undefined;
      if (!next) return null;
      const content = this.blobs.getText(String(next.content_ref));
      // 冻结会话前缀：此前已接纳输入 + 本次输入
      const priorAccepted = this.db
        .prepare(
          `SELECT content_ref FROM input_submissions WHERE session_id = ? AND status = 'accepted'
           AND accepted_run_id IS NOT NULL ORDER BY submitted_at ASC`,
        )
        .all(sessionId) as Array<{ content_ref: string }>;
      const snapshotParts = priorAccepted.map((r) => this.blobs.getText(r.content_ref));
      snapshotParts.push(content);
      const snapshotRef = this.blobs.putJson({
        schemaVersion: 1,
        sessionId,
        parts: snapshotParts,
      });
      const runId = newId("run");
      this.db
        .prepare(
          `UPDATE input_submissions SET status = 'accepted', accepted_run_id = ? WHERE id = ?`,
        )
        .run(runId, String(next.id));
      return {
        input: { ...rowToInput(next), status: "accepted" as const, acceptedRunId: runId },
        conversationSnapshotId: snapshotRef.id,
        content,
      };
    });
  }

  private dbTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

function rowToInput(r: Record<string, unknown>): InputRecord {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    clientMessageId: String(r.client_message_id),
    origin: r.origin as InputOrigin,
    status: r.status as InputRecord["status"],
    contentPreview: String(r.content_preview ?? ""),
    acceptedRunId: (r.accepted_run_id as string | null) ?? null,
    submittedAt: String(r.submitted_at),
    caseHintId: (r.case_hint_id as string | null) ?? null,
  };
}
