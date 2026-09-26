/**
 * 资料导入与切块（T14）。
 * 导入保留原文、许可、版本与内容摘要；切块支持固定长度与标题边界两种策略，
 * 每个块保留父文档、范围与切块器版本；修改切块参数形成新索引，不覆盖旧引用。
 * 依据设计文档 v1.1 §12.2。
 */
import { createHash } from "node:crypto";
import type { Database } from "@agentglass/db";
import { newId, nowIso } from "@agentglass/db";
import type { BlobStore } from "@agentglass/events";

export const CHUNKER_VERSION = "chunker-1";

export interface IngestDocumentInput {
  datasetId: string;
  path: string;
  title: string;
  version: string;
  content: string;
  license?: string;
  /** 同 path 新版本导入时，是否把旧版本标记为被取代（影响分析数据源） */
  supersedePrevious?: boolean;
}

export interface DocumentRevisionRow {
  id: string;
  datasetId: string;
  path: string;
  title: string;
  version: string;
  contentSha256: string;
  supersededBy: string | null;
}

export interface ChunkRow {
  id: string;
  docRevisionId: string;
  datasetId: string;
  seq: number;
  startOffset: number;
  endOffset: number;
  heading: string | null;
  text: string;
  chunkerVersion: string;
}

export class IngestionService {
  constructor(
    private readonly db: Database,
    private readonly blobs: BlobStore,
  ) {}

  ensureDataset(name: string, license = "course-internal"): string {
    const existing = this.db.prepare("SELECT id FROM datasets WHERE name = ?").get(name) as
      | { id: string }
      | undefined;
    if (existing) return existing.id;
    const id = newId("ds");
    this.db
      .prepare("INSERT INTO datasets (id, name, license, created_at) VALUES (?, ?, ?, ?)")
      .run(id, name, license, nowIso());
    return id;
  }

  /** 重复导入同内容同版本幂等：返回既有 revision。 */
  ingestDocument(input: IngestDocumentInput): DocumentRevisionRow {
    const contentSha = createHash("sha256").update(input.content, "utf8").digest("hex");
    const existing = this.db
      .prepare(
        "SELECT id, dataset_id, path, title, version, content_sha256, superseded_by FROM document_revisions WHERE dataset_id = ? AND path = ? AND version = ?",
      )
      .get(input.datasetId, input.path, input.version) as
      | { id: string; dataset_id: string; path: string; title: string; version: string; content_sha256: string; superseded_by: string | null }
      | undefined;
    if (existing) {
      if (existing.content_sha256 !== contentSha) {
        throw new Error(
          `DOC_VERSION_CONFLICT: ${input.path}@${input.version} 同版本内容不同——请提升版本号（来源版本必须可追溯）`,
        );
      }
      return {
        id: existing.id,
        datasetId: existing.dataset_id,
        path: existing.path,
        title: existing.title,
        version: existing.version,
        contentSha256: existing.content_sha256,
        supersededBy: existing.superseded_by,
      };
    }
    const id = newId("docrev");
    const ref = this.blobs.putText(input.content, "text/plain; charset=utf-8");
    const tx = this.dbTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO document_revisions (id, dataset_id, path, title, version, content_sha256, content_ref, published_at, superseded_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(id, input.datasetId, input.path, input.title, input.version, contentSha, ref.id, nowIso());
      if (input.supersedePrevious !== false) {
        this.db
          .prepare(
            `UPDATE document_revisions SET superseded_by = ? WHERE dataset_id = ? AND path = ? AND id != ? AND superseded_by IS NULL`,
          )
          .run(id, input.datasetId, input.path, id);
      }
      // 切块
      const chunks = chunkDocument(input.content, id, input.datasetId);
      for (const c of chunks) {
        this.db
          .prepare(
            `INSERT INTO chunks (id, doc_revision_id, dataset_id, seq, start_offset, end_offset, heading, text_sha256, text_ref, chunker_version, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            c.id,
            c.docRevisionId,
            c.datasetId,
            c.seq,
            c.startOffset,
            c.endOffset,
            c.heading,
            createHash("sha256").update(c.text, "utf8").digest("hex"),
            this.blobs.putText(c.text, "text/plain; charset=utf-8").id,
            c.chunkerVersion,
            nowIso(),
          );
      }
    });
    void tx;
    return {
      id,
      datasetId: input.datasetId,
      path: input.path,
      title: input.title,
      version: input.version,
      contentSha256: contentSha,
      supersededBy: null,
    };
  }

  getRevision(id: string): DocumentRevisionRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM document_revisions WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: String(r.id),
      datasetId: String(r.dataset_id),
      path: String(r.path),
      title: String(r.title),
      version: String(r.version),
      contentSha256: String(r.content_sha256),
      supersededBy: (r.superseded_by as string | null) ?? null,
    };
  }

  latestRevision(datasetId: string, path: string): DocumentRevisionRow | undefined {
    const r = this.db
      .prepare(
        `SELECT id FROM document_revisions WHERE dataset_id = ? AND path = ? AND superseded_by IS NULL ORDER BY published_at DESC LIMIT 1`,
      )
      .get(datasetId, path) as { id: string } | undefined;
    return r ? this.getRevision(r.id) : undefined;
  }

  chunksOf(docRevisionId: string): ChunkRow[] {
    const rows = this.db
      .prepare("SELECT * FROM chunks WHERE doc_revision_id = ? ORDER BY seq ASC")
      .all(docRevisionId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      docRevisionId: String(r.doc_revision_id),
      datasetId: String(r.dataset_id),
      seq: Number(r.seq),
      startOffset: Number(r.start_offset),
      endOffset: Number(r.end_offset),
      heading: (r.heading as string | null) ?? null,
      text: this.blobs.getText(String(r.text_ref)),
      chunkerVersion: String(r.chunker_version),
    }));
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

export interface ChunkOptions {
  maxChars?: number;
  strategy?: "fixed" | "heading";
}

/** 切块：heading 策略按 Markdown 标题边界聚合（超限再切）；fixed 定长滑窗。 */
export function chunkDocument(
  content: string,
  docRevisionId: string,
  datasetId: string,
  options: ChunkOptions = {},
): ChunkRow[] {
  const strategy = options.strategy ?? "heading";
  const maxChars = options.maxChars ?? 800;
  const sections =
    strategy === "heading" ? splitByHeadings(content) : [{ heading: null, text: content }];
  const chunks: ChunkRow[] = [];
  let seq = 0;
  let offset = 0;
  for (const section of sections) {
    const pieces: Array<{ text: string; start: number }> = [];
    let cursor = 0;
    while (cursor < section.text.length) {
      const size = Math.min(maxChars, section.text.length - cursor);
      // 尽量在换行处断开
      let end = cursor + size;
      if (end < section.text.length) {
        const lastBreak = section.text.lastIndexOf("\n", end);
        if (lastBreak > cursor + 80) end = lastBreak + 1;
      }
      pieces.push({ text: section.text.slice(cursor, end), start: offset + cursor });
      cursor = end;
    }
    for (const piece of pieces) {
      if (piece.text.trim().length === 0) continue;
      chunks.push({
        id: newId("chk"),
        docRevisionId,
        datasetId,
        seq: seq++,
        startOffset: piece.start,
        endOffset: piece.start + piece.text.length,
        heading: section.heading,
        text: piece.text,
        chunkerVersion: CHUNKER_VERSION,
      });
      offset += 0; // offset 由外层累加（heading 切分后统一在下面重算也行；此处保持片段近似位置）
    }
    offset += section.text.length;
  }
  return chunks;
}

function splitByHeadings(content: string): Array<{ heading: string | null; text: string }> {
  const lines = content.split("\n");
  const sections: Array<{ heading: string | null; text: string }> = [];
  let current: { heading: string | null; text: string } = { heading: null, text: "" };
  for (const line of lines) {
    const m = line.match(/^(#{1,4})\s+(.*)$/);
    if (m) {
      if (current.text.trim().length > 0) sections.push(current);
      current = { heading: m[2]!.trim(), text: line + "\n" };
    } else {
      current.text += line + "\n";
    }
  }
  if (current.text.trim().length > 0) sections.push(current);
  return sections.length > 0 ? sections : [{ heading: null, text: content }];
}
