/**
 * T40 集成：修改参与执行的循环判断函数后，新版本真实运行（A15/A18）。
 * 同时验证：策略要求"永远继续"也无法突破宿主硬预算（A17/A26）。
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
import { AgentDraftService, CodeBuildService } from "@agentglass/code-lab";
import type { SafetyRunner } from "@agentglass/code-lab";
import { GuestProcessHost } from "@agentglass/learner-runtime";
import type { ModelProfileSnapshot } from "@agentglass/contracts";
import { DEFAULT_BUDGET } from "@agentglass/contracts";

const REPO_ROOT = join(__dirname, "..", "..");
const LESSONS_DIR = join(REPO_ROOT, "lessons");

let dataDir: string;
let db: Database;
let blobs: BlobStore;
let events: EventStore;
let lessons: LessonRegistry;
let sessions: SessionService;
let coordinator: RunCoordinator;
let drafts: AgentDraftService;
let builds: CodeBuildService;

const safetyRunner: SafetyRunner = async (bundlePath, slots) => {
  const host = new GuestProcessHost(bundlePath, { callTimeoutMs: 1500 });
  const failures: Array<{ id: string; detail: string }> = [];
  try {
    for (const slot of slots) {
      for (const sample of [
        { completedTurns: 0, hasNewObservation: true, finalAnswerReady: false },
        { completedTurns: 99, hasNewObservation: true, finalAnswerReady: false },
        { completedTurns: 1, hasNewObservation: false, finalAnswerReady: true },
      ]) {
        const r = await host.call({ slot, arg: sample });
        if (!r.ok) failures.push({ id: slot, detail: r.error ?? "失败" });
        else if (typeof r.value !== "boolean") failures.push({ id: slot, detail: "非 boolean" });
      }
    }
  } finally {
    await host.dispose();
  }
  return { passed: failures.length === 0, failures };
};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ag-edit-"));
  db = openDatabase({ file: ":memory:" });
  blobs = new BlobStore(db, join(dataDir, "blobs"));
  events = new EventStore(db);
  lessons = new LessonRegistry(LESSONS_DIR);
  sessions = new SessionService(db, blobs);
  coordinator = new RunCoordinator({ db, dataDir, lessons, pollIntervalMs: 80 });
  drafts = new AgentDraftService(db, blobs);
  builds = new CodeBuildService(db, blobs);
});

async function makeFakeSnapshot(): Promise<string> {
  const snap: ModelProfileSnapshot = {
    id: "snap_fake",
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
    "INSERT INTO model_profile_snapshots (id, profile_id, snapshot, created_at) VALUES (?, 'p', ?, ?)",
  ).run(snap.id, JSON.stringify(snap), new Date().toISOString());
  return snap.id;
}

async function validateDraftWithBody(body: string): Promise<string> {
  const policy = lessons.editPolicy("L05-observe-act")!;
  const baseline = lessons.baselineFiles("L05-observe-act");
  const draft = drafts.createDraft({
    ownerId: "local-learner",
    projectId: "local-project",
    lessonId: "L05-observe-act",
    lessonVersion: "L05-observe-act@1.1.0",
    baseAgentRevisionId: "base",
    baseFiles: baseline,
    editPolicyDigest: policy.digest,
  });
  const files = JSON.parse(JSON.stringify(draft.files)) as Record<string, string>;
  files["lesson-agent/loop-policy.ts"] = body;
  const saved = drafts.save({ draftId: draft.id, expectedRevision: draft.revision, files, editPolicyDigest: policy.digest });
  const outcome = await builds.validate({
    draftId: saved.id,
    draftRevision: saved.revision,
    files: saved.files,
    baseFiles: baseline,
    policy,
    baseManifestId: "base",
    extensionSlots: { loop_continue: "lesson-agent/loop-policy.ts#shouldContinue" },
    safetyRunner,
    outputDir: dataDir,
  });
  if (!outcome.revisionId) {
    throw new Error("构建未通过: " + JSON.stringify(outcome.report.safetyGates));
  }
  return outcome.revisionId;
}

async function runLessonWithRevision(
  revisionId: string,
  overrides?: Partial<typeof DEFAULT_BUDGET>,
): Promise<{ run: Record<string, unknown>; runId: string }> {
  const snapId = await makeFakeSnapshot();
  const budget = { ...DEFAULT_BUDGET, ...overrides };
  const sessionId = sessions.createSession("local-learner", "local-project", {
    lessonId: "L05-observe-act",
    lessonRevision: "1.1.0",
    agentRevisionId: revisionId,
    modelProfileSnapshotId: snapId,
    runtimeSnapshotId: "rt",
    assetSnapshotId: "as",
    policySnapshotId: "po",
    budget,
  });
  sessions.submitInput({
    sessionId,
    clientMessageId: `cm-${Math.random().toString(36).slice(2)}`,
    text: "请读取实验目录中的 inventory.csv，统计所有品类的库存总量，并说明你的计算依据。",
    origin: "interactive",
  });
  coordinator.start();
  const deadline = Date.now() + 60_000;
  let run: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    const inputs = sessions.listInputs(sessionId);
    const accepted = inputs.find((i) => i.acceptedRunId != null);
    if (accepted) {
      const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(accepted.acceptedRunId!) as
        | Record<string, unknown>
        | undefined;
      if (row) {
        run = row;
        if (!["queued", "running"].includes(String(row.state))) break;
      }
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  coordinator.stop();
  if (!run) throw new Error("运行超时");
  return { run, runId: String(run.id) };
}

describe("T40：修改代码的真实执行", () => {
  it("基线与变体运行各自绑定正确版本，事件记录策略调用（A15/A18）", async () => {
    const baselineBody = lessons.baselineFiles("L05-observe-act")["lesson-agent/loop-policy.ts"]!;
    const variantBody = baselineBody.replace("< 3", "< 5");
    expect(variantBody).not.toBe(baselineBody);
    const variantRevision = await validateDraftWithBody(variantBody);

    const { run, runId } = await runLessonWithRevision(variantRevision);
    expect(String(run.agent_revision_id)).toBe(variantRevision);
    expect(String(run.state)).toBe("completed");

    const all = events.readRange(runId, 0, events.maxSeq(runId));
    const types = all.map((e) => e.type);
    expect(types).toContain("agent.revision_bound");
    expect(types).toContain("code.policy_invoked");
    expect(types).toContain("policy.stop_decision");

    // 变体绑定证据：revision_bound 摘要指向变体
    const bound = all.find((e) => e.type === "agent.revision_bound");
    expect((bound!.summary as Record<string, unknown>).agentRevisionId).toBe(variantRevision);

    // 最终回答仍引用真实计算值（变体只改了停止策略，不改变工具事实）
    const refs = JSON.parse(String(run.output_refs)) as Array<{ id: string }>;
    expect(blobs.getText(refs[0]!.id)).toContain("222");

    rmSync(dataDir, { recursive: true, force: true });
  }, 90_000);

  it("学生策略要求永远继续时，宿主硬预算仍然生效（A17）", async () => {
    const baselineBody = lessons.baselineFiles("L05-observe-act")["lesson-agent/loop-policy.ts"]!;
    const greedyBody = baselineBody.replace(
      /return s\.hasNewObservation[^;]*;/,
      "return true;",
    );
    const greedyRevision = await validateDraftWithBody(greedyBody);
    // 小预算（2 轮）：贪婪策略在第 3 轮请求继续时必须被宿主硬边界拦截
    const { run, runId } = await runLessonWithRevision(greedyRevision, { maxTurns: 2, maxModelCalls: 2 });

    // 硬预算 maxTurns=2：即使策略总说"继续"，运行也要被宿主终止
    expect(String(run.stop_reason)).toBe("budget_turns_exhausted");
    const all = events.readRange(runId, 0, events.maxSeq(runId));
    const reserved = all.filter((e) => e.type === "model.request_dispatched").length;
    expect(reserved).toBeLessThanOrEqual(2);
    // 被预算终止不等于任务成功
    expect(String(run.state)).toBe("completed");
    expect(String(run.stop_reason)).not.toBe("final_answer");

    rmSync(dataDir, { recursive: true, force: true });
  }, 90_000);
});
