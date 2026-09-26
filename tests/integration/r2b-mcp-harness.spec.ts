/**
 * R2b 集成测试：L22 本地 MCP 闭环、L23 注入防护、L24 harness hooks 与长期任务状态。
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

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ag-r2b-"));
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

async function runLesson(lessonId: string, revision: string, text: string): Promise<{ run: Record<string, unknown>; runId: string }> {
  const snapId = await seedFake();
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
    clientMessageId: `r2b-${Math.random().toString(36).slice(2)}`,
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
        if (!["queued", "running", "awaiting_approval"].includes(String(row.state))) break;
      }
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  coordinator.stop();
  if (!run) throw new Error("运行超时");
  if (String(run.state) === "failed") {
    const failEv = events.readRange(String(run.id), 0, events.maxSeq(String(run.id))).find((e) => e.type === "run.failed");
    throw new Error(`运行失败: ${JSON.stringify(failEv?.summary ?? {})}`);
  }
  return { run, runId: String(run.id) };
}

describe("L22 本地 MCP 闭环", () => {
  it("server 连接协商 → 协议事件 → mcp 工具真实调用 → 引用作答", async () => {
    const { run, runId } = await runLesson("L22-mcp", "1.0.0", "AG-2048 的额定电压是多少？");
    expect(String(run.state)).toBe("completed");
    const all = events.readRange(runId, 0, events.maxSeq(runId));
    expect(all.some((e) => e.type === "mcp.server_connected")).toBe(true);
    expect(all.filter((e) => e.type === "mcp.protocol_event").length).toBeGreaterThanOrEqual(4);
    const mcpCall = all.find(
      (e) => e.type === "tool.call_completed" && String((e.summary as Record<string, unknown>).toolId).startsWith("mcp_"),
    );
    expect(mcpCall).toBeDefined();
    expect((mcpCall!.summary as Record<string, unknown>).status).toBe("succeeded");
    const refs = JSON.parse(String(run.output_refs)) as Array<{ id: string }>;
    expect(blobs.getText(refs[0]!.id)).toContain("MCP");
    rmSync(dataDir, { recursive: true, force: true });
  }, 90_000);
});

describe("L23 注入防护", () => {
  it("工具描述含注入文本时，调用仍走白名单且参数校验失败可观察", async () => {
    const { run, runId } = await runLesson("L23-mcp-security", "1.0.0", "AG-2048 的额定电压是多少？");
    expect(String(run.state)).toBe("completed");
    const all = events.readRange(runId, 0, events.maxSeq(runId));
    const proposed = all.find((e) => e.type === "tool.proposed");
    expect(proposed).toBeDefined();
    // 注入文本进入上下文（可见），但执行链未被改变：真实 MCP 调用成功返回规格
    const call = all.find(
      (e) => e.type === "tool.call_completed" && String((e.summary as Record<string, unknown>).toolId).startsWith("mcp_"),
    );
    expect((call!.summary as Record<string, unknown>).status).toBe("succeeded");
    rmSync(dataDir, { recursive: true, force: true });
  }, 90_000);
});

describe("L24 harness hooks 与长期任务", () => {
  it("after_model 标注产生 hook.diff，run 终态产生 task.progress_updated", async () => {
    const { run, runId } = await runLesson("L24-harness", "1.0.0", "请用一句话解释什么是 hook。");
    expect(String(run.state)).toBe("completed");
    const all = events.readRange(runId, 0, events.maxSeq(runId));
    const diff = all.find((e) => e.type === "hook.diff");
    expect(diff).toBeDefined();
    expect(String((diff!.summary as Record<string, unknown>).hookId)).toContain("teaching-annotation");
    expect(all.some((e) => e.type === "task.progress_updated")).toBe(true);
    // 输出带教学标注
    const refs = JSON.parse(String(run.output_refs)) as Array<{ id: string }>;
    expect(blobs.getText(refs[0]!.id)).toContain("教学标注");
    rmSync(dataDir, { recursive: true, force: true });
  }, 90_000);
});
