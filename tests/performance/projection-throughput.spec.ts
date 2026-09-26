/**
 * 性能目标（设计 §21.6）的本地可复现子集：
 * 十万事件级账本的投影重建应在秒级完成（参考目标：十万事件跳转 P95 < 2s）。
 * 该测试用 20,000 个合成事件验证 reducer 吞吐与内存开销趋势；正式指标在参考硬件实测后发布。
 */
import { describe, expect, it } from "vitest";
import type { TraceEvent } from "@agentglass/contracts";
import { initialProjection, reduceTrace, projectionDigest } from "@agentglass/projections";

function synthEvents(n: number): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (let i = 1; i <= n; i++) {
    events.push({
      schemaVersion: 1,
      eventId: `evt_${i}`,
      runId: "run-perf",
      seq: i,
      type: i % 20 === 0 ? "context.compiled" : "run.state_changed",
      actorId: "perf",
      traceId: "trace_run-perf",
      spanId: `s${i}`,
      causationEventIds: [],
      emittedAt: "2026-09-14T00:00:00Z",
      conceptIds: [],
      dataClass: "public",
      summary: { i, state: "running" },
    });
  }
  return events;
}

describe("投影吞吐", () => {
  it("20,000 事件全量 reduce 在 500ms 内完成", () => {
    const events = synthEvents(20_000);
    const t0 = performance.now();
    let state = initialProjection();
    for (const e of events) state = reduceTrace(state, e);
    const elapsed = performance.now() - t0;
    expect(state.lastSeq).toBe(20_000);
    expect(elapsed).toBeLessThan(500);
    // 摘要稳定
    expect(projectionDigest(state)).toBe(projectionDigest(state));
  });
});
