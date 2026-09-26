/**
 * R4c 集成测试（T28 课程化 L33 / T29 有界递归 L35 / L34 同预算四架构对照 / L41 毕业全链）。
 * - L33：A2A 远程 agent（card 发现 → a2a_research 委派 → artifact 为待验证信息）；
 * - L35：有界递归（递归树事件、深度上限、节点用量、预算原子预留）；
 * - L34：同一任务文本在四种架构（loop/chain/graph/parallel）下运行，对照字段全部可从账本取证；
 * - L41：毕业链 = 读取 → 审批写入 → 引用证据作答，全部事件可回放。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
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
  dataDir = mkdtempSync(join(tmpdir(), "ag-r4c-"));
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

interface RunOutcome {
  run: Record<string, unknown>;
  runId: string;
}

async function runLessonUntilTerminal(
  lessonId: string,
  revision: string,
  text: string,
  opts?: { budgetOverride?: Partial<typeof DEFAULT_BUDGET>; grantApproval?: boolean },
): Promise<RunOutcome> {
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
    budget: { ...DEFAULT_BUDGET, ...opts?.budgetOverride },
  });
  sessions.submitInput({
    sessionId,
    clientMessageId: `r4c-${Math.random().toString(36).slice(2)}`,
    text,
    origin: "interactive",
  });
  coordinator.start();
  const deadline = Date.now() + 90_000;
  let run: Record<string, unknown> | undefined;
  let granted = false;
  while (Date.now() < deadline) {
    const accepted = sessions.listInputs(sessionId).find((i) => i.acceptedRunId);
    if (accepted) {
      const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(accepted.acceptedRunId!) as
        | Record<string, unknown>
        | undefined;
      if (row) {
        run = row;
        const rid = String(row.id);
        if (String(row.state) === "awaiting_approval" && !granted && opts?.grantApproval) {
          const req = events.readRange(rid, 0, events.maxSeq(rid)).find((e) => e.type === "approval.requested");
          if (req) {
            const approvalId = String((req.summary as Record<string, unknown>).approvalId);
            coordinator["approvals"].decide(approvalId, "grant", "instructor");
            granted = true;
          }
        }
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

function allEvents(runId: string) {
  return events.readRange(runId, 0, events.maxSeq(runId));
}

describe("T28 课程化：L33 A2A 远程 Agent", () => {
  it("card 发现 → a2a_research 委派 → artifact 引用并标注待验证", async () => {
    const { run, runId } = await runLessonUntilTerminal(
      "L33-a2a-remote",
      "1.0.0",
      "请委派远程 Agent 总结 AG-2048 的核心规格，并说明该结果的验证状态。",
    );
    expect(String(run.state)).toBe("completed");
    const all = allEvents(runId);

    // 1) card 发现事件：agent 名与本地桥说明
    const conn = all.find((e) => e.type === "a2a.agent_connected");
    expect(conn).toBeDefined();
    expect((conn!.summary as Record<string, unknown>).agentName).toBe("agentglass-course-agent");

    // 2) 真实 A2A message/send：tool.call_completed（输出摘要在 payload blob 中）
    const call = all.find(
      (e) => e.type === "tool.call_completed" && (e.summary as Record<string, unknown>).toolId === "a2a_research",
    );
    expect(call).toBeDefined();
    expect((call!.summary as Record<string, unknown>).status).toBe("succeeded");
    const outJson = blobs.getText((call!.payloadRef as { id: string }).id);
    const out = JSON.parse(outJson) as { taskId: string; state: string; text: string };
    expect(out.taskId).toMatch(/^task_/);
    expect(out.state).toBe("completed");
    expect(out.text).toContain("远程 Agent 回答");

    // 3) 最终回答引用 artifact 且显式标注待验证（不是当作已审查证据）
    const refs = JSON.parse(String(run.output_refs)) as Array<{ id: string }>;
    const finalText = blobs.getText(refs[0]!.id);
    expect(finalText).toContain("待验证");

    // 4) 事件账本连续（证据完整性）
    const seqs = all.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  }, 90_000);
});

describe("T29 有界递归：L35", () => {
  it("递归树执行：深度 ≤ 上限、节点带用量、预算原子预留、完整覆盖", async () => {
    const { run, runId } = await runLessonUntilTerminal(
      "L35-bounded-recursion",
      "1.0.0",
      "请对 long-manual.md 执行有界递归汇总，提取全部维护要点。",
      { budgetOverride: { maxModelCalls: 10 } },
    );
    expect(String(run.state)).toBe("completed");
    const all = allEvents(runId);

    const started = all.filter((e) => e.type === "recursion.node_started");
    const completed = all.filter((e) => e.type === "recursion.node_completed");
    expect(started.length).toBeGreaterThanOrEqual(5);
    expect(completed.length).toBe(started.length);

    // 深度不超过 manifest 上限 3；叶子完成事件带真实 usage
    for (const e of completed) {
      const s = e.summary as Record<string, unknown>;
      expect(Number(s.depth)).toBeLessThanOrEqual(3);
      expect(Number(s.depth)).toBeGreaterThanOrEqual(1);
      if (s.status === "succeeded") {
        expect((s.usage as Record<string, unknown>).outputTokens).toBeGreaterThan(0);
      }
    }
    // 预算充足 → 无 BUDGET_EXCEEDED（诚实场景：完整覆盖）
    const denied = completed.filter(
      (e) => String((e.summary as Record<string, unknown>).reason ?? "").includes("BUDGET_EXCEEDED"),
    );
    expect(denied).toHaveLength(0);
    const done = all.find((e) => e.type === "run.completed");
    expect(Number((done!.summary as Record<string, unknown>).maxDepthReached)).toBeLessThanOrEqual(3);
    expect(Number((done!.summary as Record<string, unknown>).budgetDenied)).toBe(0);

    // 外部化：根文本在 blob，不在事件 summary 内联
    const startedRoot = all.find((e) => e.type === "run.started");
    expect((startedRoot!.summary as Record<string, unknown>).rootChars).toBeGreaterThan(2000);
    const rootRef = String((startedRoot!.summary as Record<string, unknown>).rootRef);
    expect(blobs.getText(rootRef)).toContain("维护要点1");

    // 最终输出是合并后的要点汇总
    const refs = JSON.parse(String(run.output_refs)) as Array<{ id: string }>;
    expect(blobs.getText(refs[0]!.id).length).toBeGreaterThan(20);
  }, 90_000);
});

describe("L34 同预算四架构对照", () => {
  it("同一任务文本在 loop/chain/graph/parallel 下运行，费用/停止原因可配对取证", async () => {
    const task = "请总结 AG-2048 的维护要点。";
    const lessons: Array<[string, string]> = [
      ["L34-architecture-compare", "1.0.0"], // 单 Agent 循环
      ["L08-workflows", "1.0.0"], // 固定工作流链
      ["L20-state-graph", "1.0.0"], // 状态图
      ["L31-parallel-workers", "1.0.0"], // 多 Agent 并行
    ];
    const records: Array<{ lesson: string; modelCalls: number; stopReason: string }> = [];
    for (const [lessonId, revision] of lessons) {
      const { run, runId } = await runLessonUntilTerminal(lessonId, revision, task, {
        budgetOverride: { maxModelCalls: 8 },
      });
      expect(String(run.state)).toBe("completed");
      const evs = allEvents(runId);
      // 调用数：标准运行看 model.response_completed；multi-agent 的子调用看 agent.result_received
      const modelCalls =
        evs.filter((e) => e.type === "model.response_completed").length +
        evs.filter((e) => e.type === "agent.result_received" && (e.summary as Record<string, unknown>).status === "succeeded").length;
      expect(modelCalls).toBeGreaterThan(0);
      records.push({ lesson: lessonId, modelCalls, stopReason: String(run.stop_reason) });
    }
    // 对照矩阵：每个架构都有可比较的费用与停止原因（配对比较的证据基础）
    expect(records).toHaveLength(4);
    for (const r of records) {
      expect(r.modelCalls).toBeGreaterThan(0);
      expect(r.stopReason).toBe("final_answer");
    }
    // parallel（3 worker）的模型调用数 > loop（1 次即可回答）——拓扑成本差异真实可见
    const loop = records.find((r) => r.lesson === "L34-architecture-compare")!;
    const parallel = records.find((r) => r.lesson === "L31-parallel-workers")!;
    expect(parallel.modelCalls).toBeGreaterThan(loop.modelCalls);
  }, 120_000);
});

describe("L41 毕业全链", () => {
  it("读取 → 审批驻留 → 批准写入真实文件 → 引用证据作答", async () => {
    const { run, runId } = await runLessonUntilTerminal(
      "L41-capstone",
      "1.0.0",
      "请读取 research-notes.md 核对要点，统计库存总量并把结论文本写入 outputs/summary.md。",
      { grantApproval: true },
    );
    expect(String(run.state)).toBe("completed");
    const all = allEvents(runId);

    // 证据链：读取真实发生
    const read = all.find(
      (e) => e.type === "tool.call_completed" && (e.summary as Record<string, unknown>).toolId === "read_text",
    );
    expect(read).toBeDefined();

    // 高影响写入：先审批请求/批准，后真实写入（时间顺序可查）
    const approvalReq = all.findIndex((e) => e.type === "approval.requested");
    const approvalGrant = all.findIndex((e) => e.type === "approval.granted");
    const writeCall = all.findIndex(
      (e) => e.type === "tool.call_completed" && (e.summary as Record<string, unknown>).toolId === "write_file",
    );
    expect(approvalReq).toBeGreaterThanOrEqual(0);
    expect(approvalGrant).toBeGreaterThan(approvalReq);
    expect(writeCall).toBeGreaterThan(approvalGrant);

    // 写入真实发生（run 专属工作区）
    const wsFile = join(dataDir, "workspaces", runId, "outputs", "summary.md");
    expect(existsSync(wsFile)).toBe(true);
    expect(readFileSync(wsFile, "utf8").length).toBeGreaterThan(0);

    // 最终回答引用了读取的证据
    const refs = JSON.parse(String(run.output_refs)) as Array<{ id: string }>;
    expect(blobs.getText(refs[0]!.id).length).toBeGreaterThan(10);
    expect(String(run.stop_reason)).toBe("final_answer");
  }, 120_000);
});
