/**
 * 故障测试：运行取消与暂停恢复路径（A06 的控制面部分）。
 * 参考循环在安全边界响应控制命令；取消有明确终态，不伪装成功。
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
  dataDir = mkdtempSync(join(tmpdir(), "ag-fault-"));
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
    id: "snap_fault",
    provider: "fake",
    protocol: "fake/v1",
    endpointId: "fake",
    modelId: "fake-deterministic",
    parameters: { streamDelayMs: 60 },
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

describe("控制命令", () => {
  it("运行中取消：到达安全边界后以 cancelled 终态结束，不伪装完成", async () => {
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
      clientMessageId: "fault-cm-1",
      text: "请读取 inventory.csv 并统计库存总量",
      origin: "interactive",
    });
    coordinator.start();

    // 等运行进入 running 后立刻取消
    let runId: string | null = null;
    const deadline = Date.now() + 30_000;
    let cancelSent = false;
    while (Date.now() < deadline) {
      if (!runId) {
        const accepted = sessions.listInputs(sessionId).find((i) => i.acceptedRunId);
        if (accepted) {
          runId = accepted.acceptedRunId;
          db.prepare(
            "INSERT INTO run_commands (id, run_id, command, payload, actor_id, state, created_at) VALUES (?, ?, 'cancel', '{}', 'test', 'pending', ?)",
          ).run(`cmd_${Date.now()}`, runId, new Date().toISOString());
          cancelSent = true;
        }
      } else {
        const run = db.prepare("SELECT state FROM runs WHERE id = ?").get(runId) as { state: string };
        if (["cancelled", "completed", "failed"].includes(run.state)) {
          expect(run.state).toBe("cancelled");
          break;
        }
      }
      void cancelSent;
      await new Promise((r) => setTimeout(r, 60));
    }
    coordinator.stop();
    expect(runId).toBeTruthy();
    const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId!) as Record<string, unknown>;
    expect(String(run.state)).toBe("cancelled");
    // 取消事件存在且无 run.completed
    const types = events.readRange(runId!, 0, events.maxSeq(runId!)).map((e) => e.type);
    expect(types).toContain("run.cancelled");
    expect(types).not.toContain("run.completed");
    rmSync(dataDir, { recursive: true, force: true });
  }, 60_000);

  it("取消已接纳输入需单独取消运行：撤回只对排队输入有效", async () => {
    const snapId = await seedFake();
    const rev = await coordinator.ensureCourseRevision("L00-first-call");
    const sessionId = sessions.createSession("u", "p", {
      lessonId: "L00-first-call",
      lessonRevision: "1.0.0",
      agentRevisionId: rev,
      modelProfileSnapshotId: snapId,
      runtimeSnapshotId: "rt",
      assetSnapshotId: "as",
      policySnapshotId: "po",
      budget: DEFAULT_BUDGET,
    });
    const sub1 = sessions.submitInput({ sessionId, clientMessageId: "cancel-1", text: "hi", origin: "interactive" });
    const sub2 = sessions.submitInput({ sessionId, clientMessageId: "cancel-2", text: "second", origin: "interactive" });
    // 未接纳前可撤回
    expect(sessions.cancelInput(sessionId, sub2.submission.id)).toBe(true);
    expect(sessions.cancelInput(sessionId, sub1.submission.id)).toBe(true);
    // 已撤回的输入不再被接纳，运行永不创建
    coordinator.start();
    await new Promise((r) => setTimeout(r, 600));
    coordinator.stop();
    const runs = db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
    expect(runs.n).toBe(0);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("运行终态后 outbox 行被标记已发布：积压计数只反映活动运行，事件表读取不受影响", async () => {
    const snapId = await seedFake();
    const rev = await coordinator.ensureCourseRevision("L00-first-call");
    const sessionId = sessions.createSession("u", "p", {
      lessonId: "L00-first-call",
      lessonRevision: "1.0.0",
      agentRevisionId: rev,
      modelProfileSnapshotId: snapId,
      runtimeSnapshotId: "rt",
      assetSnapshotId: "as",
      policySnapshotId: "po",
      budget: DEFAULT_BUDGET,
    });
    sessions.submitInput({ sessionId, clientMessageId: "ob-1", text: "hi", origin: "interactive" });
    coordinator.start();
    let runId = "";
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const accepted = sessions.listInputs(sessionId).find((i) => i.acceptedRunId);
      if (accepted?.acceptedRunId) {
        runId = accepted.acceptedRunId;
        const row = db.prepare("SELECT state FROM runs WHERE id = ?").get(runId) as { state: string };
        if (["completed", "failed", "cancelled"].includes(row.state)) break;
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    coordinator.stop();
    expect(runId).toBeTruthy();
    // 终态后该运行的全部 outbox 行已发布：积压计数回落；事件表照常可读（回放不受影响）
    expect(events.unpublishedCount()).toBe(0);
    const types = events.readRange(runId, 0, events.maxSeq(runId)).map((e) => e.type);
    expect(types).toContain("run.completed");
    rmSync(dataDir, { recursive: true, force: true });
  });
});
