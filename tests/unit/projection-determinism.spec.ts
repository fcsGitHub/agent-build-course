/**
 * 用例 1（§25.2）：同一账本重建同一投影，重复事件不重复应用。
 */
import { describe, expect, it } from "vitest";
import type { TraceEvent } from "@agentglass/contracts";
import {
  initialProjection,
  reduceTrace,
  projectionDigest,
} from "@agentglass/projections";

function makeEvent(seq: number, type: string, summary: Record<string, unknown> = {}): TraceEvent {
  type Summary = TraceEvent["summary"];
  return {
    schemaVersion: 1,
    eventId: `evt_${seq}`,
    runId: "run-1",
    seq,
    type,
    actorId: "test",
    traceId: "trace_run-1",
    spanId: `span_${seq}`,
    causationEventIds: [],
    emittedAt: "2026-09-14T00:00:00Z",
    conceptIds: [],
    dataClass: "public",
    summary: summary as unknown as Summary,
  };
}

/** 两轮工具循环的合成事件（synthetic fixture；不得进入 recorded-runs） */
export function twoTurnToolLoopFixture(): TraceEvent[] {
  return [
    makeEvent(1, "input.accepted", { inputId: "in1" }),
    makeEvent(2, "run.created", {}),
    makeEvent(3, "run.started", { profile: "agent_loop" }),
    makeEvent(4, "context.compiled", { included: 3, excluded: 0, estimatedInputTokens: 120, compiledContextId: "cc1" }),
    makeEvent(5, "model.request_prepared", { modelId: "m", provider: "fake" }),
    makeEvent(6, "model.request_dispatched", { attempt: 1 }),
    makeEvent(7, "model.response_completed", { finishReason: "tool_calls", toolRequestCount: 1, usage: { inputTokens: 100, outputTokens: 20 }, messageChars: 0 }),
    makeEvent(8, "tool.proposed", { callId: "call_1", toolId: "calculator", argumentsText: "{\"expression\":\"1+1\"}" }),
    makeEvent(9, "tool.validated", { callId: "call_1" }),
    makeEvent(10, "tool.call_completed", { callId: "call_1", toolId: "calculator", status: "succeeded" }),
    makeEvent(11, "context.compiled", { included: 5, excluded: 0, estimatedInputTokens: 180, compiledContextId: "cc2" }),
    makeEvent(12, "model.request_prepared", { modelId: "m", provider: "fake" }),
    makeEvent(13, "model.request_dispatched", { attempt: 1 }),
    makeEvent(14, "model.response_completed", { finishReason: "stop", toolRequestCount: 0, usage: { inputTokens: 160, outputTokens: 40 }, messageChars: 50 }),
    makeEvent(15, "run.completed", { stopReason: "final_answer", completedTurns: 2 }),
  ];
}

describe("投影确定性（用例 1）", () => {
  it("同一份已提交事件重建出相同投影摘要", () => {
    const events = twoTurnToolLoopFixture();
    const first = events.reduce(reduceTrace, initialProjection());
    const second = events.reduce(reduceTrace, initialProjection());
    expect(projectionDigest(first)).toBe(projectionDigest(second));
  });

  it("重复投递同一事件（同 seq 同内容）幂等跳过", () => {
    const events = twoTurnToolLoopFixture();
    const state = events.reduce(reduceTrace, initialProjection());
    const duplicate = reduceTrace(state, events[events.length - 1]!);
    expect(projectionDigest(duplicate)).toBe(projectionDigest(state));
  });

  it("seq 缺口显式报错（需补拉），不静默构造", () => {
    const events = twoTurnToolLoopFixture().filter((e) => e.seq !== 5);
    expect(() => events.reduce(reduceTrace, initialProjection())).toThrow(/SEQ_GAP/);
  });

  it("乱序到达被拒绝（调用方负责排序/补拉）", () => {
    const events = twoTurnToolLoopFixture();
    const shuffled = [...events].sort(() => Math.random() - 0.5);
    let threw = false;
    try {
      shuffled.reduce(reduceTrace, initialProjection());
    } catch (err) {
      threw = /SEQ_GAP/.test(String(err));
    }
    expect(threw).toBe(true);
  });

  it("投影捕获工具卡、模型调用与停止原因", () => {
    const state = twoTurnToolLoopFixture().reduce(reduceTrace, initialProjection());
    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0]!.status).toBe("executed");
    expect(state.modelCalls).toHaveLength(2);
    expect(state.modelCalls[1]!.finishReason).toBe("stop");
    expect(state.stopReason).toBe("final_answer");
    expect(state.eventCount).toBe(15);
  });
});
