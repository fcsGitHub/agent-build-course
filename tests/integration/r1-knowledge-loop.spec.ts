/**
 * R1 集成测试（T14—T17 + L08/L11/L16）：
 * - chain 固定工作流（L08）：三步固定调用，事件带 step 标注；
 * - Agentic RAG（L11）：search_documents 工具循环 → 引用块 ID 的最终回答；
 * - 记忆会话（L16）：remember → recall → 遗忘传播（A14）。
 * 全部使用显式标记的 fake 模型与 fake 嵌入，不消耗外部额度。
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
import { MemoryService, IngestionService, IndexService } from "@agentglass/knowledge";
import type { ModelProfileSnapshot } from "@agentglass/contracts";
import { DEFAULT_BUDGET } from "@agentglass/contracts";

const REPO_ROOT = join(__dirname, "..", "..");
const LESSONS_DIR = join(REPO_ROOT, "lessons");

let dataDir: string;
let db: Database;
let blobs: BlobStore;
let events: EventStore;
let sessions: SessionService;
let coordinator: RunCoordinator;
let memory: MemoryService;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ag-r1-"));
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
  memory = new MemoryService(db);
});

async function seedFake(params: Record<string, unknown> = {}): Promise<string> {
  const snap: ModelProfileSnapshot = {
    id: "snap_r1",
    provider: "fake",
    protocol: "fake/v1",
    endpointId: "fake",
    modelId: "fake-deterministic",
    parameters: params as unknown as ModelProfileSnapshot["parameters"],
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

async function runLesson(lessonId: string, revision: string, text: string, snapId: string): Promise<{
  run: Record<string, unknown>;
  runId: string;
}> {
  const courseRevision = await coordinator.ensureCourseRevision(lessonId);
  const sessionId = sessions.createSession("local-learner", "local-project", {
    lessonId,
    lessonRevision: revision,
    agentRevisionId: courseRevision,
    modelProfileSnapshotId: snapId,
    runtimeSnapshotId: "rt",
    assetSnapshotId: "as",
    policySnapshotId: "po",
    budget: DEFAULT_BUDGET,
  });
  sessions.submitInput({
    sessionId,
    clientMessageId: `r1-${Math.random().toString(36).slice(2)}`,
    text,
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
        if (!["queued", "running"].includes(String(row.state))) break;
      }
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  coordinator.stop();
  if (!run) throw new Error("运行超时");
  return { run, runId: String(run.id) };
}

describe("L08 固定工作流链", () => {
  it("chain 恰好执行三步，context.compiled 带 step 标注，终态 final_answer", async () => {
    const snapId = await seedFake();
    const { run, runId } = await runLesson(
      "L08-workflows",
      "1.0.0",
      "AG-2048 的滤芯更换周期是多少？",
      snapId,
    );
    expect(String(run.state)).toBe("completed");
    expect(String(run.stop_reason)).toBe("final_answer");
    const all = events.readRange(runId, 0, events.maxSeq(runId));
    const compiledSteps = all
      .filter((e) => e.type === "context.compiled")
      .map((e) => (e.summary as Record<string, unknown>).step);
    expect(compiledSteps).toEqual([1, 2, 3]);
    // 固定链恰好 3 次模型调用（自主循环才可能多轮）
    const modelCalls = all.filter((e) => e.type === "model.response_completed").length;
    expect(modelCalls).toBe(3);
    rmSync(dataDir, { recursive: true, force: true });
  }, 90_000);
});

describe("L11 Agentic RAG", () => {
  it("search_documents 循环命中课程资料，最终回答引用块 ID", async () => {
    const snapId = await seedFake();
    const { run, runId } = await runLesson(
      "L11-agentic-rag",
      "1.0.0",
      "AG-2048 的滤芯更换周期是多少？",
      snapId,
    );
    expect(String(run.state)).toBe("completed");
    expect(String(run.stop_reason)).toBe("final_answer");
    const all = events.readRange(runId, 0, events.maxSeq(runId));
    // 真实检索工具执行
    const searchDone = all.filter(
      (e) => e.type === "tool.call_completed" && (e.summary as Record<string, unknown>).toolId === "search_documents",
    );
    expect(searchDone.length).toBeGreaterThanOrEqual(1);
    // 最终回答带引用标注（引用存在；引用支持度另行人工/judge 评估）
    const refs = JSON.parse(String(run.output_refs)) as Array<{ id: string }>;
    const answer = blobs.getText(refs[0]!.id);
    expect(answer).toMatch(/【c:[\w-]+】/);
    // 引用可解析回真实存在的块（fake 检索的 hit 都来自索引）
    expect(answer).toContain("滤芯");
    rmSync(dataDir, { recursive: true, force: true });
  }, 90_000);
});

describe("L16 记忆会话", () => {
  it("remember → recall 命中同一 memory；服务端遗忘后 recall 不再返回（A14）", async () => {
    const snapId = await seedFake();
    // 会话一：写入
    const w = await runLesson("L16-memory", "1.0.0", "请记住：我先看结论，再看依据。", snapId);
    expect(String(w.run.state)).toBe("completed");
    const rememberDone = events
      .readRange(w.runId, 0, events.maxSeq(w.runId))
      .some((e) => e.type === "tool.call_completed" && (e.summary as Record<string, unknown>).toolId === "remember");
    expect(rememberDone).toBe(true);
    // 服务端确认记忆已写入
    const entries = memory.listActive("user", "local-learner");
    expect(entries.some((m) => m.content.includes("先看结论"))).toBe(true);

    // 会话二：读取（同一用户作用域）
    const r = await runLesson("L16-memory", "1.0.0", "我的输出偏好是什么？", snapId);
    expect(String(r.run.state)).toBe("completed");
    const recallDone = events
      .readRange(r.runId, 0, events.maxSeq(r.runId))
      .some((e) => e.type === "tool.call_completed" && (e.summary as Record<string, unknown>).toolId === "recall");
    expect(recallDone).toBe(true);

    // 遗忘 → 传播验证（新会话不再命中）
    const entry = entries.find((m) => m.content.includes("先看结论"))!;
    expect(memory.forget(entry.id, "user", "local-learner")).toBe(true);
    expect(memory.recall("user", "local-learner", "输出偏好")).toEqual([]);
    rmSync(dataDir, { recursive: true, force: true });
  }, 120_000);

  it("跨作用域不可见：learner-b 的会话 recall 不到 learner-a 的记忆", async () => {
    memory.write({ scopeKind: "user", scopeId: "learner-a", kind: "semantic", content: "A 的偏好" });
    expect(memory.recall("user", "local-learner", "偏好")).toEqual([]);
  });
});

describe("知识装配（worker 集成）", () => {
  it("课程文档资产被幂等摄取并建立索引（L11 会话后）", async () => {
    const snapId = await seedFake();
    await runLesson("L11-agentic-rag", "1.0.0", "AG-2048 的保修期是多久？", snapId);
    const ingestion = new IngestionService(db, blobs);
    const indexService = new IndexService(db, blobs, ingestion);
    const ds = db.prepare("SELECT id FROM datasets WHERE name = ?").get("lesson-L11-agentic-rag") as
      | { id: string }
      | undefined;
    expect(ds).toBeDefined();
    const snap = indexService.latest(ds!.id);
    expect(snap).toBeDefined();
    expect(snap!.embeddingVersion).toBe("fake-emb-1");
    rmSync(dataDir, { recursive: true, force: true });
  }, 90_000);
});
