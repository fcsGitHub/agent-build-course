/**
 * 单元测试：有界 RSI 循环（L45）。
 * 用可编程的假网关验证教学语义：
 * - 四要素循环事件齐备（generation_started/evaluated/promoted|rejected/generation_completed）
 * - 晋级门只认严格改进；被拒变体保留在归档
 * - 变异输出无 <prompt> 标记 → INVALID_MUTATION 拒绝并继续
 * - 预算耗尽优雅停止（completed + budget_model_calls_exhausted），报告仍产出且含诚实边界
 * - 服务端上限：代数 > manifest 声明被绝对上限截断
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Database } from "@agentglass/db";
import { BlobStore, EventStore } from "@agentglass/events";
import { BudgetLedger } from "@agentglass/policy";
import type { ModelGateway } from "@agentglass/provider-gateway";
import { RsiLoopRunner, RSI_ABSOLUTE_GENERATION_CAP } from "@agentglass/runtime-reference";
import { DEFAULT_BUDGET, type ModelProfileSnapshot, type ModelResponse } from "@agentglass/contracts";

let dataDir: string;
let db: Database;
let events: EventStore;
let blobs: BlobStore;
let budgets: BudgetLedger;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ag-rsi-"));
  db = openDatabase({ file: ":memory:" });
  blobs = new BlobStore(db, join(dataDir, "blobs"));
  events = new EventStore(db);
  budgets = new BudgetLedger(db);
});

const SNAP = {
  id: "snap_rsi",
  provider: "fake",
  protocol: "fake/v1",
  endpointId: "fake",
  modelId: "fake-deterministic",
  parameters: {},
  capabilities: {},
} as unknown as ModelProfileSnapshot;

/** 可编程假网关：变异调用返回 mutationText；评估调用按变体提示包含 MAGIC 决定成败 */
function fakeGateway(opts: { mutationTexts: string[]; magicWins: boolean }): ModelGateway {
  let mutationIdx = 0;
  return {
    invokeComplete: async (_snap: unknown, messages: unknown): Promise<ModelResponse> => {
      const msgs = messages as Array<{ role: string; content: string }>;
      const sys = msgs.find((m) => m.role === "system")?.content ?? "";
      if (sys.includes("变异器")) {
        const text = opts.mutationTexts[mutationIdx] ?? "<prompt>兜底</prompt>";
        mutationIdx += 1;
        return resp(text);
      }
      // 评估调用：变体提示含 MAGIC（变异注入的暗号）才答对
      const win = sys.includes("MAGIC") && opts.magicWins;
      return resp(win ? "每季度润滑轴承并更换密封；库存 42 件高于阈值，充足。" : "不清楚。");
    },
  } as unknown as ModelGateway;
}

function resp(text: string): ModelResponse {
  return {
    callId: `c_${Math.random().toString(36).slice(2, 8)}`,
    finishReason: "stop",
    messageText: text,
    toolRequests: [],
    usage: { inputTokens: 10, outputTokens: 10 },
    rawText: text,
  };
}

const TASKS = [
  { id: "t1", input: "总结维护安排（含「季度」「密封」）", expect: ["季度", "密封"] },
  { id: "t2", input: "库存是否充足（含「42」「充足」）", expect: ["42", "充足"] },
];

function runner(gateway: ModelGateway): RsiLoopRunner {
  return new RsiLoopRunner({
    events,
    blobs,
    budget: budgets,
    gateway,
    modelSnapshot: SNAP,
    pollCommands: () => ({ pauseRequested: false, cancelRequested: false }),
  });
}

function spec(): { id: string } {
  return { id: `run_${Math.random().toString(36).slice(2, 10)}` };
}

function typesOf(runId: string): string[] {
  return events.readRange(runId, 0, events.maxSeq(runId)).map((e) => e.type);
}

describe("RsiLoopRunner", () => {
  it("严格改进晋级 + 被拒变体入档 + 事件齐备", async () => {
    // 变异 1 注入 MAGIC（评估全对 → 1.0 > 0 晋级）；变异 2 与父代相同（UNCHANGED 拒绝）
    const gw = fakeGateway({ mutationTexts: ["<prompt>你是助手。回答时包含 MAGIC 关键纪律。</prompt>", "<prompt>你是助手。回答时包含 MAGIC 关键纪律。</prompt>"], magicWins: true });
    const r = runner(gw);
    const s = spec();
    const result = await r.execute(s as never, {
      systemPrompt: "你是设备维护助手。",
      improvementGoal: "让回答包含要求的关键词",
      frozenTasks: TASKS,
      maxGenerations: 2,
      budget: { ...DEFAULT_BUDGET, maxModelCalls: 10 },
    }, new AbortController().signal);

    expect(result.state).toBe("completed");
    expect(result.reasonCode).toBe("final_answer");
    const t = typesOf(s.id);
    expect(t).toContain("rsi.generation_started");
    expect(t.filter((x) => x === "candidate.evaluated").length).toBeGreaterThanOrEqual(2); // v0 + 候选
    expect(t).toContain("candidate.promoted");
    expect(t).toContain("candidate.rejected"); // UNCHANGED
    expect(t.filter((x) => x === "rsi.generation_completed").length).toBe(2);
    const report = blobs.getText(result.outputRefs[0]!.id);
    expect(report).toContain("诚实边界");
    expect(report).toContain("v1");
    // 归档含 v0 + 候选 + 无效变体
    const completed = events.readRange(s.id, 0, events.maxSeq(s.id)).find((e) => e.type === "run.completed");
    expect(Number(completed!.summary.archiveSize)).toBeGreaterThanOrEqual(3);
    expect(Number(completed!.summary.bestScore)).toBe(1);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("无标记变异 → INVALID_MUTATION 拒绝并继续下一代", async () => {
    const gw = fakeGateway({ mutationTexts: ["抱歉我不知道怎么改", "<prompt>包含 MAGIC 纪律</prompt>"], magicWins: true });
    const r = runner(gw);
    const s = spec();
    const result = await r.execute(s as never, {
      systemPrompt: "你是设备维护助手。",
      improvementGoal: "改进",
      frozenTasks: TASKS,
      maxGenerations: 2,
      budget: { ...DEFAULT_BUDGET, maxModelCalls: 10 },
    }, new AbortController().signal);
    expect(result.state).toBe("completed");
    const rejected = events.readRange(s.id, 0, events.maxSeq(s.id)).filter((e) => e.type === "candidate.rejected");
    expect(rejected.some((e) => String(e.summary.reason).startsWith("INVALID_MUTATION:MARKER_MISSING"))).toBe(true);
    expect(typesOf(s.id)).toContain("candidate.promoted"); // 第二代仍完成
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("评估中途预算耗尽：优雅停止（completed + budget_model_calls_exhausted）而非失败", async () => {
    const gw = fakeGateway({ mutationTexts: ["<prompt>包含 MAGIC</prompt>"], magicWins: true });
    // maxModelCalls = 4：v0 评估 2 + 变异 1 + 候选评估第 1 任务 1 → 第 2 个任务预留被拒
    const r = runner(gw);
    const s = spec();
    const result = await r.execute(s as never, {
      systemPrompt: "你是设备维护助手。",
      improvementGoal: "改进",
      frozenTasks: TASKS,
      maxGenerations: 1,
      budget: { ...DEFAULT_BUDGET, maxModelCalls: 4 },
    }, new AbortController().signal);
    expect(result.state).toBe("completed");
    expect(result.reasonCode).toBe("budget_model_calls_exhausted");
    const t = typesOf(s.id);
    expect(t).not.toContain("run.failed");
    expect(t).toContain("rsi.generation_completed"); // 耗尽代也有完成事件（含如实说明）
    expect(blobs.getText(result.outputRefs[0]!.id)).toContain("诚实边界");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("服务端绝对代数上限：manifest 声明 9 也被截到 3", async () => {
    const gw = fakeGateway({ mutationTexts: [], magicWins: false });
    const r = runner(gw);
    const s = spec();
    await r.execute(s as never, {
      systemPrompt: "你是设备维护助手。",
      improvementGoal: "改进",
      frozenTasks: TASKS,
      maxGenerations: 9,
      budget: { ...DEFAULT_BUDGET, maxModelCalls: 60 },
    }, new AbortController().signal);
    const started = events.readRange(s.id, 0, events.maxSeq(s.id)).filter((e) => e.type === "rsi.generation_started");
    expect(started.length).toBe(RSI_ABSOLUTE_GENERATION_CAP);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("冻结集为空 → 显式拒绝执行", async () => {
    const r = runner(fakeGateway({ mutationTexts: [], magicWins: false }));
    await expect(
      r.execute(spec() as never, {
        systemPrompt: "x", improvementGoal: "y", frozenTasks: [], maxGenerations: 1,
        budget: DEFAULT_BUDGET,
      }, new AbortController().signal),
    ).rejects.toThrow("RSI_FROZEN_TASKS_EMPTY");
    rmSync(dataDir, { recursive: true, force: true });
  });
});
