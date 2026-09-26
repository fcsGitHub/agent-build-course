/**
 * 集成测试：课程输入预算收紧时的上下文排除决策（T13/§10.2）。
 * 课程 maxInputTokens 是输入侧上限，不应再扣输出/安全预留（否则余量为负，
 * 收紧课退化为只剩系统提示，排除原因出现「预算余量 -3708」这类不可读文本）。
 * 模型上下文窗口为上限时才扣预留（输入与输出共享窗口空间）。
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
  dataDir = mkdtempSync(join(tmpdir(), "ag-cb-"));
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

describe("课程输入预算的排除决策", () => {
  it("收紧 maxInputTokens：余量为课程预算本身（正数），排除原因可读", async () => {
    const snap: ModelProfileSnapshot = {
      id: "snap_cb",
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
    const rev = await coordinator.ensureCourseRevision("L14-context-budget");
    const sessionId = sessions.createSession("u", "p", {
      lessonId: "L14-context-budget",
      lessonRevision: "1.0.0",
      agentRevisionId: rev,
      modelProfileSnapshotId: snap.id,
      runtimeSnapshotId: "rt",
      assetSnapshotId: "as",
      policySnapshotId: "po",
      budget: { ...DEFAULT_BUDGET, maxTurns: 4, maxWallTimeMs: 120_000, maxInputTokens: 900, maxOutputTokens: 600 },
    });
    // 单条 ~1486 token 的大消息：超过 900 的课程输入预算，应被整体排除且原因可读
    sessions.submitInput({
      sessionId,
      clientMessageId: "cb-1",
      text: "这是一段用于填充上下文预算的背景材料。".repeat(120),
      origin: "interactive",
    });
    coordinator.start();
    let runId: string | null = null;
    let state = "";
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (!runId) {
        runId = sessions.listInputs(sessionId).find((i) => i.acceptedRunId)?.acceptedRunId ?? null;
      } else {
        state = (db.prepare("SELECT state FROM runs WHERE id = ?").get(runId) as { state: string }).state;
        if (["completed", "failed", "cancelled"].includes(state)) break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    coordinator.stop();
    expect(runId).toBeTruthy();
    expect(state).toBe("completed");

    const compiled = events
      .readRange(runId!, 0, events.maxSeq(runId!))
      .find((e) => e.type === "context.compiled");
    expect(compiled).toBeTruthy();
    const summary = compiled!.summary as Record<string, unknown>;
    expect(Number(summary.excluded)).toBeGreaterThan(0);
    const decisions = blobs.getJson<Array<Record<string, unknown>>>(String(summary.itemDecisionsRef));
    const excluded = decisions.filter((d) => !d.selected);
    expect(excluded.length).toBeGreaterThan(0);
    for (const d of excluded) {
      const reason = String(d.decisionReason ?? "");
      // 余量 = 课程输入预算 900（不再扣输出/安全预留；不得出现负余量）
      expect(reason).toContain("900");
      expect(reason).not.toMatch(/余量 -/);
    }
    // 系统提示仍始终保留（host 规则）
    const policy = decisions.find((d) => d.kind === "policy");
    expect(policy?.selected).toBe(true);
    rmSync(dataDir, { recursive: true, force: true });
  }, 90_000);
});
