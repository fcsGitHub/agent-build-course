/**
 * 合同测试：事件账本约束（T03）与课程包输入策略（T34/T42 课程侧防线）。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { openDatabase, type Database } from "@agentglass/db";
import { BlobStore, EventStore } from "@agentglass/events";
import { LessonRegistry, lintLesson } from "@agentglass/lessons";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

let db: Database;
let blobs: BlobStore;
let events: EventStore;

beforeEach(() => {
  db = openDatabase({ file: ":memory:" });
  blobs = new BlobStore(db, join(tmpdir(), `ag-contract-${Date.now()}`));
  events = new EventStore(db);
});

describe("事件账本合同（T03）", () => {
  it("未注册事件类型被拒绝", () => {
    expect(() =>
      events.transact(() => events.append("run-x", [{ type: "model.made_up_event", summary: {} }])),
    ).toThrow(/未注册/);
  });

  it("(run_id, seq) 由服务端分配且严格递增；同事务提交与 outbox 同步", () => {
    const inserted = events.transact(() =>
      events.append("run-contract", [
        { type: "run.created", summary: {} },
        { type: "run.started", summary: {} },
      ]),
    );
    expect(inserted.map((e) => e.seq)).toEqual([1, 2]);
    const outbox = db.prepare("SELECT COUNT(*) AS n FROM event_outbox WHERE published = 0").get() as { n: number };
    expect(outbox.n).toBe(2);
  });

  it("敏感键进入 summary 时被脱敏", () => {
    const [e] = events.transact(() =>
      events.append("run-contract", [
        { type: "run.created", summary: { authorization: "Bearer sk-secret", apiKey: "x", note: "ok" } },
      ]),
    );
    const s = e!.summary as Record<string, unknown>;
    expect(s.authorization).toBe("[REDACTED]");
    expect(s.apiKey).toBe("[REDACTED]");
    expect(s.note).toBe("ok");
  });

  it("readAfter / readRange 支持游标分页", () => {
    events.transact(() =>
      events.append("run-page", Array.from({ length: 10 }, (_, i) => ({ type: "run.state_changed", summary: { i } }))),
    );
    const page = events.readAfter("run-page", 4, 3);
    expect(page.map((e) => e.seq)).toEqual([5, 6, 7]);
  });

  it("blob 内容摘要校验：篡改必须被发现", () => {
    const ref = blobs.putText("hello world");
    expect(blobs.getText(ref.id)).toBe("hello world");
    // 物理篡改文件
    const row = db.prepare("SELECT path FROM blobs WHERE id = ?").get(ref.id) as { path: string };
    writeFileSync(row.path, "tampered");
    expect(() => blobs.getText(ref.id)).toThrow(/BLOB_DIGEST_MISMATCH/);
    rmSync(row.path, { force: true });
  });
});

describe("课程包输入策略合同（linter 拒绝自动对话剧本）", () => {
  const lessonsDir = () => {
    const dir = join(tmpdir(), `bad-lesson-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, "L99-bad"), { recursive: true });
    return dir;
  };

  function writeLesson(dir: string, patch: Record<string, unknown>): void {
    const base = {
      schema_version: 1,
      id: "L99",
      revision: "1.0.0",
      title: "坏课程",
      stage: "I",
      summary: "",
      prerequisites: [],
      runtime: { adapter: "reference", entrypoint: "x.ts", profile: "single_call" },
      learner_input: {
        mode: "user_authored",
        default_text: "",
        auto_send: false,
        auto_followups: false,
        case_hints: "case-hints.yaml",
        hint_action: "insert_into_draft",
        grade_only_matching_task_contract: true,
      },
      requires: { model: ["streaming"], tools: [] },
      assets: {},
      limits: { max_turns: 2, max_model_calls: 2, max_tool_calls: 2, max_wall_time_ms: 10000, max_concurrency: 1, max_depth: 1 },
      observations: { events: ["run.created"] },
    };
    const merged = { ...base, ...patch };
    writeFileSync(join(dir, "L99-bad", "manifest.yaml"), JSON.stringify(merged));
  }

  it("auto_send: true 被课程 linter 拒绝", () => {
    const dir = lessonsDir();
    writeLesson(dir, { learner_input: { mode: "user_authored", default_text: "", auto_send: true, auto_followups: false, case_hints: "case-hints.yaml", hint_action: "insert_into_draft", grade_only_matching_task_contract: true } });
    const issues = lintLesson(new LessonRegistry(dir), "L99-bad");
    expect(issues.some((i) => i.code === "AUTO_SEND_FORBIDDEN")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("预置默认用户对话被拒绝", () => {
    const dir = lessonsDir();
    writeLesson(dir, { learner_input: { mode: "scripted", default_text: "你好", auto_send: false, auto_followups: false, case_hints: "c.yaml", hint_action: "insert_into_draft", grade_only_matching_task_contract: true } });
    const issues = lintLesson(new LessonRegistry(dir), "L99-bad");
    expect(issues.some((i) => i.code === "DEFAULT_USER_DIALOG_FORBIDDEN")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("无预算边界（0 轮）被拒绝", () => {
    const dir = lessonsDir();
    writeLesson(dir, { limits: { max_turns: 0, max_model_calls: 0, max_tool_calls: 0, max_wall_time_ms: 0, max_concurrency: 1, max_depth: 1 } });
    const issues = lintLesson(new LessonRegistry(dir), "L99-bad");
    expect(issues.some((i) => i.code === "BUDGET_INVALID")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
