/**
 * Wiki：可版本化、可链接、可校正的知识工件（T16）。
 * 页面状态 draft → reviewed → published → superseded；
 * 更新流程：影响分析 → 修订提案 → 证据检查 → 冲突处理 → 发布；
 * 不把冲突内容静默合并成无保留断言（§12.3）。
 */
import type { Database } from "@agentglass/db";
import { newId, nowIso } from "@agentglass/db";
import type { IngestionService } from "./ingest";

export type WikiStatus = "draft" | "reviewed" | "published" | "superseded";

export interface WikiRevisionRow {
  id: string;
  pageId: string;
  revisionNo: number;
  body: string;
  claims: WikiClaim[];
  evidenceChunkIds: string[];
  evidenceDocRevisions: string[];
  conflicts: WikiConflict[];
  author: string;
  status: WikiStatus;
}

export interface WikiClaim {
  text: string;
  evidenceChunkIds: string[];
}

export interface WikiConflict {
  kind: "evidence_superseded" | "claim_conflict" | "missing_evidence";
  detail: string;
}

export interface PageRow {
  id: string;
  slug: string;
  title: string;
  status: WikiStatus;
  currentRevisionId: string | null;
}

export class WikiService {
  constructor(
    private readonly db: Database,
    private readonly ingestion: IngestionService,
  ) {}

  createPage(slug: string, title: string): PageRow {
    const existing = this.db.prepare("SELECT id FROM wiki_pages WHERE slug = ?").get(slug) as
      | { id: string }
      | undefined;
    if (existing) return this.getPage(existing.id)!;
    const id = newId("wiki");
    this.db
      .prepare(
        "INSERT INTO wiki_pages (id, slug, title, status, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?)",
      )
      .run(id, slug, title, nowIso(), nowIso());
    return this.getPage(id)!;
  }

  getPage(idOrSlug: string): PageRow | undefined {
    const r =
      (this.db.prepare("SELECT * FROM wiki_pages WHERE id = ?").get(idOrSlug) ??
        this.db.prepare("SELECT * FROM wiki_pages WHERE slug = ?").get(idOrSlug)) as
        | Record<string, unknown>
        | undefined;
    if (!r) return undefined;
    return {
      id: String(r.id),
      slug: String(r.slug),
      title: String(r.title),
      status: r.status as WikiStatus,
      currentRevisionId: (r.current_revision as string | null) ?? null,
    };
  }

  listPages(): PageRow[] {
    const rows = this.db.prepare("SELECT id FROM wiki_pages ORDER BY updated_at DESC").all() as Array<{
      id: string;
    }>;
    return rows.map((r) => this.getPage(r.id)!);
  }

  /**
   * 修订提案：不做"模型生成即为真"——
   * 冲突检测：证据块所属文档版本已被取代 → evidence_superseded；
   * 无证据的论断 → missing_evidence。
   * 冲突不阻断保存，但页面保持 draft 且冲突显式记录。
   */
  proposeRevision(input: {
    slug: string;
    title?: string;
    body: string;
    claims: WikiClaim[];
    evidenceDocRevisions: string[];
    author: string;
  }): { page: PageRow; revision: WikiRevisionRow; conflicts: WikiConflict[] } {
    let page = this.getPage(input.slug);
    if (!page) page = this.createPage(input.slug, input.title ?? input.slug);
    const chunkIds = [...input.claims.flatMap((c) => c.evidenceChunkIds)];
    const conflicts = this.detectConflicts(chunkIds, input.claims);

    const revisionNo =
      (this.db
        .prepare("SELECT COALESCE(MAX(revision_no), 0) AS n FROM wiki_revisions WHERE page_id = ?")
        .get(page.id) as { n: number }).n + 1;
    const revId = newId("wikirev");
    this.db
      .prepare(
        `INSERT INTO wiki_revisions (id, page_id, revision_no, body, claims, evidence_chunk_ids, evidence_doc_revisions, conflicts, author, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
      )
      .run(
        revId,
        page.id,
        revisionNo,
        input.body,
        JSON.stringify(input.claims),
        JSON.stringify(chunkIds),
        JSON.stringify(input.evidenceDocRevisions),
        JSON.stringify(conflicts),
        input.author,
        nowIso(),
      );
    // 有冲突或未审核 → 不推进页面状态
    if (conflicts.length === 0) {
      this.db
        .prepare("UPDATE wiki_pages SET updated_at = ? WHERE id = ?")
        .run(nowIso(), page.id);
    } else {
      this.db
        .prepare("UPDATE wiki_pages SET status = 'draft', updated_at = ? WHERE id = ?")
        .run(nowIso(), page.id);
    }
    page = this.getPage(page.id)!;
    return { page, revision: this.getRevision(revId)!, conflicts };
  }

  /** 发布：仅当修订无冲突（或有已处理记录）且证据可解析时允许。 */
  publish(revisionId: string): PageRow {
    const rev = this.getRevision(revisionId);
    if (!rev) throw new Error(`WIKI_REVISION_NOT_FOUND: ${revisionId}`);
    if (rev.conflicts.length > 0) {
      throw new Error(`WIKI_CONFLICTS_UNRESOLVED: ${rev.conflicts.map((c) => c.kind).join(",")}`);
    }
    this.dbTransaction(() => {
      const page = this.getPage(rev.pageId)!;
      if (page.currentRevisionId) {
        this.db
          .prepare("UPDATE wiki_revisions SET status = 'superseded' WHERE id = ?")
          .run(page.currentRevisionId);
      }
      this.db
        .prepare("UPDATE wiki_revisions SET status = 'published' WHERE id = ?")
        .run(revisionId);
      this.db
        .prepare("UPDATE wiki_pages SET status = 'published', current_revision = ?, updated_at = ? WHERE id = ?")
        .run(revisionId, nowIso(), rev.pageId);
      // 反向链接：从正文 [[slug]] 提取
      for (const m of rev.body.matchAll(/\[\[([\w-]+)\]\]/g)) {
        const target = this.getPage(m[1]!);
        if (target) {
          this.db
            .prepare("INSERT OR IGNORE INTO wiki_links (from_page, to_page) VALUES (?, ?)")
            .run(rev.pageId, target.id);
        }
      }
    });
    return this.getPage(rev.pageId)!;
  }

  getRevision(id: string): WikiRevisionRow | undefined {
    const r = this.db.prepare("SELECT * FROM wiki_revisions WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return undefined;
    return {
      id: String(r.id),
      pageId: String(r.page_id),
      revisionNo: Number(r.revision_no),
      body: String(r.body),
      claims: JSON.parse(String(r.claims)),
      evidenceChunkIds: JSON.parse(String(r.evidence_chunk_ids)),
      evidenceDocRevisions: JSON.parse(String(r.evidence_doc_revisions)),
      conflicts: JSON.parse(String(r.conflicts)),
      author: String(r.author),
      status: r.status as WikiStatus,
    };
  }

  revisionsOf(pageId: string): WikiRevisionRow[] {
    return (this.db
      .prepare("SELECT id FROM wiki_revisions WHERE page_id = ? ORDER BY revision_no ASC")
      .all(pageId) as Array<{ id: string }>)
      .map((r) => this.getRevision(r.id)!)
      .filter(Boolean);
  }

  /**
   * 影响分析：给定文档版本（例如刚导入的新版本），找出
   * 1) 被其取代的旧版本 2) 引用旧版本证据的 Wiki 修订 3) 相关页面。
   */
  impactAnalysis(docRevisionId: string): { superseded: string[]; affectedRevisions: string[]; affectedPages: string[] } {
    const rev = this.ingestion.getRevision(docRevisionId);
    if (!rev) throw new Error(`DOC_REVISION_NOT_FOUND: ${docRevisionId}`);
    const supersededRows = this.db
      .prepare(
        "SELECT id FROM document_revisions WHERE dataset_id = ? AND path = ? AND id != ?",
      )
      .all(rev.datasetId, rev.path, docRevisionId) as Array<{ id: string }>;
    const oldIds = supersededRows.map((r) => r.id);
    const affectedRevisions: string[] = [];
    const affectedPages = new Set<string>();
    for (const oldId of oldIds) {
      const rows = this.db
        .prepare(
          `SELECT id, page_id FROM wiki_revisions WHERE evidence_doc_revisions LIKE ?`,
        )
        .all(`%"${oldId}"%`) as Array<{ id: string; page_id: string }>;
      for (const r of rows) {
        affectedRevisions.push(r.id);
        affectedPages.add(r.page_id);
      }
    }
    return {
      superseded: oldIds,
      affectedRevisions,
      affectedPages: [...affectedPages],
    };
  }

  private detectConflicts(chunkIds: string[], claims: WikiClaim[]): WikiConflict[] {
    const conflicts: WikiConflict[] = [];
    for (const chunkId of chunkIds) {
      const chunk = this.db.prepare("SELECT doc_revision_id FROM chunks WHERE id = ?").get(chunkId) as
        | { doc_revision_id: string }
        | undefined;
      if (!chunk) {
        conflicts.push({ kind: "missing_evidence", detail: `证据块不存在: ${chunkId}` });
        continue;
      }
      const rev = this.ingestion.getRevision(chunk.doc_revision_id);
      if (rev?.supersededBy) {
        conflicts.push({
          kind: "evidence_superseded",
          detail: `证据来自已取代的文档版本 ${rev.path}@${rev.version}（新版本 ${rev.supersededBy}）——论断需要复核`,
        });
      }
    }
    for (const claim of claims) {
      if (claim.evidenceChunkIds.length === 0) {
        conflicts.push({ kind: "missing_evidence", detail: `论断无证据: ${claim.text.slice(0, 60)}` });
      }
    }
    return conflicts;
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
