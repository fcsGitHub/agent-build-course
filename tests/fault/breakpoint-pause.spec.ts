/**
 * 故障/控制路径测试：流程图断点（run_breakpoints 表 → 边界驻留 → 恢复）。
 * 断点与手动暂停共用驻留机制；命中必须写 run.breakpoint_hit 事件（可观察），
 * 恢复后运行继续到终态，不伪装完成。
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
  dataDir = mkdtempSync(join(tmpdir(), "ag-bp-"));
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
    id: "snap_bp",
    provider: "fake",
    protocol: "fake/v1",
    endpointId: "fake",
    modelId: "fake-deterministic",
    parameters: { streamDelayMs: 40 },
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

describe("断点控制路径", () => {
  it("before_model 断点：命中驻留 + run.breakpoint_hit 事件；清除断点并 resume 后完成", async () => {
    const snapId = await seedFake();
    const rev = await coordinator.ensureCourseRevision("L05-observe-act");
    const sessionId = sessions.createSession("u", "p", {
      lessonId: "L05-observe-act",
      lessonRevision: "1.1.0",
      agentRevisionId: rev,
      modelProfileSnapshotId: snapId,
      runtimeSnapshotId: "rt",
      assetSnapshotId: "as",
      policySnapshotId: "po",
      budget: { ...DEFAULT_BUDGET, maxTurns: 6, maxWallTimeMs: 120_000 },
    });
    sessions.submitInput({
      sessionId,
      clientMessageId: "bp-cm-1",
      text: "请读取 inventory.csv 并统计库存总量",
      origin: "interactive",
    });
    coordinator.start();

    // 运行创建后立刻布置断点：第一次 before_model 边界即驻留
    let runId: string | null = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!runId) {
        const accepted = sessions.listInputs(sessionId).find((i) => i.acceptedRunId);
        if (accepted?.acceptedRunId) {
          runId = accepted.acceptedRunId;
          db.prepare("INSERT INTO run_breakpoints (run_id, target, created_at) VALUES (?, 'before_model', ?)").run(
            runId,
            new Date().toISOString(),
          );
        }
      } else {
        const run = db.prepare("SELECT state FROM runs WHERE id = ?").get(runId) as { state: string };
        if (run.state === "paused") break;
        if (["completed", "failed", "cancelled"].includes(run.state)) break; // 意外终态：退出断言
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(runId).toBeTruthy();
    let run = db.prepare("SELECT state FROM runs WHERE id = ?").get(runId!) as { state: string };
    expect(run.state).toBe("paused");

    // 事件：断点命中（target=before_model）+ 驻留（run.paused 携带 reason=breakpoint）
    const evs = events.readRange(runId!, 0, events.maxSeq(runId!));
    const hit = evs.find((e) => e.type === "run.breakpoint_hit");
    expect(hit).toBeTruthy();
    expect(hit!.summary.target).toBe("before_model");
    const paused = evs.filter((e) => e.type === "run.paused").at(-1);
    expect(paused?.summary.reason).toBe("breakpoint");

    // 清除断点 + resume：运行继续并到达真实终态
    db.prepare("DELETE FROM run_breakpoints WHERE run_id = ?").run(runId);
    db.prepare(
      "INSERT INTO run_commands (id, run_id, command, payload, actor_id, state, created_at) VALUES (?, ?, 'resume', '{}', 'test', 'pending', ?)",
    ).run(`cmd_${Date.now()}`, runId, new Date().toISOString());
    const deadline2 = Date.now() + 60_000;
    while (Date.now() < deadline2) {
      run = db.prepare("SELECT state FROM runs WHERE id = ?").get(runId!) as { state: string };
      if (["completed", "failed", "cancelled"].includes(run.state)) break;
      await new Promise((r) => setTimeout(r, 60));
    }
    coordinator.stop();
    expect(["completed", "failed", "cancelled"]).toContain(run.state);
    const finalTypes = events.readRange(runId!, 0, events.maxSeq(runId!)).map((e) => e.type);
    expect(finalTypes).toContain("run.resumed");
    rmSync(dataDir, { recursive: true, force: true });
  }, 120_000);

  it("输入携带断点：首运行创建事务内播种，turn_end 无 PUT 也驻留", async () => {
    const snapId = await seedFake();
    const rev = await coordinator.ensureCourseRevision("L05-observe-act");
    const sessionId = sessions.createSession("u", "p", {
      lessonId: "L05-observe-act",
      lessonRevision: "1.1.0",
      agentRevisionId: rev,
      modelProfileSnapshotId: snapId,
      runtimeSnapshotId: "rt",
      assetSnapshotId: "as",
      policySnapshotId: "po",
      budget: { ...DEFAULT_BUDGET, maxTurns: 6, maxWallTimeMs: 120_000 },
    });
    // 会话首个运行：没有继承来源；断点只能随输入播种，否则短运行在 PUT 到达前已完成
    sessions.submitInput({
      sessionId,
      clientMessageId: "bp-cm-3",
      text: "请读取 inventory.csv 并统计库存总量",
      origin: "interactive",
      breakpoints: ["turn_end"],
    });
    coordinator.start();

    let runId: string | null = null;
    let state = "";
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!runId) {
        runId = sessions.listInputs(sessionId).find((i) => i.acceptedRunId)?.acceptedRunId ?? null;
      } else {
        state = (db.prepare("SELECT state FROM runs WHERE id = ?").get(runId) as { state: string }).state;
        if (state === "paused" || ["completed", "failed", "cancelled"].includes(state)) break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(runId).toBeTruthy();
    expect(state).toBe("paused");
    // 播种发生在运行创建事务内
    const seeded = db.prepare("SELECT target FROM run_breakpoints WHERE run_id = ?").all(runId!) as Array<{ target: string }>;
    expect(seeded.map((r) => r.target)).toContain("turn_end");
    const evs = events.readRange(runId!, 0, events.maxSeq(runId!));
    expect(evs.find((e) => e.type === "run.breakpoint_hit")?.summary.target).toBe("turn_end");
    // turn_end 语义 = 每轮结束后：第 1 轮必须先真实执行（context.compiled 在驻留之前）
    const types = evs.map((e) => e.type);
    expect(types.indexOf("context.compiled")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("context.compiled")).toBeLessThan(types.indexOf("run.paused"));

    // 收尾：清除断点并 resume，运行到达真实终态
    db.prepare("DELETE FROM run_breakpoints WHERE run_id = ?").run(runId);
    db.prepare(
      "INSERT INTO run_commands (id, run_id, command, payload, actor_id, state, created_at) VALUES (?, ?, 'resume', '{}', 'test', 'pending', ?)",
    ).run(`cmd_${Date.now()}`, runId, new Date().toISOString());
    const deadline2 = Date.now() + 60_000;
    while (Date.now() < deadline2) {
      state = (db.prepare("SELECT state FROM runs WHERE id = ?").get(runId!) as { state: string }).state;
      if (["completed", "failed", "cancelled"].includes(state)) break;
      await new Promise((r) => setTimeout(r, 60));
    }
    coordinator.stop();
    expect(["completed", "failed", "cancelled"]).toContain(state);
    rmSync(dataDir, { recursive: true, force: true });
  }, 120_000);

  it("驻留豁免墙钟：驻留超过 maxWallTimeMs 后 resume，运行不被墙钟预算杀死", async () => {
    const snapId = await seedFake();
    const rev = await coordinator.ensureCourseRevision("L05-observe-act");
    const sessionId = sessions.createSession("u", "p", {
      lessonId: "L05-observe-act",
      lessonRevision: "1.1.0",
      agentRevisionId: rev,
      modelProfileSnapshotId: snapId,
      runtimeSnapshotId: "rt",
      assetSnapshotId: "as",
      policySnapshotId: "po",
      // 墙钟预算仅 1.2s：第 1 轮（~0.3s）内可达 turn_end；驻留 2s 即超过墙钟
      budget: { ...DEFAULT_BUDGET, maxTurns: 6, maxWallTimeMs: 1_200 },
    });
    sessions.submitInput({
      sessionId,
      clientMessageId: "bp-cm-4",
      text: "请读取 inventory.csv 并统计库存总量",
      origin: "interactive",
      breakpoints: ["turn_end"],
    });
    coordinator.start();

    let runId: string | null = null;
    let state = "";
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!runId) {
        runId = sessions.listInputs(sessionId).find((i) => i.acceptedRunId)?.acceptedRunId ?? null;
      } else {
        state = (db.prepare("SELECT state FROM runs WHERE id = ?").get(runId) as { state: string }).state;
        if (state === "paused" || ["completed", "failed", "cancelled"].includes(state)) break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(runId).toBeTruthy();
    expect(state).toBe("paused");

    // 驻留 2s（已远超 1.2s 墙钟预算）再恢复：豁免后运行应继续，而不是 budget_wall_time_exhausted
    await new Promise((r) => setTimeout(r, 2_000));
    db.prepare("DELETE FROM run_breakpoints WHERE run_id = ?").run(runId);
    db.prepare(
      "INSERT INTO run_commands (id, run_id, command, payload, actor_id, state, created_at) VALUES (?, ?, 'resume', '{}', 'test', 'pending', ?)",
    ).run(`cmd_${Date.now()}`, runId, new Date().toISOString());
    const deadline2 = Date.now() + 60_000;
    while (Date.now() < deadline2) {
      state = (db.prepare("SELECT state FROM runs WHERE id = ?").get(runId!) as { state: string }).state;
      if (["completed", "failed", "cancelled"].includes(state)) break;
      await new Promise((r) => setTimeout(r, 60));
    }
    coordinator.stop();
    expect(state).toBe("completed");
    const evs = events.readRange(runId!, 0, events.maxSeq(runId!));
    const resumed = evs.find((e) => e.type === "run.resumed");
    expect(Number(resumed?.summary.dwellMs ?? 0)).toBeGreaterThanOrEqual(1_500);
    const completed = evs.filter((e) => e.type === "run.completed").at(-1);
    expect(completed?.summary.stopReason ?? completed?.summary.reasonCode).not.toBe("budget_wall_time_exhausted");
    rmSync(dataDir, { recursive: true, force: true });
  }, 120_000);

  it("断点驻留期间 cancel：仍以 cancelled 终态结束（cancel 优先）", async () => {
    const snapId = await seedFake();
    const rev = await coordinator.ensureCourseRevision("L05-observe-act");
    const sessionId = sessions.createSession("u", "p", {
      lessonId: "L05-observe-act",
      lessonRevision: "1.1.0",
      agentRevisionId: rev,
      modelProfileSnapshotId: snapId,
      runtimeSnapshotId: "rt",
      assetSnapshotId: "as",
      policySnapshotId: "po",
      budget: { ...DEFAULT_BUDGET, maxTurns: 6, maxWallTimeMs: 120_000 },
    });
    sessions.submitInput({
      sessionId,
      clientMessageId: "bp-cm-2",
      text: "请读取 inventory.csv 并统计库存总量",
      origin: "interactive",
    });
    coordinator.start();

    let runId: string | null = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!runId) {
        const accepted = sessions.listInputs(sessionId).find((i) => i.acceptedRunId);
        if (accepted?.acceptedRunId) {
          runId = accepted.acceptedRunId;
          db.prepare("INSERT INTO run_breakpoints (run_id, target, created_at) VALUES (?, 'before_model', ?)").run(
            runId,
            new Date().toISOString(),
          );
        }
      } else {
        const run = db.prepare("SELECT state FROM runs WHERE id = ?").get(runId) as { state: string };
        if (run.state === "paused") {
          db.prepare(
            "INSERT INTO run_commands (id, run_id, command, payload, actor_id, state, created_at) VALUES (?, ?, 'cancel', '{}', 'test', 'pending', ?)",
          ).run(`cmd_${Date.now()}`, runId, new Date().toISOString());
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const deadline2 = Date.now() + 30_000;
    let state = "";
    while (Date.now() < deadline2) {
      state = (db.prepare("SELECT state FROM runs WHERE id = ?").get(runId!) as { state: string }).state;
      if (["cancelled", "completed", "failed"].includes(state)) break;
      await new Promise((r) => setTimeout(r, 60));
    }
    coordinator.stop();
    expect(state).toBe("cancelled");
    rmSync(dataDir, { recursive: true, force: true });
  }, 90_000);
});
