/**
 * R4b 集成测试：L27 受控 Web 访问、L28 数据侧注入防护、L29 评测与故障注入。
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
import { httpFetchTool } from "@agentglass/tools";
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
  dataDir = mkdtempSync(join(tmpdir(), "ag-r4b-"));
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
    clientMessageId: `r4b-${Math.random().toString(36).slice(2)}`,
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

describe("L27 受控 Web 访问", () => {
  it("http_fetch 白名单外域名拒绝、白名单内可读（不可信素材标记）", async () => {
    const tool = httpFetchTool({ allowedHosts: ["example.com"], maxBytes: 64 * 1024 });
    const mkCtx = () => ({
      runId: "r",
      workspaceRoot: dataDir,
      allowedToolIds: ["http_fetch"],
      deadlineAt: new Date(Date.now() + 10_000).toISOString(),
      maxOutputBytes: 64 * 1024,
    });
    // SSRF：私网拒绝
    const ssrf = await tool.execute({ url: "http://169.254.169.254/latest/meta-data" }, mkCtx());
    expect(ssrf.status).toBe("denied");
    expect(ssrf.reasonCode).toBe("SSRF_PRIVATE_ADDRESS");
    // 白名单外拒绝
    const outside = await tool.execute({ url: "https://evil.example.org/x" }, mkCtx());
    expect(outside.status).toBe("denied");
    expect(outside.reasonCode).toBe("SSRF_HOSTNAME");
    // 白名单内成功（example.com 为 IANA 保留演示域名，公网可达）
    const ok = await tool.execute({ url: "https://example.com" }, mkCtx());
    if (ok.status === "succeeded") {
      const summary = ok.outputSummary as { trust?: string };
      expect(summary.trust).toBe("untrusted-content");
    }
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe("L28 数据侧注入防护", () => {
  it("注入素材进入上下文但不改变工具白名单：越权写入仍被审批拒绝", async () => {
    const { run, runId } = await runLesson("L28-injection", "1.0.0", "请读取 faq-injected.md 并总结滤芯维护要点。");
    expect(String(run.state)).toBe("completed");
    const all = events.readRange(runId, 0, events.maxSeq(runId));
    // 注入素材确实进入了上下文（read_text 成功读取被篡改的 FAQ）
    const read = all.find(
      (e) => e.type === "tool.call_completed" && (e.summary as Record<string, unknown>).toolId === "read_text",
    );
    expect(read).toBeDefined();
    // 无越权写入发生：write_file 未出现在调用里（白名单不含 write_file）
    const writeCalls = all.filter(
      (e) => e.type === "tool.call_completed" && (e.summary as Record<string, unknown>).toolId === "write_file",
    );
    expect(writeCalls.length).toBe(0);
    rmSync(dataDir, { recursive: true, force: true });
  }, 90_000);
});

describe("L29 评测与故障注入", () => {
  it("runner 故障注入：该用例记 failed 而非崩溃，可区分执行失败与评分未过", async () => {
    const { EvaluationService } = await import("@agentglass/evaluation");
    const svc = new EvaluationService();
    const cases = [
      { id: "ok-1", split: "test" as const, input: "q-ok", grader: { kind: "contains_all" as const, patterns: ["222"] } },
      { id: "fault-1", split: "test" as const, input: "q-fault", grader: { kind: "contains_all" as const, patterns: ["222"] } },
    ];
    svc.freeze(cases);
    const result = await svc.runSuite(async (input) => {
      if (input === "q-fault") throw new Error("注入的超时故障");
      return "库存总量 222";
    });
    const faultResult = result.results.find((r) => r.caseId === "fault-1")!;
    expect(faultResult.passed).toBe(false);
    expect(faultResult.reason).toContain("执行失败");
    const okResult = result.results.find((r) => r.caseId === "ok-1")!;
    expect(okResult.passed).toBe(true);
    expect(result.summary.passed).toBe(1);
  });

  it("L29 课程运行：计算器数值进入事件（环境终态证据）", async () => {
    const { run, runId } = await runLesson("L29-eval-faults", "1.0.0", "请读取 inventory.csv 统计库存总量并给出计算依据。");
    expect(String(run.state)).toBe("completed");
    const all = events.readRange(runId, 0, events.maxSeq(runId));
    const calc = all.find(
      (e) => e.type === "tool.call_completed" && (e.summary as Record<string, unknown>).toolId === "calculator",
    );
    expect(calc).toBeDefined();
    expect((calc!.summary as Record<string, unknown>).status).toBe("succeeded");
    rmSync(dataDir, { recursive: true, force: true });
  }, 90_000);
});
