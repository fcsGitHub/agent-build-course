/**
 * 纵向集成冒烟：L05 观察与行动循环。
 * 用户明确输入 → fake 模型（明确标记）→ 真实工具（read_text/calculator）→
 * 隔离 guest 中的 shouldContinue → 事件账本 → run.completed → 最终回答引用真实计算值。
 * 对应验收：A01（无模型不能实时运行）、A02（事件绑定 run）、A10（核心路径测试）。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Database } from "@agentglass/db";
import { BlobStore, EventStore } from "@agentglass/events";
import { LessonRegistry } from "@agentglass/lessons";
import { lintAll } from "@agentglass/lessons";
import { SessionService } from "@agentglass/conversation";
import { RunCoordinator } from "@agentglass/worker";
import type { ModelProfileSnapshot } from "@agentglass/contracts";
import { DEFAULT_BUDGET } from "@agentglass/contracts";

const REPO_ROOT = join(__dirname, "..", "..");
const LESSONS_DIR = join(REPO_ROOT, "lessons");

let dataDir: string;
let db: Database;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "agentglass-test-"));
  db = openDatabase({ file: ":memory:" });
});

describe("课程 linter（T34）", () => {
  it("L00—L07 全部通过发布检查（无 error 级问题）", () => {
    const lessons = new LessonRegistry(LESSONS_DIR);
    const result = lintAll(lessons);
    const errors = result.issues.filter((i) => i.severity === "error");
    expect(errors, JSON.stringify(result.issues, null, 2)).toHaveLength(0);
  });

  it("课程目录累计 46 门（R5：阶段 IX 前沿与 RSI）", () => {
    const lessons = new LessonRegistry(LESSONS_DIR);
    const ids = lessons.catalog().map((c) => c.id);
    expect(ids).toEqual([
      "L00-first-call",
      "L01-prompt",
      "L02-structured-output",
      "L03-streaming",
      "L04-tools",
      "L05-observe-act",
      "L06-stop-conditions",
      "L07-parallel-reads",
      "L08-workflows",
      "L09-ingest",
      "L10-retrieval",
      "L11-agentic-rag",
      "L12-wiki",
      "L13-knowledge-compare",
      "L14-context-budget",
      "L15-compaction",
      "L16-memory",
      "L17-memory-kinds",
      "L18-skills",
      "L19-plan-graph",
      "L20-state-graph",
      "L21-approvals",
      "L22-mcp",
      "L23-mcp-security",
      "L24-harness",
      "L25-cli-web",
      "L26-sandbox-fix",
      "L27-controlled-web",
      "L28-injection",
      "L29-eval-faults",
      "L30-topologies",
      "L31-parallel-workers",
      "L32-blackboard-conflict",
      "L33-a2a-remote",
      "L34-architecture-compare",
      "L35-bounded-recursion",
      "L36-reflect-retry",
      "L37-experience-wiki",
      "L38-prompt-candidate",
      "L39-skill-promotion",
      "L40-training-interface",
      "L41-capstone",
      "L42-frontier-survey",
      "L43-context-engineering",
      "L44-deep-research",
      "L45-rsi-bounded",
    ]);
  });
});

describe("L05 纵向闭环（fake 模型显式标记）", () => {
  it("用户输入 → 真实工具 → 循环 → 事件账本 → 完整证据", async () => {
    const blobs = new BlobStore(db, join(dataDir, "blobs"));
    const events = new EventStore(db);
    const lessons = new LessonRegistry(LESSONS_DIR);
    const sessions = new SessionService(db, blobs);

    // 1) 注册 fake 模型配置（明确 provider=fake）
    const snap: ModelProfileSnapshot = {
      id: "snap_fake_1",
      provider: "fake",
      protocol: "fake/v1",
      endpointId: "fake://local",
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
      "INSERT INTO model_profile_snapshots (id, profile_id, snapshot, created_at) VALUES (?, 'profile-fake', ?, ?)",
    ).run(snap.id, JSON.stringify(snap), new Date().toISOString());

    // 2) 会话（绑定课程基线 revision）
    const coordinator = new RunCoordinator({ db, dataDir, lessons });
    const courseRevision = await coordinator.ensureCourseRevision("L05-observe-act");
    const sessionId = sessions.createSession("local-learner", "local-project", {
      lessonId: "L05-observe-act",
      lessonRevision: "1.1.0",
      agentRevisionId: courseRevision,
      modelProfileSnapshotId: snap.id,
      runtimeSnapshotId: "runtime-reference@1",
      assetSnapshotId: "asset-test",
      policySnapshotId: "policy-test",
      budget: DEFAULT_BUDGET,
    });

    // 3) 用户明确提交（不是自动发送）
    const { submission, duplicate } = sessions.submitInput({
      sessionId,
      clientMessageId: "client-msg-0001",
      text: "请读取实验目录中的 inventory.csv，统计所有品类的库存总量，并说明你的计算依据。",
      origin: "interactive",
    });
    expect(duplicate).toBe(false);
    expect(submission.status).toBe("queued");

    // 4) 运行到终态
    coordinator.start();
    const deadline = Date.now() + 60_000;
    let run: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      const inputs = sessions.listInputs(sessionId);
      const accepted = inputs.find((i) => i.id === submission.id);
      const runId = accepted?.acceptedRunId;
      if (runId) {
        const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
          | Record<string, unknown>
          | undefined;
        if (row) {
          run = row;
          if (!["queued", "running"].includes(String(run.state))) break;
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    coordinator.stop();
    expect(run).toBeDefined();
    expect(String(run!.state)).toBe("completed");
    expect(String(run!.stop_reason)).toBe("final_answer");

    // 5) 事件证据
    const runId = String(run!.id);
    const allEvents = events.readRange(runId, 0, events.maxSeq(runId));
    const types = allEvents.map((e) => e.type);
    expect(types).toContain("input.accepted");
    expect(types).toContain("run.created");
    expect(types).toContain("context.compiled");
    expect(types).toContain("model.request_prepared");
    expect(types).toContain("model.request_dispatched");
    expect(types).toContain("model.response_completed");
    expect(types).toContain("tool.proposed");
    expect(types).toContain("tool.validated");
    expect(types).toContain("tool.call_completed");
    expect(types).toContain("effect.prepared");
    expect(types).toContain("effect.succeeded");
    expect(types).toContain("policy.stop_decision");
    expect(types).toContain("checkpoint.committed");
    expect(types).toContain("run.completed");

    // 6) (run_id, seq) 连续且唯一（A02 的账本基础）
    const seqs = allEvents.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));

    // 7) 计算器结果进入最终回答（sum = 120+45+8+32+17 = 222）
    const calcEvents = allEvents.filter((e) => e.type === "tool.call_completed" && (e.summary as Record<string, unknown>).toolId === "calculator");
    expect(calcEvents.length).toBeGreaterThan(0);
    const refs = JSON.parse(String(run!.output_refs)) as Array<{ id: string }>;
    const finalText = blobs.getText(refs[0]!.id);
    expect(finalText).toContain("222");
    expect(finalText.length).toBeGreaterThan(10);

    // 8) fake 模型在运行证据中显式可见（不得冒充真实模型）
    const prepared = allEvents.find((e) => e.type === "model.request_prepared");
    expect((prepared!.summary as Record<string, unknown>).provider).toBe("fake");

    // 8b) 上下文组装逐项决策可检索（前端检视器：选入/排除原因）
    const compiledEv = allEvents.find((e) => e.type === "context.compiled");
    const decisionsRef = String((compiledEv!.summary as Record<string, unknown>).itemDecisionsRef ?? "");
    expect(decisionsRef.length).toBeGreaterThan(0);
    const decisions = blobs.getJson<Array<{ id: string; selected: boolean; decision: string }>>(decisionsRef);
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.some((d) => d.selected)).toBe(true);

    // 9) 幂等：同键同文重复提交不产生第二个 run
    const dup = sessions.submitInput({
      sessionId,
      clientMessageId: "client-msg-0001",
      text: "请读取实验目录中的 inventory.csv，统计所有品类的库存总量，并说明你的计算依据。",
      origin: "interactive",
    });
    expect(dup.duplicate).toBe(true);

    rmSync(dataDir, { recursive: true, force: true });
  }, 90_000);

  it("未配置模型时不能发起实时运行（A01）", async () => {
    const blobs = new BlobStore(db, join(dataDir, "blobs"));
    const lessons = new LessonRegistry(LESSONS_DIR);
    const sessions = new SessionService(db, blobs);
    const coordinator = new RunCoordinator({ db, dataDir, lessons });
    const courseRevision = await coordinator.ensureCourseRevision("L00-first-call");
    const sessionId = sessions.createSession("local-learner", "local-project", {
      lessonId: "L00-first-call",
      lessonRevision: "1.0.0",
      agentRevisionId: courseRevision,
      modelProfileSnapshotId: "snap-unconfigured",
      runtimeSnapshotId: "runtime-reference@1",
      assetSnapshotId: "asset-test",
      policySnapshotId: "policy-test",
      budget: DEFAULT_BUDGET,
    });
    sessions.submitInput({
      sessionId,
      clientMessageId: "client-msg-a01",
      text: "hello",
      origin: "interactive",
    });
    coordinator.start();
    await new Promise((r) => setTimeout(r, 800));
    coordinator.stop();
    // 运行从未创建：未配置模型时不能发起标为实时的运行
    const runs = db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
    expect(runs.n).toBe(0);
    rmSync(dataDir, { recursive: true, force: true });
  });
});
