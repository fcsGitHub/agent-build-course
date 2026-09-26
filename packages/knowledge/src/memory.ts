/**
 * 长期记忆（T17 基础）。提案→分类→写入→读取→更新→遗忘；
 * 作用域是独立字段（user/project/session）；删除传播到读取路径（遗忘后不再命中）。
 * 依据设计文档 v1.1 §12.4 与验收 A14。
 */
import { createHash } from "node:crypto";
import type { Database } from "@agentglass/db";
import { newId, nowIso } from "@agentglass/db";
import { tokenize } from "./tokenize";

export type MemoryScopeKind = "user" | "project" | "session";
export type MemoryKind = "episodic" | "semantic" | "procedural";

export interface MemoryEntry {
  id: string;
  scopeKind: MemoryScopeKind;
  scopeId: string;
  kind: MemoryKind;
  content: string;
  version: number;
  previousId: string | null;
  sourceRef: string | null;
  status: "active" | "forgotten";
  createdAt: string;
  forgottenAt: string | null;
}

export interface RecallHit {
  entry: MemoryEntry;
  score: number;
}

export class MemoryService {
  constructor(private readonly db: Database) {}

  /** 写入/更新。同一作用域内内容相同幂等；内容不同产生新版本（previous_id 链）。 */
  write(input: {
    scopeKind: MemoryScopeKind;
    scopeId: string;
    kind: MemoryKind;
    content: string;
    sourceRef?: string;
  }): { entry: MemoryEntry; duplicate: boolean } {
    const contentSha = createHash("sha256").update(input.content, "utf8").digest("hex");
    const active = this.listActive(input.scopeKind, input.scopeId, input.kind);
    const same = active.find(
      (m) =>
        createHash("sha256").update(m.content, "utf8").digest("hex") === contentSha,
    );
    if (same) return { entry: same, duplicate: true };

    // 同类最近的活跃条目作为前版本（简单可解释的版本链）
    const previous = active.at(-1) ?? null;
    const id = newId("mem");
    this.db
      .prepare(
        `INSERT INTO memory_entries (id, scope_kind, scope_id, kind, content, version, previous_id, source_ref, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(
        id,
        input.scopeKind,
        input.scopeId,
        input.kind,
        input.content,
        previous ? previous.version + 1 : 1,
        previous?.id ?? null,
        input.sourceRef ?? null,
        nowIso(),
      );
    if (previous) {
      // 旧版本标记被取代（不再命中，但保留可追溯）
      this.db
        .prepare("UPDATE memory_entries SET status = 'forgotten', forgotten_at = ? WHERE id = ?")
        .run(nowIso(), previous.id);
    }
    return { entry: this.get(id)!, duplicate: false };
  }

  get(id: string): MemoryEntry | undefined {
    return this.toEntry(this.db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined);
  }

  listActive(scopeKind: MemoryScopeKind, scopeId: string, kind?: MemoryKind): MemoryEntry[] {
    const rows = (kind
      ? this.db
          .prepare(
            "SELECT id FROM memory_entries WHERE scope_kind = ? AND scope_id = ? AND kind = ? AND status = 'active' ORDER BY created_at ASC",
          )
          .all(scopeKind, scopeId, kind)
      : this.db
          .prepare(
            "SELECT id FROM memory_entries WHERE scope_kind = ? AND scope_id = ? AND status = 'active' ORDER BY created_at ASC",
          )
          .all(scopeKind, scopeId)) as Array<{ id: string }>;
    return rows.map((r) => this.get(r.id)!).filter(Boolean);
  }

  /** 检索：词重叠打分（可解释），返回命中与得分；遗忘条目绝不出现。 */
  recall(scopeKind: MemoryScopeKind, scopeId: string, query: string, topK = 3): RecallHit[] {
    const queryTokens = new Set(tokenize(query));
    const hits: RecallHit[] = [];
    for (const entry of this.listActive(scopeKind, scopeId)) {
      const tokens = tokenize(entry.content);
      let overlap = 0;
      for (const t of tokens) if (queryTokens.has(t)) overlap += 1;
      const score = tokens.length > 0 ? overlap / Math.sqrt(tokens.length) : 0;
      if (score > 0) hits.push({ entry, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /**
   * 遗忘：条目标记 forgotten（保留最小操作记录，不再返回内容）。
   * 读取路径（listActive/recall）只看 status='active' → 删除传播完成。
   */
  forget(id: string, scopeKind: MemoryScopeKind, scopeId: string): boolean {
    const row = this.get(id);
    if (!row) return false;
    // 作用域校验：跨作用域遗忘必须拒绝（隔离）
    if (row.scopeKind !== scopeKind || row.scopeId !== scopeId) {
      throw new Error(`MEMORY_SCOPE_MISMATCH: 不能跨作用域删除他人记忆`);
    }
    this.db
      .prepare("UPDATE memory_entries SET status = 'forgotten', forgotten_at = ? WHERE id = ?")
      .run(nowIso(), id);
    return true;
  }

  private toEntry(r: Record<string, unknown> | undefined): MemoryEntry | undefined {
    if (!r) return undefined;
    return {
      id: String(r.id),
      scopeKind: r.scope_kind as MemoryScopeKind,
      scopeId: String(r.scope_id),
      kind: r.kind as MemoryKind,
      content: String(r.content),
      version: Number(r.version),
      previousId: (r.previous_id as string | null) ?? null,
      sourceRef: (r.source_ref as string | null) ?? null,
      status: r.status as MemoryEntry["status"],
      createdAt: String(r.created_at),
      forgottenAt: (r.forgotten_at as string | null) ?? null,
    };
  }
}
