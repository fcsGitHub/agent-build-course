/**
 * 个人草稿服务（T38）。从有权使用的课程/AgentRevision 创建工作副本；
 * 保存不触发模型、不触发执行；恢复默认生成新草稿，不覆盖课程与历史。
 */
import type { Database } from "@agentglass/db";
import { newId, nowIso } from "@agentglass/db";
import type { BlobStore } from "@agentglass/events";
import { sha256 } from "@agentglass/source-map";

export interface DraftRecord {
  id: string;
  ownerId: string;
  lessonId: string;
  lessonVersion: string;
  baseAgentRevisionId: string;
  revision: number;
  sourceDigest: string;
  files: Record<string, string>;
  updatedAt: string;
}

export class DraftConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftConflictError";
  }
}

export class AgentDraftService {
  constructor(
    private readonly db: Database,
    private readonly blobs: BlobStore,
  ) {}

  /** 从基线 revision 的源文件创建个人草稿 */
  createDraft(args: {
    ownerId: string;
    projectId: string;
    lessonId: string;
    lessonVersion: string;
    baseAgentRevisionId: string;
    baseFiles: Record<string, string>;
    editPolicyDigest: string;
  }): DraftRecord {
    const existing = this.db
      .prepare("SELECT id FROM agent_drafts WHERE owner_id = ? AND lesson_id = ?")
      .get(args.ownerId, args.lessonId) as { id: string } | undefined;
    if (existing) {
      return this.get(existing.id)!;
    }
    const id = newId("draft");
    const sourceDigest = digestFiles(args.baseFiles);
    this.db
      .prepare(
        `INSERT INTO agent_drafts (id, owner_id, project_id, lesson_id, lesson_version, base_agent_revision_id,
          edit_policy_digest, revision, source_digest, files, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        id,
        args.ownerId,
        args.projectId,
        args.lessonId,
        args.lessonVersion,
        args.baseAgentRevisionId,
        args.editPolicyDigest,
        sourceDigest,
        JSON.stringify(args.baseFiles),
        nowIso(),
        nowIso(),
      );
    return this.get(id)!;
  }

  get(draftId: string): DraftRecord | undefined {
    const row = this.db.prepare("SELECT * FROM agent_drafts WHERE id = ?").get(draftId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      lessonId: String(row.lesson_id),
      lessonVersion: String(row.lesson_version),
      baseAgentRevisionId: String(row.base_agent_revision_id),
      revision: Number(row.revision),
      sourceDigest: String(row.source_digest),
      files: JSON.parse(String(row.files)) as Record<string, string>,
      updatedAt: String(row.updated_at),
    };
  }

  /**
   * 保存：乐观并发（expectedRevision 与当前一致才接受）；
   * 保存只保存草稿（版本号+并发校验），不触发模型/构建/执行。
   */
  save(args: {
    draftId: string;
    expectedRevision: number;
    files: Record<string, string>;
    editPolicyDigest: string;
  }): DraftRecord {
    const current = this.get(args.draftId);
    if (!current) throw new DraftConflictError(`草稿不存在: ${args.draftId}`);
    if (current.revision !== args.expectedRevision) {
      throw new DraftConflictError(
        `REVISION_MISMATCH: 期望 ${args.expectedRevision}，当前 ${current.revision}（请刷新后重试）`,
      );
    }
    const sourceDigest = digestFiles(args.files);
    this.db
      .prepare(
        `UPDATE agent_drafts SET revision = revision + 1, source_digest = ?, files = ?, edit_policy_digest = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(
        sourceDigest,
        JSON.stringify(args.files),
        args.editPolicyDigest,
        nowIso(),
        args.draftId,
        args.expectedRevision,
      );
    const n = this.db
      .prepare("SELECT COUNT(*) AS n FROM agent_drafts WHERE id = ? AND revision = ?")
      .get(args.draftId, args.expectedRevision + 1) as { n: number };
    if (n.n !== 1) throw new DraftConflictError("并发保存冲突");
    return this.get(args.draftId)!;
  }

  /** 恢复默认：生成新草稿版本（不删除旧变体与历史） */
  resetToBaseline(draftId: string, baselineFiles: Record<string, string>): DraftRecord {
    const current = this.get(draftId);
    if (!current) throw new DraftConflictError(`草稿不存在: ${draftId}`);
    return this.save({
      draftId,
      expectedRevision: current.revision,
      files: baselineFiles,
      editPolicyDigest: String(
        (this.db.prepare("SELECT edit_policy_digest FROM agent_drafts WHERE id = ?").get(draftId) as { edit_policy_digest: string }).edit_policy_digest,
      ),
    });
  }

  listByOwner(ownerId: string, lessonId: string): DraftRecord[] {
    const rows = this.db
      .prepare("SELECT id FROM agent_drafts WHERE owner_id = ? AND lesson_id = ?")
      .all(ownerId, lessonId) as Array<{ id: string }>;
    return rows.map((r) => this.get(r.id)!);
  }

  /** 草稿补丁（相对基线）供 diff 展示 */
  patchAgainstBase(draftId: string, baseFiles: Record<string, string>): Array<{ path: string; base: string; candidate: string }> {
    const draft = this.get(draftId);
    if (!draft) return [];
    const out: Array<{ path: string; base: string; candidate: string }> = [];
    for (const path of Object.keys(baseFiles)) {
      if (draft.files[path] !== baseFiles[path]) {
        out.push({ path, base: baseFiles[path]!, candidate: draft.files[path] ?? "" });
      }
    }
    return out;
  }
}

export function digestFiles(files: Record<string, string>): string {
  const canonical = Object.keys(files)
    .sort()
    .map((p) => `${p}\n${files[p]}`)
    .join("\n\u0000\n");
  return sha256(canonical);
}
