/**
 * T14—T18 知识层单元/集成测试：
 * 切块与版本一致性（T14）、BM25/向量/融合检索与引用校验（T15）、
 * Wiki 版本/冲突/影响分析（T16）、记忆作用域与遗忘传播（T17）。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Database } from "@agentglass/db";
import { BlobStore } from "@agentglass/events";
import {
  IngestionService,
  IndexService,
  RetrievalService,
  WikiService,
  MemoryService,
  validateCitations,
  bm25Rank,
  FAKE_EMBEDDING_VERSION,
} from "@agentglass/knowledge";

let dataDir: string;
let db: Database;
let blobs: BlobStore;
let ingestion: IngestionService;
let indexService: IndexService;
let retrieval: RetrievalService;
let wiki: WikiService;
let memory: MemoryService;

const DOC_V1 = `# 设备手册\n\n型号 AG-2048 的额定电压为 12V。\n\n## 维护\n\n每 6 个月更换滤芯。\n\n## 保修\n\n保修期 2 年。`;
const DOC_V2 = `# 设备手册\n\n型号 AG-2048 的额定电压为 24V。\n\n## 维护\n\n每 12 个月更换滤芯。\n\n## 保修\n\n保修期 2 年。`;
const FAQ = `# 常见问题\n\n指示灯红色闪烁表示滤芯堵塞，请更换滤芯。`;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ag-knowledge-"));
  db = openDatabase({ file: ":memory:" });
  blobs = new BlobStore(db, join(dataDir, "blobs"));
  ingestion = new IngestionService(db, blobs);
  indexService = new IndexService(db, blobs, ingestion);
  retrieval = new RetrievalService(db, blobs, ingestion);
  wiki = new WikiService(db, ingestion);
  memory = new MemoryService(db);
});

describe("T14 导入与切块", () => {
  it("标题边界切块保留 heading 与范围；重复导入幂等", () => {
    const ds = ingestion.ensureDataset("course-equipment");
    const rev = ingestion.ingestDocument({ datasetId: ds, path: "manual.md", title: "设备手册", version: "1.0", content: DOC_V1 });
    const chunks = ingestion.chunksOf(rev.id);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0]!.heading).toBe("设备手册");
    expect(chunks.some((c) => c.heading === "维护")).toBe(true);
    // 幂等
    const again = ingestion.ingestDocument({ datasetId: ds, path: "manual.md", title: "设备手册", version: "1.0", content: DOC_V1 });
    expect(again.id).toBe(rev.id);
    // 同版本不同内容 → 冲突错误
    expect(() =>
      ingestion.ingestDocument({ datasetId: ds, path: "manual.md", title: "设备手册", version: "1.0", content: "内容不同" }),
    ).toThrow(/DOC_VERSION_CONFLICT/);
  });

  it("新版本导入后旧版本标记 superseded_by（版本可追溯）", () => {
    const ds = ingestion.ensureDataset("course-equipment");
    const v1 = ingestion.ingestDocument({ datasetId: ds, path: "manual.md", title: "设备手册", version: "1.0", content: DOC_V1 });
    const v2 = ingestion.ingestDocument({ datasetId: ds, path: "manual.md", title: "设备手册", version: "2.0", content: DOC_V2 });
    expect(ingestion.getRevision(v1.id)!.supersededBy).toBe(v2.id);
    expect(ingestion.latestRevision(ds, "manual.md")!.id).toBe(v2.id);
  });
});

describe("T15 检索：BM25 / 向量 / 融合 / 引用", () => {
  let snapshotId: string;
  beforeEach(async () => {
    const ds = ingestion.ensureDataset("course-equipment");
    ingestion.ingestDocument({ datasetId: ds, path: "manual.md", title: "设备手册", version: "2.0", content: DOC_V2 });
    ingestion.ingestDocument({ datasetId: ds, path: "faq.md", title: "FAQ", version: "1.0", content: FAQ });
    const snap = await indexService.buildIndex(ds, { provider: "fake-embedding" }, { chunkerVersion: "chunker-1" });
    snapshotId = snap.id;
  });

  it("索引快照记录 embedding 版本；同配置幂等", async () => {
    const snap = indexService.get(snapshotId)!;
    expect(snap.embeddingVersion).toBe(FAKE_EMBEDDING_VERSION);
    const again = await indexService.buildIndex(snap.datasetId, { provider: "fake-embedding" }, { chunkerVersion: "chunker-1" });
    expect(again.id).toBe(snapshotId);
  });

  it("关键词检索命中相关块，BM25 排序可解释", () => {
    const snap = indexService.get(snapshotId)!;
    const result = retrieval.query(snap, "滤芯 更换 周期", { keyword: true, vector: false, fusion: false, topK: 2 });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]!.snippet).toContain("滤芯");
    expect(result.stages[0]!.stage).toBe("keyword");
  });

  it("向量检索：查询与相关内容语义（哈希）相似", () => {
    const snap = indexService.get(snapshotId)!;
    const result = retrieval.query(snap, "指示灯红色闪烁", { keyword: false, vector: true, fusion: false, topK: 2 });
    expect(result.hits[0]!.snippet).toContain("红色闪烁");
  });

  it("融合检索（RRF）合并两路候选并保留名次", () => {
    const snap = indexService.get(snapshotId)!;
    const result = retrieval.query(snap, "保修期 多久", { keyword: true, vector: true, fusion: true, topK: 3 });
    expect(result.stages.map((s) => s.stage)).toEqual(["keyword", "vector", "fusion"]);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]!.stage).toBe("fusion");
  });

  it("引用校验：无效引用被识别（引用存在 ≠ 引用支持）", () => {
    const ok = validateCitations("额定电压 24V【c:chk_abc】", ["chk_abc"]);
    expect(ok.valid).toBe(true);
    const bad = validateCitations("额定电压 24V【c:chk_fake】", ["chk_abc"]);
    expect(bad.valid).toBe(false);
    expect(bad.invalid).toEqual(["chk_fake"]);
  });

  it("BM25 是真 Okapi：包含词频饱和与长度归一（冒烟）", () => {
    const docs = [
      { id: "a", text: "滤芯 滤芯 滤芯 更换" },
      { id: "b", text: "滤芯 更换 周期 表" },
      { id: "c", text: "保修 两年 覆盖 全国" },
    ];
    const ranked = bm25Rank(docs, "滤芯 更换");
    expect(ranked[0]!.id).toBe("a");
    expect(ranked[ranked.length - 1]!.id).toBe("c");
  });
});

describe("T16 Wiki 版本/冲突/影响分析", () => {
  let ds: string;
  let v1: string;
  let chunkV1: string;
  beforeEach(() => {
    ds = ingestion.ensureDataset("course-equipment");
    const rev = ingestion.ingestDocument({ datasetId: ds, path: "manual.md", title: "设备手册", version: "1.0", content: DOC_V1 });
    v1 = rev.id;
    chunkV1 = ingestion.chunksOf(v1)[0]!.id;
  });

  it("提案→发布：无冲突时页面进入 published", () => {
    const { page, conflicts } = wiki.proposeRevision({
      slug: "ag-2048-spec",
      title: "AG-2048 规格",
      body: "AG-2048 额定电压为 12V。",
      claims: [{ text: "额定电压 12V", evidenceChunkIds: [chunkV1] }],
      evidenceDocRevisions: [v1],
      author: "course",
    });
    expect(conflicts).toEqual([]);
    const published = wiki.publish(page.currentRevisionId ?? wiki.revisionsOf(page.id)[0]!.id);
    expect(published.status).toBe("published");
  });

  it("证据来自已取代版本 → 冲突记录，页面保持 draft，不能发布", () => {
    wiki.proposeRevision({
      slug: "ag-2048-spec",
      title: "AG-2048 规格",
      body: "AG-2048 额定电压为 12V。",
      claims: [{ text: "额定电压 12V", evidenceChunkIds: [chunkV1] }],
      evidenceDocRevisions: [v1],
      author: "course",
    });
    const page = wiki.getPage("ag-2048-spec")!;
    wiki.publish(wiki.revisionsOf(page.id)[0]!.id);
    // 文档更新到 2.0（12V→24V，旧证据被取代）
    const v2 = ingestion.ingestDocument({ datasetId: ds, path: "manual.md", title: "设备手册", version: "2.0", content: DOC_V2 });
    // 基于旧证据的新提案 → 冲突
    const { conflicts } = wiki.proposeRevision({
      slug: "ag-2048-spec",
      body: "AG-2048 额定电压为 12V。",
      claims: [{ text: "额定电压 12V", evidenceChunkIds: [chunkV1] }],
      evidenceDocRevisions: [v1],
      author: "course",
    });
    expect(conflicts.some((c) => c.kind === "evidence_superseded")).toBe(true);
    const page2 = wiki.getPage("ag-2048-spec")!;
    expect(page2.status).toBe("draft");
    expect(() => wiki.publish(wiki.revisionsOf(page2.id).at(-1)!.id)).toThrow(/WIKI_CONFLICTS_UNRESOLVED/);
    void v2;
  });

  it("影响分析：来源版本变化定位受影响 Wiki", () => {
    wiki.proposeRevision({
      slug: "ag-2048-spec",
      body: "电压 12V。",
      claims: [{ text: "额定电压 12V", evidenceChunkIds: [chunkV1] }],
      evidenceDocRevisions: [v1],
      author: "course",
    });
    const v2 = ingestion.ingestDocument({ datasetId: ds, path: "manual.md", title: "设备手册", version: "2.0", content: DOC_V2 });
    const impact = wiki.impactAnalysis(v2.id);
    expect(impact.superseded).toContain(v1);
    expect(impact.affectedPages.length).toBeGreaterThan(0);
  });

  it("无证据论断 → missing_evidence 冲突", () => {
    const { conflicts } = wiki.proposeRevision({
      slug: "spec-no-evidence",
      body: "凭空断言。",
      claims: [{ text: "无人支持的论断", evidenceChunkIds: [] }],
      evidenceDocRevisions: [],
      author: "course",
    });
    expect(conflicts.some((c) => c.kind === "missing_evidence")).toBe(true);
  });
});

describe("T17 记忆：作用域隔离与遗忘传播（A14）", () => {
  it("写入/读取/更新版本链", () => {
    const w1 = memory.write({ scopeKind: "user", scopeId: "learner-a", kind: "semantic", content: "输出偏好：先结论后依据" });
    expect(w1.duplicate).toBe(false);
    expect(w1.entry.version).toBe(1);
    const dup = memory.write({ scopeKind: "user", scopeId: "learner-a", kind: "semantic", content: "输出偏好：先结论后依据" });
    expect(dup.duplicate).toBe(true);
    const w2 = memory.write({ scopeKind: "user", scopeId: "learner-a", kind: "semantic", content: "输出偏好：先依据后结论" });
    expect(w2.entry.version).toBe(2);
    expect(w2.entry.previousId).toBe(w1.entry.id);
  });

  it("跨用户隔离：B 读不到 A 的记忆，也不能删除", () => {
    memory.write({ scopeKind: "user", scopeId: "learner-a", kind: "semantic", content: "A 的私有偏好" });
    expect(memory.recall("user", "learner-b", "私有偏好")).toEqual([]);
    expect(memory.listActive("user", "learner-b").length).toBe(0);
    const a = memory.listActive("user", "learner-a")[0]!;
    expect(() => memory.forget(a.id, "user", "learner-b")).toThrow(/MEMORY_SCOPE_MISMATCH/);
  });

  it("遗忘传播：遗忘后 recall/listActive 不再返回（A14）", () => {
    const { entry } = memory.write({ scopeKind: "user", scopeId: "learner-a", kind: "semantic", content: "先结论后依据" });
    expect(memory.recall("user", "learner-a", "结论 依据").length).toBe(1);
    expect(memory.forget(entry.id, "user", "learner-a")).toBe(true);
    expect(memory.recall("user", "learner-a", "结论 依据")).toEqual([]);
    expect(memory.listActive("user", "learner-a")).toEqual([]);
    const forgotten = memory.get(entry.id)!;
    expect(forgotten.status).toBe("forgotten");
    expect(forgotten.forgottenAt).toBeTruthy();
  });
});
