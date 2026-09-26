/**
 * T39/T40 构建与执行隔离（验收 A15/A17/A23）。
 * - 安全门槛失败的构建不能执行（越权/忙等）；
 * - 教学行为断言失败可以探索试跑（显式标记）；
 * - 学生策略要求"永远继续"也无法突破宿主硬预算。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Database } from "@agentglass/db";
import { BlobStore } from "@agentglass/events";
import { AgentDraftService, CodeBuildService } from "@agentglass/code-lab";
import type { SafetyRunner } from "@agentglass/code-lab";
import { GuestProcessHost } from "@agentglass/learner-runtime";
import { LessonRegistry } from "@agentglass/lessons";

const REPO_ROOT = join(__dirname, "..", "..");
const LESSONS_DIR = join(REPO_ROOT, "lessons");

let dataDir: string;
let db: Database;
let blobs: BlobStore;
let drafts: AgentDraftService;
let builds: CodeBuildService;
let lessons: LessonRegistry;

/** 平台安全运行器：与 apps/api 相同语义（隔离 guest + 硬超时） */
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
        if (!r.ok) failures.push({ id: `${slot}`, detail: r.error ?? "调用失败" });
        else if (typeof r.value !== "boolean") {
          failures.push({ id: `${slot}`, detail: `返回类型必须是 boolean，实际 ${typeof r.value}` });
        }
      }
    }
  } finally {
    await host.dispose();
  }
  return { passed: failures.length === 0, failures };
};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ag-build-"));
  db = openDatabase({ file: ":memory:" });
  blobs = new BlobStore(db, join(dataDir, "blobs"));
  lessons = new LessonRegistry(LESSONS_DIR);
  drafts = new AgentDraftService(db, blobs);
  builds = new CodeBuildService(db, blobs);
});

function baseline(): Record<string, string> {
  return lessons.baselineFiles("L05-observe-act");
}

async function makeDraftWithBody(body: string): Promise<{ draftId: string; draftRevision: number; files: Record<string, string> }> {
  const policy = lessons.editPolicy("L05-observe-act")!;
  const draft = drafts.createDraft({
    ownerId: "local-learner",
    projectId: "local-project",
    lessonId: "L05-observe-act",
    lessonVersion: "L05-observe-act@1.1.0",
    baseAgentRevisionId: "base",
    baseFiles: baseline(),
    editPolicyDigest: policy.digest,
  });
  const files = JSON.parse(JSON.stringify(draft.files)) as Record<string, string>;
  files["lesson-agent/loop-policy.ts"] = body;
  const saved = drafts.save({ draftId: draft.id, expectedRevision: draft.revision, files, editPolicyDigest: policy.digest });
  return { draftId: saved.id, draftRevision: saved.revision, files: saved.files };
}

function policy() {
  return lessons.editPolicy("L05-observe-act")!;
}

describe("隔离构建门槛", () => {
  it("合法修改（<3 → <5）通过全部安全门槛并产生不可变 revision（A15）", async () => {
    const { draftId, draftRevision, files } = await makeDraftWithBody(
      baseline()["lesson-agent/loop-policy.ts"]!.replace("< 3", "< 5"),
    );
    const outcome = await builds.validate({
      draftId,
      draftRevision,
      files,
      baseFiles: baseline(),
      policy: policy(),
      baseManifestId: "base",
      extensionSlots: { loop_continue: "lesson-agent/loop-policy.ts#shouldContinue" },
      safetyRunner,
      outputDir: dataDir,
    });
    expect(outcome.status).toBe("passed");
    expect(outcome.report.safetyGates).toEqual({
      scope: "passed",
      syntax: "passed",
      types: "passed",
      contracts: "passed",
      isolation: "passed",
    });
    expect(outcome.revisionId).toBeTruthy();
    expect(outcome.bundle).toBeDefined();
    // 不可变 revision 已登记，运行使用该构建
    const row = db.prepare("SELECT * FROM agent_revisions WHERE id = ?").get(outcome.revisionId!) as Record<string, unknown>;
    expect(row.author_kind).toBe("human");
    // A15：可执行变体确实改变行为（<5 在第 4 轮仍继续）
    const host = new GuestProcessHost(outcome.bundle!.path, { callTimeoutMs: 2000 });
    const at4 = await host.call({ slot: "loop_continue", arg: { completedTurns: 4, hasNewObservation: true, finalAnswerReady: false } });
    expect(at4.value).toBe(true);
    await host.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }, 60_000);

  it("忙等代码被安全测试硬超时终止，构建被拒绝（A17）", async () => {
    // 保留接口声明（函数体外的内容必须与基线一致），只替换函数体
    const busyFile = baseline()["lesson-agent/loop-policy.ts"]!.replace(
      "  return s.hasNewObservation && !s.finalAnswerReady && s.completedTurns < 3;",
      "  const start = Date.now();\n  while (Date.now() - start < 60_000) {}\n  return true;",
    );
    const { draftId, draftRevision, files } = await makeDraftWithBody(busyFile);
    const outcome = await builds.validate({
      draftId,
      draftRevision,
      files,
      baseFiles: baseline(),
      policy: policy(),
      baseManifestId: "base",
      safetyRunner,
      outputDir: dataDir,
    });
    expect(outcome.status).toBe("safety_failed");
    expect(outcome.report.safetyGates.isolation).toBe("failed");
    expect(outcome.bundle).toBeUndefined();
    expect(outcome.revisionId).toBeUndefined();
    rmSync(dataDir, { recursive: true, force: true });
  }, 60_000);

  it("语法/类型错误被拒绝且诊断可读", async () => {
    const { draftId, draftRevision, files } = await makeDraftWithBody(
      "export function shouldContinue(s: LoopObservation): boolean {\n  return s.hasNewObservation && n< ;\n}",
    );
    const outcome = await builds.validate({
      draftId,
      draftRevision,
      files,
      baseFiles: baseline(),
      policy: policy(),
      baseManifestId: "base",
      safetyRunner,
      outputDir: dataDir,
    });
    expect(outcome.status).toBe("safety_failed");
    const diag = JSON.stringify(outcome.report.safetyGates);
    expect(diag).toContain("failed");
    rmSync(dataDir, { recursive: true, force: true });
  }, 60_000);
});
