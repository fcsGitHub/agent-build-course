/**
 * R2 集成测试：L18 技能渐进加载、L19/L20 图运行、L21 审批驻留流（A07/A11 相邻面）。
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
import { SkillRegistry } from "@agentglass/skills";
import { MemoryService } from "@agentglass/knowledge";
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
let skills: SkillRegistry;
let memory: MemoryService;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ag-r2-"));
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
  skills = new SkillRegistry(db, blobs);
  memory = new MemoryService(db);
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

async function runLesson(lessonId: string, revision: string, text: string): Promise<{
  run: Record<string, unknown>;
  runId: string;
}> {
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
    clientMessageId: `r2-${Math.random().toString(36).slice(2)}`,
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
    const failEv = events
      .readRange(String(run.id), 0, events.maxSeq(String(run.id)))
      .find((e) => e.type === "run.failed");
    throw new Error(`运行失败: ${JSON.stringify(failEv?.summary ?? {})}`);
  }
  return { run, runId: String(run.id) };
}

describe("T18 技能（L18）", () => {
  it("渐进加载：元信息 → 正文；脚本执行被拒绝（未授权）", async () => {
    const skill = skills.installFromDir(join(LESSONS_DIR, "L18-skills", "..", "..", "skills", "evidence-summary-skill"));
    expect(skill.slug).toBe("evidence-summary-skill");
    // 第一层：元信息
    const meta = skills.listMeta([skill.slug]);
    expect(meta[0]!.description).toContain("证据");
    // 第二层：正文
    const body = skills.loadBody(skill.slug);
    expect(body.body).toContain("search_documents");
    // 第三层：脚本执行未授权
    expect(() => skills.executeScript(skill.slug, "verify_citations.py")).toThrow(/NOT_AUTHORIZED/);
    // 未安装技能读取失败
    expect(() => skills.loadBody("not-installed")).toThrow(/SKILL_NOT_INSTALLED/);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("L18 会话：load_skill 工具加载正文（skill.loaded 证据）", async () => {
    const { run, runId } = await runLesson(
      "L18-skills",
      "1.0.0",
      "请加载 evidence-summary-skill 技能。",
    );
    expect(String(run.state)).toBe("completed");
    const all = events.readRange(runId, 0, events.maxSeq(runId));
    const loaded = all.some(
      (e) =>
        e.type === "tool.call_completed" &&
        (e.summary as Record<string, unknown>).toolId === "load_skill",
    );
    expect(loaded).toBe(true);
    // skill.loaded 证据事件（worker 桥接）
    const skillLoadedEvent = all.find((e) => e.type === "skill.loaded");
    expect(skillLoadedEvent).toBeDefined();
    rmSync(dataDir, { recursive: true, force: true });
  }, 90_000);
});

describe("T19 图运行（L19/L20）", () => {
  it("L19 计划图按节点顺序执行并终止，事件带 graph 标注", async () => {
    const { run, runId } = await runLesson(
      "L19-plan-graph",
      "1.0.0",
      "AG-2048 的保修政策是什么？",
    );
    expect(String(run.state)).toBe("completed");
    expect(String(run.stop_reason)).toBe("final_answer");
    const all = events.readRange(runId, 0, events.maxSeq(runId));
    const nodeOrder = all
      .filter((e) => e.type === "graph.node_started")
      .map((e) => (e.summary as Record<string, unknown>).nodeId);
    expect(nodeOrder).toEqual(["plan", "search", "answer"]);
    // search 是工具节点：真实工具执行发生
    const toolExec = all.some((e) => e.type === "tool.call_completed");
    expect(toolExec).toBe(true);
    rmSync(dataDir, { recursive: true, force: true });
  }, 90_000);

  it("L20 访问上限：图必然终止（有限循环）", async () => {
    const { run, runId } = await runLesson("L20-state-graph", "1.0.0", "保修政策是什么？");
    expect(String(run.state)).toBe("completed");
    const all = events.readRange(runId, 0, events.maxSeq(runId));
    const gatherStarts = all.filter(
      (e) => e.type === "graph.node_started" && (e.summary as Record<string, unknown>).nodeId === "gather",
    ).length;
    expect(gatherStarts).toBeLessThanOrEqual(2); // maxNodeVisits=2
    rmSync(dataDir, { recursive: true, force: true });
  }, 90_000);
});

describe("T20 审批驻留（L21）", () => {
  it("写入前暂停（awaiting_approval）→ 批准 → 写入真实发生", async () => {
    const snapId = await seedFake();
    const courseRevision = await coordinator.ensureCourseRevision("L21-approvals");
    const sessionId = sessions.createSession("local-learner", "local-project", {
      lessonId: "L21-approvals",
      lessonRevision: "1.0.0",
      agentRevisionId: courseRevision,
      modelProfileSnapshotId: snapId,
      runtimeSnapshotId: "rt",
      assetSnapshotId: "as",
      policySnapshotId: "po",
      budget: DEFAULT_BUDGET,
    });
    sessions.submitInput({
      sessionId,
      clientMessageId: "r2-l21",
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
          approvalId = String((req!.summary as Record<string, unknown>).approvalId);
          break;
        }
        if (["completed", "failed", "cancelled"].includes(row.state)) break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(runId).toBeTruthy();
    expect(approvalId).toBeTruthy();

    // 批准 → 恢复
    coordinator["approvals"].decide(approvalId, "grant", "instructor");
    const deadline2 = Date.now() + 60_000;
    let finalState = "";
    while (Date.now() < deadline2) {
      const row = db.prepare("SELECT state FROM runs WHERE id = ?").get(runId) as { state: string };
      if (!["running", "awaiting_approval", "queued"].includes(row.state)) {
        finalState = row.state;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    coordinator.stop();
    expect(finalState).toBe("completed");
    const all = events.readRange(runId, 0, events.maxSeq(runId));
    expect(all.some((e) => e.type === "approval.requested")).toBe(true);
    expect(all.some((e) => e.type === "approval.granted")).toBe(true);
    expect(
      all.some((e) => e.type === "tool.call_completed" && (e.summary as Record<string, unknown>).toolId === "write_file"),
    ).toBe(true);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("审批驻留不阻塞其他会话：L21 等待决策期间，另一会话输入照常接纳并完成（队头阻塞回归）", async () => {
    const snapId = await seedFake();
    const revL21 = await coordinator.ensureCourseRevision("L21-approvals");
    const revL05 = await coordinator.ensureCourseRevision("L05-observe-act");
    const mk = (lessonId: string, revision: string, agentRevisionId: string): string =>
      sessions.createSession("local-learner", "local-project", {
        lessonId,
        lessonRevision: revision,
        agentRevisionId,
        modelProfileSnapshotId: snapId,
        runtimeSnapshotId: "rt",
        assetSnapshotId: "as",
        policySnapshotId: "po",
        budget: DEFAULT_BUDGET,
      });
    const sessionA = mk("L21-approvals", "1.0.0", revL21);
    const sessionB = mk("L05-observe-act", "1.1.0", revL05);
    sessions.submitInput({ sessionId: sessionA, clientMessageId: "hol-a", text: "请把本次整理结论写入 outputs/report.md。", origin: "interactive" });
    coordinator.start();

    // A 进入审批驻留
    let runA = "";
    let approvalId = "";
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const accepted = sessions.listInputs(sessionA).find((i) => i.acceptedRunId);
      if (accepted?.acceptedRunId) {
        runA = accepted.acceptedRunId!;
        const row = db.prepare("SELECT state FROM runs WHERE id = ?").get(runA) as { state: string };
        if (row.state === "awaiting_approval") {
          const req = events.readRange(runA, 0, events.maxSeq(runA)).find((e) => e.type === "approval.requested");
          approvalId = String((req!.summary as Record<string, unknown>).approvalId);
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    expect(approvalId).toBeTruthy();

    // 关键断言：A 驻留期间，B 的输入被接纳并完成（修复前 tick 被审批等待卡死，B 永远排队）
    sessions.submitInput({ sessionId: sessionB, clientMessageId: "hol-b", text: "请读取实验目录中的 inventory.csv，统计各品类的库存总量，并说明你的计算依据。", origin: "interactive" });
    let runB = "";
    let stateB = "";
    const deadline2 = Date.now() + 60_000;
    while (Date.now() < deadline2) {
      const accepted = sessions.listInputs(sessionB).find((i) => i.acceptedRunId);
      if (accepted?.acceptedRunId) {
        runB = accepted.acceptedRunId!;
        const row = db.prepare("SELECT state FROM runs WHERE id = ?").get(runB) as { state: string };
        if (["completed", "failed", "cancelled"].includes(row.state)) {
          stateB = row.state;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    const stateA = (db.prepare("SELECT state FROM runs WHERE id = ?").get(runA) as { state: string }).state;
    expect(stateB).toBe("completed"); // B 在 A 未获决策时独立完成
    expect(stateA).toBe("awaiting_approval"); // A 仍诚实驻留，未被静默推进

    // 协调器不停机：决策后 A 照常恢复完成（waitDecision 驻留循环自行观察到 granted）
    coordinator["approvals"].decide(approvalId, "grant", "instructor");
    let finalA = "";
    const deadline3 = Date.now() + 60_000;
    while (Date.now() < deadline3) {
      const row = db.prepare("SELECT state FROM runs WHERE id = ?").get(runA) as { state: string };
      if (["completed", "failed", "cancelled"].includes(row.state)) {
        finalA = row.state;
        break;
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    coordinator.stop();
    expect(finalA).toBe("completed");
    const allA = events.readRange(runA, 0, events.maxSeq(runA));
    expect(allA.some((e) => e.type === "approval.granted")).toBe(true);

    // 终态运行不接受控制命令（防僵尸状态）
    db.prepare("INSERT INTO run_commands (id, run_id, command, actor_id, state, created_at) VALUES (?, ?, 'pause', 'local-learner', 'pending', ?)").run(
      `cmd_${Math.random().toString(36).slice(2, 8)}`,
      runA,
      new Date().toISOString(),
    );
    db.prepare("INSERT INTO run_commands (id, run_id, command, actor_id, state, created_at) VALUES (?, ?, 'cancel', 'local-learner', 'pending', ?)").run(
      `cmd_${Math.random().toString(36).slice(2, 8)}`,
      runA,
      new Date().toISOString(),
    );
    coordinator.start();
    await new Promise((r) => setTimeout(r, 600));
    coordinator.stop();
    const stateAfter = (db.prepare("SELECT state FROM runs WHERE id = ?").get(runA) as { state: string }).state;
    expect(stateAfter).toBe("completed");
    rmSync(dataDir, { recursive: true, force: true });
  });
});