/**
 * 故障/预算测试：审批驻留豁免墙钟预算。
 * L21 这类审批课中，人类思考批准的时间可能远超 maxWallTimeMs；若驻留时长计入墙钟，
 * 批准后的下一次预算扣减会以 budget_wall_time_exhausted 杀死运行——与 gate 驻留
 * （断点/手动暂停）同一语义：人类检视时间不消耗执行预算。
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
  dataDir = mkdtempSync(join(tmpdir(), "ag-ap-"));
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
    id: "snap_ap",
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

describe("审批驻留豁免墙钟", () => {
  it("审批驻留超过 maxWallTimeMs 后批准，运行不被墙钟预算杀死且写入真实发生", async () => {
    const snapId = await seedFake();
    const rev = await coordinator.ensureCourseRevision("L21-approvals");
    const sessionId = sessions.createSession("local-learner", "local-project", {
      lessonId: "L21-approvals",
      lessonRevision: "1.0.0",
      agentRevisionId: rev,
      modelProfileSnapshotId: snapId,
      runtimeSnapshotId: "rt",
      assetSnapshotId: "as",
      policySnapshotId: "po",
      // 墙钟预算 1.5s：第 1 轮（~0.3s）可达审批驻留；驻留 2s 即超过墙钟
      budget: { ...DEFAULT_BUDGET, maxWallTimeMs: 1_500 },
    });
    sessions.submitInput({
      sessionId,
      clientMessageId: "ap-cm-1",
      text: "请把本次整理结论写入 outputs/report.md。",
      origin: "interactive",
    });
    coordinator.start();

    let runId = "";
    let approvalId = "";
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const accepted = sessions.listInputs(sessionId).find((i) => i.acceptedRunId);
      if (accepted?.acceptedRunId) {
        runId = accepted.acceptedRunId!;
        const row = db.prepare("SELECT state FROM runs WHERE id = ?").get(runId) as { state: string };
        if (row.state === "awaiting_approval") {
          const req = events
            .readRange(runId, 0, events.maxSeq(runId))
            .find((e) => e.type === "approval.requested");
          approvalId = String(req!.summary.approvalId);
          break;
        }
        if (["completed", "failed", "cancelled"].includes(row.state)) break;
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    expect(runId).toBeTruthy();
    expect(approvalId).toBeTruthy();

    // 驻留 2s（已远超 1.5s 墙钟预算）再批准：豁免后运行应完成，而不是 budget_wall_time_exhausted
    await new Promise((r) => setTimeout(r, 2_000));
    coordinator["approvals"].decide(approvalId, "grant", "instructor");
    const deadline2 = Date.now() + 60_000;
    let finalState = "";
    while (Date.now() < deadline2) {
      const row = db.prepare("SELECT state FROM runs WHERE id = ?").get(runId) as { state: string };
      if (!["queued", "running", "awaiting_approval"].includes(row.state)) {
        finalState = row.state;
        break;
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    coordinator.stop();
    expect(finalState).toBe("completed");
    const all = events.readRange(runId, 0, events.maxSeq(runId));
    expect(all.some((e) => e.type === "approval.granted")).toBe(true);
    expect(all.some((e) => e.type === "tool.call_completed" && e.summary.toolId === "write_file")).toBe(true);
    const completed = all.filter((e) => e.type === "run.completed").at(-1);
    expect(completed?.summary.stopReason ?? completed?.summary.reasonCode).not.toBe("budget_wall_time_exhausted");
    rmSync(dataDir, { recursive: true, force: true });
  }, 120_000);
});
