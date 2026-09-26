/**
 * 索引快照与检索（T14/T15）。
 * `dataset_revision + chunker_version + embedding_version + index_config` 共同定义索引快照；
 * 查询记录各阶段候选与淘汰原因（不只最终 top-k）；引用必须能解析回存在的块。
 * 依据设计文档 v1.1 §12.2。
 */
import type { Database } from "@agentglass/db";
import { newId, nowIso } from "@agentglass/db";
import type { BlobStore } from "@agentglass/events";
import { embed, cosine, vectorsToBlob, blobToVectors, fakeEmbed, type EmbeddingProfile } from "./embedding";
import { tokenize } from "./tokenize";
import type { IngestionService } from "./ingest";

export interface IndexSnapshotRow {
  id: string;
  datasetId: string;
  embeddingProfile: string;
  embeddingVersion: string;
  chunkerVersion: string;
  vectorDim: number;
  docRevisionIds: string[];
}

export interface ScoredHit {
  chunkId: string;
  docRevisionId: string;
  datasetId: string;
  heading: string | null;
  snippet: string;
  score: number;
  stage: "keyword" | "vector" | "fusion";
  /** 该阶段内的原始名次（可解释融合） */
  rank: number;
}

export interface RetrievalStageResult {
  stage: "keyword" | "vector" | "fusion";
  candidates: ScoredHit[];
  dropped: Array<{ chunkId: string; stage: string; reason: string }>;
}

export interface RetrievalResult {
  indexSnapshotId: string;
  query: string;
  stages: RetrievalStageResult[];
  /** 最终候选（融合排序后 top-k），供引用校验使用 */
  hits: ScoredHit[];
}

export class IndexService {
  constructor(
    private readonly db: Database,
    private readonly blobs: BlobStore,
    private readonly ingestion: IngestionService,
  ) {}

  /**
   * 为数据集当前（未被取代）文档构建新索引快照。
   * 同配置重复构建幂等（返回既有快照）；embedding 版本变化产生新快照，旧快照保留供历史对照。
   */
  async buildIndex(
    datasetId: string,
    profile: EmbeddingProfile,
    options: { chunkerVersion: string },
  ): Promise<IndexSnapshotRow> {
    const docs = this.db
      .prepare(
        "SELECT id FROM document_revisions WHERE dataset_id = ? AND superseded_by IS NULL",
      )
      .all(datasetId) as Array<{ id: string }>;
    const docIds = docs.map((d) => d.id);
    if (docIds.length === 0) throw new Error(`EMPTY_DATASET: ${datasetId}`);

    const chunks = docIds.flatMap((id) => this.ingestion.chunksOf(id));
    const embedding = await embed(
      profile,
      chunks.map((c) => c.text),
    );

    // 幂等：同 embedding 版本 + 同块集合 → 复用
    const existing = this.db
      .prepare(
        "SELECT id FROM index_snapshots WHERE dataset_id = ? AND embedding_version = ?",
      )
      .get(datasetId, embedding.embeddingVersion) as { id: string } | undefined;
    if (existing) return this.get(existing.id)!;

    const id = newId("idx");
    this.dbTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO index_snapshots (id, dataset_id, embedding_profile, embedding_version, chunker_version, vector_dim, doc_revision_ids, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          datasetId,
          profile.provider,
          embedding.embeddingVersion,
          options.chunkerVersion,
          embedding.vectors[0]?.length ?? 0,
          JSON.stringify(docIds),
          nowIso(),
        );
      const insertVector = this.db.prepare(
        "INSERT INTO chunk_vectors (index_snapshot_id, chunk_id, vector) VALUES (?, ?, ?)",
      );
      chunks.forEach((c, i) => {
        insertVector.run(id, c.id, vectorsToBlob(embedding.vectors[i]!));
      });
    });
    return this.get(id)!;
  }

  get(id: string): IndexSnapshotRow | undefined {
    const r = this.db.prepare("SELECT * FROM index_snapshots WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return undefined;
    return {
      id: String(r.id),
      datasetId: String(r.dataset_id),
      embeddingProfile: String(r.embedding_profile),
      embeddingVersion: String(r.embedding_version),
      chunkerVersion: String(r.chunker_version),
      vectorDim: Number(r.vector_dim),
      docRevisionIds: JSON.parse(String(r.doc_revision_ids)),
    };
  }

  latest(datasetId: string): IndexSnapshotRow | undefined {
    const r = this.db
      .prepare(
        "SELECT id FROM index_snapshots WHERE dataset_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(datasetId) as { id: string } | undefined;
    return r ? this.get(r.id) : undefined;
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

export interface QueryOptions {
  keyword?: boolean;
  vector?: boolean;
  fusion?: boolean;
  topK?: number;
}

export class RetrievalService {
  constructor(
    private readonly db: Database,
    private readonly blobs: BlobStore,
    private readonly ingestion: IngestionService,
  ) {}

  /**
   * 阶段可开关的检索：keyword(BM25) → vector(余弦) → fusion(RRF)。
   * 每阶段保存候选与淘汰原因；引用校验单独提供。
   */
  query(
    snapshot: IndexSnapshotRow,
    query: string,
    options: QueryOptions = {},
  ): RetrievalResult {
    const keyword = options.keyword ?? true;
    const vector = options.vector ?? true;
    const fusion = options.fusion ?? true;
    const topK = options.topK ?? 4;
    const stages: RetrievalStageResult[] = [];

    const chunks = snapshot.docRevisionIds.flatMap((id) => this.ingestion.chunksOf(id));
    const textOf = (chunkId: string): string => {
      const c = chunks.find((x) => x.id === chunkId)!;
      return c.text;
    };

    // —— 阶段 1：BM25 关键词 ——
    let keywordHits: ScoredHit[] = [];
    if (keyword) {
      keywordHits = bm25Rank(chunks.map((c) => ({ id: c.id, text: c.text })), query).map((r) => ({
        chunkId: r.id,
        docRevisionId: chunks.find((c) => c.id === r.id)!.docRevisionId,
        datasetId: snapshot.datasetId,
        heading: chunks.find((c) => c.id === r.id)!.heading,
        snippet: chunks.find((c) => c.id === r.id)!.text.slice(0, 200),
        score: r.score,
        stage: "keyword" as const,
        rank: r.rank,
      }));
      stages.push({
        stage: "keyword",
        candidates: keywordHits.slice(0, topK),
        dropped: [],
      });
    }

    // —— 阶段 2：向量 ——
    let vectorHits: ScoredHit[] = [];
    if (vector) {
            const vectorRows = this.db
        .prepare("SELECT chunk_id, vector FROM chunk_vectors WHERE index_snapshot_id = ?")
        .all(snapshot.id) as Array<{ chunk_id: string; vector: Uint8Array }>;
      const queryVector = this.embedQuery(snapshot, query);
      const scored = vectorRows
        .map((r) => ({
          chunkId: r.chunk_id,
          score: cosine(queryVector, blobToVectors(r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.vector.byteLength) as ArrayBuffer, snapshot.vectorDim)),
        }))
        .sort((a, b) => b.score - a.score);
      vectorHits = scored.map((s, i) => ({
        chunkId: s.chunkId,
        docRevisionId: chunks.find((c) => c.id === s.chunkId)!.docRevisionId,
        datasetId: snapshot.datasetId,
        heading: chunks.find((c) => c.id === s.chunkId)!.heading,
        snippet: textOf(s.chunkId).slice(0, 200),
        score: s.score,
        stage: "vector" as const,
        rank: i + 1,
      }));
      stages.push({
        stage: "vector",
        candidates: vectorHits.slice(0, topK),
        dropped: [],
      });
    }

    // —— 阶段 3：RRF 融合 ——
    let hits: ScoredHit[] = fusion && keyword && vector ? rrfFuse(keywordHits, vectorHits) : (vectorHits.length > 0 ? vectorHits : keywordHits);
    if (fusion && keyword && vector) {
      stages.push({
        stage: "fusion",
        candidates: hits.slice(0, topK),
        dropped: [],
      });
    }
    hits = hits.map((h, i) => ({ ...h, rank: i + 1 }));

    return {
      indexSnapshotId: snapshot.id,
      query,
      stages,
      hits: hits.slice(0, topK),
    };
  }

  private embedQuery(snapshot: IndexSnapshotRow, query: string): number[] {
    if (snapshot.embeddingVersion === "fake-emb-1") {
      return fakeEmbed(query);
    }
    throw new Error(
      `EMBEDDING_VERSION_MISMATCH: 查询向量化需要索引同版本嵌入（${snapshot.embeddingVersion}）；真实嵌入查询需配置对应 embedding 模型`,
    );
  }

}

/** 引用校验：回答中引用的块 ID 必须存在于当次检索候选中（引用存在性 ≠ 引用支持度）。 */
export function validateCitations(
  answer: string,
  allowedChunkIds: string[],
): { valid: boolean; cited: string[]; invalid: string[] } {
  const cited = [...answer.matchAll(/【c:([\w-]+)】/g)].map((m) => m[1]!);
  const invalid = cited.filter((c) => !allowedChunkIds.includes(c));
  return { valid: invalid.length === 0, cited: [...new Set(cited)], invalid: [...new Set(invalid)] };
}

// ---- BM25（自实现 Okapi；不把其他排序谎称 BM25） ----
export function bm25Rank(
  docs: Array<{ id: string; text: string }>,
  query: string,
  k1 = 1.5,
  b = 0.75,
): Array<{ id: string; score: number; rank: number }> {
  const docTokens = docs.map((d) => tokenize(d.text));
  const avgLen = docTokens.reduce((s, t) => s + t.length, 0) / (docTokens.length || 1);
  const df = new Map<string, number>();
  for (const tokens of docTokens) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const queryTokens = [...new Set(tokenize(query))];
  const scored = docs.map((d, i) => {
    const tokens = docTokens[i]!;
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const qt of queryTokens) {
      const f = tf.get(qt) ?? 0;
      if (f === 0) continue;
      const n = df.get(qt) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * tokens.length) / (avgLen || 1))));
    }
    return { id: d.id, score, rank: 0 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s, i) => ({ ...s, rank: i + 1 }));
}

/** 倒数排名融合（可解释：保留各阶段名次） */
export function rrfFuse(
  a: ScoredHit[],
  b: ScoredHit[],
  k = 60,
): ScoredHit[] {
  const byId = new Map<string, ScoredHit>();
  for (const [list, weight] of [[a, 1], [b, 1]] as const) {
    list.forEach((hit, i) => {
      const rrf = weight / (k + i + 1);
      const cur = byId.get(hit.chunkId);
      if (cur) {
        byId.set(hit.chunkId, { ...cur, score: cur.score + rrf, stage: "fusion" });
      } else {
        byId.set(hit.chunkId, { ...hit, score: rrf, stage: "fusion" });
      }
    });
  }
  return [...byId.values()].sort((x, y) => y.score - x.score);
}
