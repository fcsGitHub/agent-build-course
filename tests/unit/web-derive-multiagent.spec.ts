/**
 * 前端投影单元测试：事件账本 → 对话/回合视图（apps/web/src/derive.ts，纯函数）。
 * 覆盖多 agent 通信输出的投影合同：
 * - worker 模型事件（summary.workerId）→ 回合归属到对应 worker；
 * - agent.delegated / agent.handed_off / agent.result_received / mcp / a2a / skill.loaded
 *   → 通信活动，与回合按事件顺序穿插为 entries；
 * - 流式片段按序拼接、缺中间片段时停在已连续前缀；
 * - 单 agent 主循环的既有语义不回归（回合计数、用量累计、工具状态）。
 */
import { describe, expect, it } from "vitest";
import { deriveRun, missingBlobs, resolveTurnText } from "../../apps/web/src/derive";
import type { TraceEvent } from "../../apps/web/src/api";

let seq = 0;
function ev(type: string, summary: Record<string, unknown>, payloadRef?: { id: string }): TraceEvent {
  seq += 1;
  return {
    eventId: `e${seq}`,
    runId: "run_test",
    seq,
    type,
    summary,
    payloadRef,
    causationEventIds: [],
    conceptIds: [],
    emittedAt: new Date(2026, 0, 1, 12, 0, seq).toISOString(),
  } as TraceEvent;
}

describe("多 agent 通信投影", () => {
  it("worker 事件归属：回合带 workerId，entries 穿插委派/结果活动", () => {
    const events = [
      ev("agent.delegated", { taskId: "t1", workerId: "researcher", goal: "检索事实" }),
      ev("context.compiled", { workerId: "researcher", compiledContextId: "cc_1", included: 2, excluded: 0, estimatedInputTokens: 120 }),
      ev("model.request_prepared", { workerId: "researcher", stream: true }),
      ev("model.request_dispatched", { workerId: "researcher", taskId: "t1" }),
      ev("model.delta_batch", { workerId: "researcher", chars: 64 }, { id: "b1" }),
      ev("model.response_completed", { workerId: "researcher", taskId: "t1", usage: { inputTokens: 120, outputTokens: 40 } }, { id: "b2" }),
      ev("agent.result_received", { taskId: "t1", workerId: "researcher", status: "succeeded", outputChars: 40 }),
    ];
    const d = deriveRun(events);
    expect(d.turns.length).toBe(1);
    expect(d.turns[0]!.workerId).toBe("researcher");
    expect(d.turns[0]!.contextCallId).toBe("cc_1");
    expect(d.usage).toEqual({ input: 120, output: 40 });
    // 时间线：委派活动 → 回合 → 结果活动（顺序即事件顺序）
    expect(d.entries.map((e) => e.kind)).toEqual(["activity", "turn", "activity"]);
    const first = d.entries[0]!;
    if (first.kind === "activity") {
      expect(first.activity.kind).toBe("delegated");
      expect(first.activity.workerId).toBe("researcher");
      expect(first.activity.goal).toBe("检索事实");
    } else {
      throw new Error("首个条目应为委派活动");
    }
    const last = d.entries.at(-1)!;
    if (last.kind === "activity") {
      expect(last.activity.kind).toBe("result");
      expect(last.activity.status).toBe("succeeded");
      expect(last.activity.outputChars).toBe(40);
    } else {
      throw new Error("末个条目应为结果活动");
    }
  });

  it("并行 worker：各自成回合，互不串扰", () => {
    const events = [
      ev("agent.delegated", { workerId: "w-a", taskId: "t1" }),
      ev("context.compiled", { workerId: "w-a", compiledContextId: "cc_a" }),
      ev("model.delta_batch", { workerId: "w-a", chars: 64 }, { id: "ba1" }),
      ev("context.compiled", { workerId: "w-b", compiledContextId: "cc_b" }),
      ev("model.delta_batch", { workerId: "w-b", chars: 64 }, { id: "bb1" }),
      ev("model.response_completed", { workerId: "w-b", usage: { inputTokens: 90, outputTokens: 30 } }, { id: "fb" }),
      ev("model.response_completed", { workerId: "w-a", usage: { inputTokens: 100, outputTokens: 20 } }, { id: "fa" }),
    ];
    const d = deriveRun(events);
    expect(d.turns.length).toBe(2);
    expect(d.turns.map((t) => t.workerId)).toEqual(["w-a", "w-b"]);
    expect(d.turns[0]!.deltaBlobIds).toEqual(["ba1"]);
    expect(d.turns[1]!.fullTextRef).toBe("fb");
    expect(d.usage.input).toBe(190);
  });

  it("移交链活动与黑板冲突活动：字段完整", () => {
    const events = [
      ev("agent.handed_off", { from: "researcher", to: "writer" }),
      ev("agent.handed_off", { from: "writer", to: "(final)", final: true }),
      ev("agent.result_received", { blackboardKey: "shared-findings", conflict: true, versions: 2, mergedBy: "conflict-kept-both" }),
    ];
    const d = deriveRun(events);
    expect(d.turns.length).toBe(0);
    const acts = d.entries.map((e) => (e.kind === "activity" ? e.activity : null));
    expect(acts[0]).toMatchObject({ kind: "handed_off", from: "researcher", to: "writer" });
    expect(acts[1]).toMatchObject({ kind: "handed_off", to: "(final)" });
    expect(acts[2]).toMatchObject({ kind: "result", blackboardKey: "shared-findings", conflict: true, versions: 2 });
  });

  it("MCP / A2A / 技能活动：协议与能力加载可见", () => {
    const events = [
      ev("mcp.server_connected", { serverId: "course" }),
      ev("mcp.protocol_event", { dir: "out", method: "tools/call", server: "course", bytes: 120 }),
      ev("a2a.agent_connected", { agentId: "remote-1", agentName: "课程桥" }),
      ev("skill.loaded", { slug: "evidence-summary-skill", version: "1.0.0", chars: 900 }),
    ];
    const d = deriveRun(events);
    const acts = d.entries.map((e) => (e.kind === "activity" ? e.activity : null));
    expect(acts[0]).toMatchObject({ kind: "mcp_connect", server: "course" });
    expect(acts[1]).toMatchObject({ kind: "mcp_protocol", method: "tools/call", server: "course" });
    expect(acts[2]).toMatchObject({ kind: "a2a_connect", agentName: "课程桥" });
    expect(acts[3]).toMatchObject({ kind: "skill", slug: "evidence-summary-skill", version: "1.0.0" });
  });
});

describe("流式文本装配（回归）", () => {
  it("片段按序拼接；缺中间片段停在已连续前缀；全文 blob 优先", () => {
    const events = [
      ev("context.compiled", { compiledContextId: "cc_1" }),
      ev("model.request_dispatched", {}),
      ev("model.delta_batch", { chars: 64 }, { id: "d1" }),
      ev("model.delta_batch", { chars: 64 }, { id: "d2" }),
      ev("model.delta_batch", { chars: 64 }, { id: "d3" }),
      ev("model.response_completed", { usage: {} }, { id: "full" }),
    ];
    const d = deriveRun(events);
    const t = d.turns[0]!;
    expect(t.workerId).toBeUndefined();
    expect(t.streaming).toBe(false);
    // 只有 d1 取回：显示 d1（d2 缺失 → 停在前缀）
    const partial = resolveTurnText(t, new Map([["d1", "第一段"]]));
    expect(partial).toBe("第一段");
    // 全文取回后优先
    const full = resolveTurnText(t, new Map([["d1", "第一段"], ["full", "完整全文"]]));
    expect(full).toBe("完整全文");
    // 缺失清单：未取回的片段 + 全文
    expect(missingBlobs(d, new Map()).sort()).toEqual(["d1", "d2", "d3", "full"].sort());
  });

  it("主循环回合语义不回归：工具状态与失败标记", () => {
    const events = [
      ev("context.compiled", { compiledContextId: "cc_1" }),
      ev("model.request_dispatched", {}),
      ev("model.response_completed", { usage: { inputTokens: 10, outputTokens: 5 }, toolRequestCount: 1 }, { id: "f1" }),
      ev("tool.proposed", { callId: "c1", toolId: "read_text", argumentsText: "{\"path\":\"a.txt\"}" }),
      ev("tool.call_completed", { callId: "c1", status: "succeeded" }, { id: "r1" }),
      ev("context.compiled", { compiledContextId: "cc_2" }),
      ev("model.request_dispatched", {}),
      ev("model.request_failed", { error: "HTTP_500" }),
    ];
    const d = deriveRun(events);
    expect(d.turns.length).toBe(2);
    expect(d.turns[0]!.tools[0]!.status).toBe("succeeded");
    expect(d.turns[1]!.failed).toBe(true);
    expect(d.turns[1]!.streaming).toBe(false);
  });
});
