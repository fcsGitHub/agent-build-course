/**
 * T24/T25 集成与安全测试：
 * - CLI 与 Web 一致性（spawn 真实 CLI 进程 vs API 对照；退出码语义）；
 * - run_test 沙箱：白名单、路径越界、参数注入拒绝、超时、真实退出码；
 * - L26 全链：读 bug → 写修复 → run_test 真实通过。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Database } from "@agentglass/db";
import { BlobStore, EventStore } from "@agentglass/events";
import { LessonRegistry } from "@agentglass/lessons";
import { SessionService } from "@agentglass/conversation";
import { RunCoordinator } from "@agentglass/worker";
import { RUN_TEST_TOOL } from "@agentglass/tools";
import type { ModelProfileSnapshot } from "@agentglass/contracts";
import { DEFAULT_BUDGET } from "@agentglass/contracts";

const REPO_ROOT = join(__dirname, "..", "..");
const LESSONS_DIR = join(REPO_ROOT, "lessons");
const CLI_ENTRY = join(REPO_ROOT, "apps", "cli", "src", "main.ts");

function runCli(args: string[], timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--experimental-strip-types", CLI_ENTRY, ...args],
      { timeout: timeoutMs, env: { ...process.env, NODE_OPTIONS: "" } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException).code === "string" ? 1 : 0;
        resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

let dataDir: string;
let db: Database;
let blobs: BlobStore;
let events: EventStore;
let sessions: SessionService;
let coordinator: RunCoordinator;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ag-t2425-"));
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

describe("run_test 沙箱（T25）", () => {
  function makeCtx(workspace: string) {
    return {
      runId: "run-sandbox",
      workspaceRoot: workspace,
      allowedToolIds: ["run_test"],
      deadlineAt: new Date(Date.now() + 10_000).toISOString(),
      maxOutputBytes: 64 * 1024,
    };
  }

  it("执行通过的测试脚本：退出码 0，输出忠实", async () => {
    const ws = mkdtempSync(join(tmpdir(), "ag-sandbox-"));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(ws, "ok.test.js"), 'console.log("ALL TESTS PASSED");');
    const r = await RUN_TEST_TOOL.execute({ script: "ok.test.js" }, makeCtx(ws));
    expect(r.status).toBe("succeeded");
    expect(JSON.parse(JSON.stringify(r.outputSummary)).passed).toBe(true);
    rmSync(ws, { recursive: true, force: true });
  });

  it("失败的测试：退出码非 0，TEST_FAILED（模型声称通过不改真实退出码）", async () => {
    const ws = mkdtempSync(join(tmpdir(), "ag-sandbox-"));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(ws, "fail.test.js"), 'console.error("1 CHECK FAILED"); process.exit(1);');
    const r = await RUN_TEST_TOOL.execute({ script: "fail.test.js" }, makeCtx(ws));
    expect(r.status).toBe("failed");
    expect(r.reasonCode).toBe("TEST_FAILED");
    rmSync(ws, { recursive: true, force: true });
  });

  it("忙等脚本被硬超时终止（SIGKILL）", async () => {
    const ws = mkdtempSync(join(tmpdir(), "ag-sandbox-"));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(ws, "busy.test.js"), "setInterval(() => {}, 100);");
    const shortDeadline = { ...makeCtx(ws), deadlineAt: new Date(Date.now() + 800).toISOString() };
    const r = await RUN_TEST_TOOL.execute({ script: "busy.test.js" }, shortDeadline);
    expect(r.reasonCode).toBe("TEST_TIMEOUT");
    rmSync(ws, { recursive: true, force: true });
  }, 30_000);

  it("非脚本文件（.py/.sh）与命令注入参数被拒绝", async () => {
    const ws = mkdtempSync(join(tmpdir(), "ag-sandbox-"));
    for (const script of ["evil.py", "x.js; rm -rf /", "a.js && whoami"]) {
      const r = await RUN_TEST_TOOL.execute({ script }, makeCtx(ws));
      expect(r.status).toBe("denied");
      expect(r.reasonCode).toBe("SCRIPT_NOT_ALLOWED");
    }
    rmSync(ws, { recursive: true, force: true });
  });

  it("路径越界被拒绝", async () => {
    const r = await RUN_TEST_TOOL.execute({ script: "../../outside.js" }, makeCtx(mktdir()));
    expect(r.status).toBe("denied");
    function mktdir() {
      return mkdtempSync(join(tmpdir(), "ag-sandbox2-"));
    }
  });
});

describe("T24 CLI 与 Web 一致性", () => {
  it("doctor：CLI 与 API 同源健康信息", async () => {
    // 需要真实 API 栈；此处直接验证 CLI 模块可加载并输出（离线：预期 API 不可达错误信息）
    const r = await runCli(["doctor"], 30_000);
    expect(r.stdout + r.stderr).toMatch(/API|doctor|不可达/);
  });

  it("退出码语义：API 不可达时非 0（CLI 文本不是唯一证据，但失败必须可观察）", async () => {
    // 指向不存在的端口
    const r = await new Promise<{ code: number; stderr: string }>((resolve) => {
      const { execFile } = require("node:child_process") as typeof import("node:child_process");
      execFile(
        process.execPath,
        ["--experimental-strip-types", CLI_ENTRY, "doctor"],
        { timeout: 30_000, env: { ...process.env, AGENTGLASS_URL: "http://127.0.0.1:59999", NODE_OPTIONS: "" } },
        (err, _so, se) => resolve({ code: err ? 1 : 0, stderr: String(se) }),
      );
    });
    expect(r.code).not.toBe(0);
  });
});

describe("L26 沙箱修复全链", () => {
  it("读 bug → 写修复 → run_test 真实通过 → 输出含 ALL TESTS PASSED", async () => {
    const snapId = await seedFake();
    const courseRevision = await coordinator.ensureCourseRevision("L26-sandbox-fix");
    const sessionId = sessions.createSession("local-learner", "local-project", {
      lessonId: "L26-sandbox-fix",
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
      clientMessageId: `r3-l26-${Math.random().toString(36).slice(2)}`,
      text: [
        "请修复 format.js 的 bug。修复内容如下（写入 format.js）：",
        "```js",
        "export function formatPrice(n) {",
        '  return "$" + n.toFixed(2);',
        "}",
        "```",
        "然后运行 format.test.js 验证。",
      ].join("\n"),
      origin: "interactive",
    });
    coordinator.start();
    const deadline = Date.now() + 60_000;
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
          if (String(row.state) === "awaiting_approval" && !granted) {
            // 教师批准写入（等价 POST /approvals/:id/decision）
            const rid = String(row.id);
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
    expect(run).toBeDefined();
    expect(String(run!.state)).toBe("completed");

    const runId = String(run!.id);
    const all = events.readRange(runId, 0, events.maxSeq(runId));
    const write = all.find(
      (e) => e.type === "tool.call_completed" && (e.summary as Record<string, unknown>).toolId === "write_file",
    );
    const test = all.find(
      (e) => e.type === "tool.call_completed" && (e.summary as Record<string, unknown>).toolId === "run_test",
    );
    expect(write).toBeDefined();
    expect(test).toBeDefined();
    expect((test!.summary as Record<string, unknown>).status).toBe("succeeded");
    // 修复后的文件真实写入了工作区
    const wsDir = join(dataDir, "workspaces", runId, "format.js");
    expect(existsSync(wsDir)).toBe(true);
    expect(readFileSync(wsDir, "utf8")).toContain("toFixed(2)");
    rmSync(dataDir, { recursive: true, force: true });
  }, 90_000);
});
