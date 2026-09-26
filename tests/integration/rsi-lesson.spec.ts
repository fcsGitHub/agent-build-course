/**
 * 集成测试：L45 有界 RSI 课程经协调器全链路执行（fake 提供方，forceAnswer 固定回答）。
 * fake 模型的变异输出没有 <prompt> 标记 → 两代均 INVALID_MUTATION 拒绝；
 * 运行仍以 completed 终态结束（拒绝不是失败），事件链完整可回放。
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

let dataDir: string;
let db: Database;
let events: EventStore;
let blobs: BlobStore;
let sessions: SessionService;
let coordinator: RunCoordinator;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ag-rsi-int-"));
  db = openDatabase({ file: ":memory:" });
  blobs = new BlobStore(db, join(dataDir, "blobs"));
  events = new EventStore(db);
  sessions = new SessionService(db, blobs);
  coordinator = new RunCoordinator({
    db,
    dataDir,
    lessons: new LessonRegistry(join(REPO_ROOT, "lessons")),
    pollIntervalMs: 60,
  });
});

async function seedFake(): Promise<string> {
  const snap: ModelProfileSnapshot = {
    id: "snap_rsi_int",
    provider: "fake",
    protocol: "fake/v1",
    endpointId: "fake",
    modelId: "fake-deterministic",
    parameters: { forceAnswer: "固定回答：每季度检查。库存 42，充足。" },
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

describe("L45 有界 RSI 课程（协调器全链路）", () => {
  it("变异无标记被拒、基线评估完成、以 completed 终态收尾且事件可回放", async () => {    const snapId = await seedFake();
    const rev = await coordinator.ensureCourseRevision("L45-rsi-bounded");
    const sessionId = sessions.createSession("u", "p", {
      lessonId: "L45-rsi-bounded",
      lessonRevision: "1.0.0",
      agentRevisionId: rev,
      modelProfileSnapshotId: snapId,
      runtimeSnapshotId: "rt",
      assetSnapshotId: "as",
      policySnapshotId: "po",
      budget: { ...DEFAULT_BUDGET, maxTurns: 8, maxModelCalls: 10, maxWallTimeMs: 120_000 },
    });
    sessions.submitInput({
      sessionId,
      clientMessageId: "rsi-int-1",
      text: "改进目标：让 worker 回答包含任务要求的关键词。",
      origin: "interactive",
    });
    coordinator.start();

    let runId = "";
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const accepted = sessions.listInputs(sessionId).find((i) => i.acceptedRunId);
      if (accepted?.acceptedRunId) {
        runId = accepted.acceptedRunId;
        const row = db.prepare("SELECT state FROM runs WHERE id = ?").get(runId) as { state: string };
        if (["completed", "failed", "cancelled"].includes(row.state)) break;
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    coordinator.stop();
    expect(runId).toBeTruthy();
    const run = db.prepare("SELECT state, stop_reason FROM runs WHERE id = ?").get(runId) as Record<string, unknown>;
    expect(run.state).toBe("completed");

    const evs = events.readRange(runId, 0, events.maxSeq(runId));
    const types = evs.map((e) => e.type);
    // 事件链：v0 基线评估 → 每代 变异(无效)→拒绝 → 代完成 → 报告
    expect(types).toContain("rsi.generation_started");
    expect(types).toContain("candidate.evaluated"); // v0 基线在冻结集上得分
    expect(types.filter((t) => t === "rsi.generation_started").length).toBe(2);
    expect(
      evs.filter((e) => e.type === "candidate.rejected").some((e) =>
        String(e.summary.reason ?? "").startsWith("INVALID_MUTATION"),
      ),
    ).toBe(true);
    expect(types.filter((t) => t === "rsi.generation_completed").length).toBe(2);
    expect(types).toContain("run.completed");
    expect(types).not.toContain("run.failed");
    rmSync(dataDir, { recursive: true, force: true });
  }, 120_000);
});

describe("L45 断点（继承 → 驻留 → 恢复；确定性时序）", () => {
  it("同会话新运行继承断点并在 before_model 驻留；清除断点后不再驻留", async () => {
    const snapId = await seedFake();
    const rev = await coordinator.ensureCourseRevision("L45-rsi-bounded");
    const sessionId = sessions.createSession("u", "p", {
      lessonId: "L45-rsi-bounded",
      lessonRevision: "1.0.0",
      agentRevisionId: rev,
      modelProfileSnapshotId: snapId,
      runtimeSnapshotId: "rt",
      assetSnapshotId: "as",
      policySnapshotId: "po",
      budget: { ...DEFAULT_BUDGET, maxTurns: 8, maxModelCalls: 10, maxWallTimeMs: 120_000 },
    });
    sessions.submitInput({ sessionId, clientMessageId: "bp-r0", text: "基线运行", origin: "interactive" });
    coordinator.start();

    // 第一条：无断点，正常完成（为继承准备"上一个运行"）
    const deadline1 = Date.now() + 60_000;
    let runId = "";
    while (Date.now() < deadline1) {
      const latest = db.prepare("SELECT id, state FROM runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1").get(sessionId) as { id: string; state: string };
      if (latest && ["completed", "failed", "cancelled"].includes(latest.state)) {
        runId = latest.id;
        break;
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    expect(runId).toBeTruthy();
    expect((db.prepare("SELECT state FROM runs WHERE id = ?").get(runId) as { state: string }).state).toBe("completed");

    // 为上一运行布置断点（armed）→ 下一条输入创建的运行在接纳事务内继承（无竞态）
    db.prepare("INSERT OR IGNORE INTO run_breakpoints (run_id, target, created_at) VALUES (?, 'before_model', ?)").run(
      runId,
      new Date().toISOString(),
    );
    sessions.submitInput({ sessionId, clientMessageId: "bp-r1", text: "应驻留的运行", origin: "interactive" });

    const deadline2 = Date.now() + 30_000;
    let runId2 = "";
    let state2 = "";
    while (Date.now() < deadline2) {
      const latest = db.prepare("SELECT id, state FROM runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1").get(sessionId) as { id: string; state: string };
      if (latest && latest.id !== runId) {
        runId2 = latest.id;
        state2 = latest.state;
        if (state2 === "paused" || ["completed", "failed", "cancelled"].includes(state2)) break;
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    expect(runId2).toBeTruthy();
    expect(state2).toBe("paused");
    const evs2 = events.readRange(runId2, 0, events.maxSeq(runId2));
    expect(evs2.map((e) => e.type)).toContain("run.breakpoint_hit");
    expect(evs2.find((e) => e.type === "run.paused")?.summary.reason).toBe("breakpoint");
    expect(
      (db.prepare("SELECT target FROM run_breakpoints WHERE run_id = ?").all(runId2) as Array<{ target: string }>).map((r) => r.target),
    ).toContain("before_model");

    // 清除断点 + resume → 完成
    db.prepare("DELETE FROM run_breakpoints WHERE run_id = ?").run(runId2);
    db.prepare(
      "INSERT INTO run_commands (id, run_id, command, payload, actor_id, state, created_at) VALUES (?, ?, 'resume', '{}', 'test', 'pending', ?)",
    ).run(`cmd_${Date.now()}`, runId2, new Date().toISOString());
    const deadline3 = Date.now() + 60_000;
    while (Date.now() < deadline3) {
      state2 = (db.prepare("SELECT state FROM runs WHERE id = ?").get(runId2) as { state: string }).state;
      if (["completed", "failed", "cancelled"].includes(state2)) break;
      await new Promise((r) => setTimeout(r, 60));
    }
    expect(state2).toBe("completed");

    // 断点已清除 → 第三条输入不再驻留（清除会跨运行传播）
    sessions.submitInput({ sessionId, clientMessageId: "bp-r2", text: "不应驻留", origin: "interactive" });
    const deadline4 = Date.now() + 60_000;
    let runId3 = "";
    let state3 = "";
    while (Date.now() < deadline4) {
      const latest = db.prepare("SELECT id, state FROM runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1").get(sessionId) as { id: string; state: string };
      if (latest && latest.id !== runId2) {
        runId3 = latest.id;
        state3 = latest.state;
        if (["completed", "failed", "cancelled"].includes(state3)) break;
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    coordinator.stop();
    expect(state3).toBe("completed");
    expect(events.readRange(runId3, 0, events.maxSeq(runId3)).map((e) => e.type)).not.toContain("run.breakpoint_hit");
    rmSync(dataDir, { recursive: true, force: true });
  }, 180_000);
});
