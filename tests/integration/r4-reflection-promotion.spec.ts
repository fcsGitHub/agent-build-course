/**
 * R4 测试（T30 反思 + T31 演进门控）：
 * - L36 chain：失败反思注入（reflection.recorded 事件 + 重试命中正确文件）；
 * - 门控拒绝矩阵：证据被取代/禁用构造/验证集未达门槛/并发版本变化；
 * - 晋级：全门通过 → 技能新版本；候选不可改 grader（冻结）。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Database } from "@agentglass/db";
import { BlobStore, EventStore } from "@agentglass/events";
import { LessonRegistry } from "@agentglass/lessons";
import { SessionService } from "@agentglass/conversation";
import { RunCoordinator } from "@agentglass/worker";
import { SkillRegistry } from "@agentglass/skills";
import { IngestionService, IndexService, RetrievalService } from "@agentglass/knowledge";
import { EvaluationService } from "@agentglass/evaluation";
import { ReflectionService, CandidateService } from "@agentglass/evolution";
import type { ModelProfileSnapshot, EvalCase } from "@agentglass/contracts";
import { DEFAULT_BUDGET } from "@agentglass/contracts";

const REPO_ROOT = join(__dirname, "..", "..");
const LESSONS_DIR = join(REPO_ROOT, "lessons");

let dataDir: string;
let db: Database;
let blobs: BlobStore;
let events: EventStore;
let sessions: SessionService;
let coordinator: RunCoordinator;
let skills: SkillRegistry;
let ingestion: IngestionService;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ag-r4-"));
  db = openDatabase({ file: ":memory:" });
  blobs = new BlobStore(db, join(dataDir, "blobs"));
  events = new EventStore(db);
  sessions = new SessionService(db, blobs);
  coordinator = new RunCoordinator({
    db,
    dataDir,
    lessons: new LessonRegistry(LESSONS_DIR),
    pollIntervalMs: 80,
  });
  skills = new SkillRegistry(db, blobs);
  ingestion = new IngestionService(db, blobs);
});

async function seedFake(): Promise<string> {
  const snap: ModelProfileSnapshot = {
    id: `snap_${Math.random().toString(36).slice(2, 8)}`,
    provider: "fake",
    protocol: "fake/v1",
    endpointId: "fake",
    modelId: "fake-deterministic",
    parameters: {},
    capabilities: {
      streaming: true,
      nativeTools: true,
      parallelToolCalls: true,
      structuredOutput: "native_schema",
      imageInput: false,
      audioInput: false,
      outputModalities: ["text"],
      usageReporting: "stream_and_final",
      contextWindow: 32000,
      testedAt: "static-declaration",
      probeSuiteVersion: "fake-1",
    },
  };
  db.prepare(
    "INSERT INTO model_profile_snapshots (id, profile_id, snapshot, created_at) VALUES (?, 'p', ?, ?)",
  ).run(snap.id, JSON.stringify(snap), new Date().toISOString());
  return snap.id;
}

describe("T30 反思重试（L36）", () => {
  it("chain 步骤 1 读取失败 → reflection.recorded（来源 tool_error）→ 步骤 2 重试正确文件", async () => {
    const snapId = await seedFake();
    const courseRevision = await coordinator.ensureCourseRevision("L36-reflect-retry");
    const sessionId = sessions.createSession("local-learner", "local-project", {
      lessonId: "L36-reflect-retry",
      lessonRevision: "1.0.0",
      agentRevisionId: courseRevision,
      modelProfileSnapshotId: snapId,
      runtimeSnapshotId: "rt",
      assetSnapshotId: "as",
      policySnapshotId: "po",
      budget: DEFAULT_BUDGET,
    });
    sessions.submitInput({
      sessionId,
      clientMessageId: `r4-${Math.random().toString(36).slice(2)}`,
      text: "请读取 missing.csv 并汇总内容；失败后根据反思改用 inventory.csv。",
      origin: "interactive",
    });
    coordinator.start();
    const deadline = Date.now() + 60_000;
    let run: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      const accepted = sessions.listInputs(sessionId).find((i) => i.acceptedRunId);
      if (accepted) {
        const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(accepted.acceptedRunId!) as
          | Record<string, unknown>
          | undefined;
        if (row) {
          run = row;
          if (!["queued", "running", "awaiting_approval"].includes(String(row.state))) break;
        }
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    coordinator.stop();
    expect(run).toBeDefined();
    expect(String(run!.state)).toBe("completed");
    const runId = String(run!.id);
    const all = events.readRange(runId, 0, events.maxSeq(runId));
    const reflection = all.find((e) => e.type === "reflection.recorded");
    expect(reflection).toBeDefined();
    expect((reflection!.summary as Record<string, unknown>).source).toBe("tool_error");
    // 重试步（步骤 2/3）已执行：存在第二个 context.compiled（chain step 标注 >=2）
    const steps = all
      .filter((e) => e.type === "context.compiled")
      .map((e) => (e.summary as Record<string, unknown>).step);
    expect(steps.length).toBeGreaterThanOrEqual(2);
    rmSync(dataDir, { recursive: true, force: true });
  }, 90_000);
});

describe("T31 演进门控", () => {
  let skills: SkillRegistry;
  let ingestion: IngestionService;
  let evaluation: EvaluationService;
  let ds: string;
  let currentChunkId: string;
  let currentDocRev: string;
  const GOOD_BODY = "# 证据摘要技能 v2\n\n1. 检索资料\n2. 先结论后依据\n";

  beforeEach(() => {
    skills = new SkillRegistry(db, blobs);
    ingestion = new IngestionService(db, blobs);
    evaluation = new EvaluationService();
    ds = ingestion.ensureDataset("promo-ds");
    const rev = ingestion.ingestDocument({ datasetId: ds, path: "manual.md", title: "手册", version: "2.0", content: "额定电压 24V。滤芯 12 个月。" });
    currentDocRev = rev.id;
    currentChunkId = ingestion.chunksOf(rev.id)[0]!.id;
    skills.installFromDir(join(LESSONS_DIR, "L18-skills", "..", "..", "skills", "evidence-summary-skill"));
  });

  const evalCases: EvalCase[] = [
    { id: "e1", split: "dev", input: "x", grader: { kind: "contains_all", patterns: ["检索", "结论"] } },
  ];

  function makeCandidate(overrides: Partial<Parameters<CandidateService["evaluateAndPromote"]>[0]["candidate"]> = {}) {
    const base = skills.get("evidence-summary-skill")!;
    return {
      candidateId: `cand_${Math.random().toString(36).slice(2, 8)}`,
      skillSlug: "evidence-summary-skill",
      baseVersion: base.version,
      newBody: GOOD_BODY,
      evidenceChunkIds: [currentChunkId],
      proposedBy: "learner",
      evalCases: [
        { id: "e1", split: "dev" as const, input: "x", grader: { kind: "contains_all" as const, patterns: ["检索", "结论"] } },
      ],
      ...overrides,
    };
  }

  function makeSvc(db2: Database, blobs2: BlobStore, events2: EventStore, skills2: SkillRegistry, ingestion2: IngestionService, evaluation2: EvaluationService) {
    return new CandidateService(db2, blobs2, events2, skills2, ingestion2, evaluation2);
  }

  it("全门通过 → 技能晋级新版本，正文更新", async () => {
    const svc = makeSvc(db, blobs, events, skills, ingestion, evaluation);
    const decision = await svc.evaluateAndPromote({
      evalCases,
      candidate: makeCandidate(),
      runner: async () => "先检索资料，再给结论",
      minSuccessRate: 0.5,
    });
    expect(decision.promoted).toBe(true);
    expect(decision.newVersion).toBe("1.0.1");
    expect(skills.get("evidence-summary-skill")!.version).toBe("1.0.1");
    expect(skills.loadBody("evidence-summary-skill").body).toContain("v2");
  }, 30_000);

  it("证据来自被取代版本 → 证据门拒绝（旧经验不晋级）", async () => {
    const v1 = ingestion.ingestDocument({ datasetId: ds, path: "old.md", title: "旧手册", version: "1.0", content: "旧内容 12V。" });
    ingestion.ingestDocument({ datasetId: ds, path: "old.md", title: "旧手册", version: "2.0", content: "新内容 24V。" });
    void v1;
    const oldChunk = ingestion.chunksOf(
      (ingestion.latestRevision(ds, "old.md") as unknown as { id: string }) && (db.prepare("SELECT id FROM document_revisions WHERE path='old.md' AND version='1.0'").get() as { id: string }).id,
    )[0]!.id;
    void oldChunk;
    const staleChunk = db.prepare("SELECT id FROM chunks WHERE doc_revision_id = (SELECT id FROM document_revisions WHERE path='old.md' AND version='1.0') LIMIT 1").get() as { id: string };
    const svc = makeSvc(db, blobs, events, skills, ingestion, evaluation);
    const decision = await svc.evaluateAndPromote({
      evalCases,
      candidate: makeCandidate({ evidenceChunkIds: [staleChunk.id] }),
      runner: async () => "ok",
      minSuccessRate: 0.5,
    });
    expect(decision.promoted).toBe(false);
    expect(decision.rejectedReason).toContain("evidence");
  }, 30_000);

  it("安全回归：候选含禁用构造 → 拒绝", async () => {
    const svc = makeSvc(db, blobs, events, skills, ingestion, evaluation);
    const decision = await svc.evaluateAndPromote({
      evalCases,
      candidate: makeCandidate({ newBody: "用 process.env 读取密钥再汇总。" }),
      runner: async () => "ok",
      minSuccessRate: 0.5,
    });
    expect(decision.promoted).toBe(false);
    expect(decision.rejectedReason).toContain("safety");
  });

  it("候选触碰保护路径（隐藏测试/grader）→ 拒绝（A13）", async () => {
    const svc = makeSvc(db, blobs, events, skills, ingestion, evaluation);
    const decision = await svc.evaluateAndPromote({
      evalCases,
      candidate: makeCandidate({ newBody: "同时修改 hidden-tests/grader 以放宽验收。" }),
      runner: async () => "ok",
      minSuccessRate: 0.5,
    });
    expect(decision.promoted).toBe(false);
    expect(decision.rejectedReason).toContain("safety");
  });

  it("冻结验证集未达门槛 → 拒绝（冻结不可被候选修改）", async () => {
    const svc = makeSvc(db, blobs, events, skills, ingestion, evaluation);
    const decision = await svc.evaluateAndPromote({
      evalCases,
      candidate: makeCandidate(),
      runner: async () => "完全无关的输出",
      minSuccessRate: 0.5,
    });
    expect(decision.promoted).toBe(false);
    expect(decision.rejectedReason).toContain("frozen_eval");
  });

  it("并发版本变化：基线已演进 → 候选需重新提出", async () => {
    const svc = makeSvc(db, blobs, events, skills, ingestion, evaluation);
    const candidate = makeCandidate();
    // 候选提出后、评审前，技能被其他渠道更新
    skills.updateBody("evidence-summary-skill", GOOD_BODY + "\n其他渠道更新\n", "1.5.0");
    const decision = await svc.evaluateAndPromote({
      evalCases,
      candidate,
      runner: async () => "先检索资料，再给结论",
      minSuccessRate: 0.5,
    });
    expect(decision.promoted).toBe(false);
    expect(decision.rejectedReason).toContain("concurrency");
  });

  it("候选评测留痕：candidate.evaluated / promoted 可审计", async () => {
    const auditEvents = new EventStore(db);
    const svc = new CandidateService(db, blobs, auditEvents, skills, ingestion, evaluation);
    const decision = await svc.evaluateAndPromote({
      evalCases,
      candidate: makeCandidate(),
      runner: async () => "先检索资料，再给结论",
      minSuccessRate: 0.5,
    });
    expect(decision.promoted).toBe(true);
    // 候选审计流：以 candidateId 为 run_id 落事件（与业务运行账本隔离）
    const audit = auditEvents.readRange(decision.candidateId, 0, auditEvents.maxSeq(decision.candidateId));
    expect(audit.some((e) => e.type === "candidate.evaluated")).toBe(true);
    expect(audit.some((e) => e.type === "candidate.promoted")).toBe(true);
  });

  it("反思注入对照：source=none 时不注入内容", () => {
    const svc = new ReflectionService(events, blobs);
    const record = svc.analyzeFailure("run-x", {
      stage: "步骤 1",
      toolId: "read_text",
      errorText: "READ_FAILED: missing.csv 不存在",
      attemptedPath: "missing.csv",
    });
    expect(record.source).toBe("tool_error");
    const injected = svc.injectReflection(record);
    expect(injected).toContain("tool_error");
    expect(svc.injectReflection(null)).toBe("");
  });
});
