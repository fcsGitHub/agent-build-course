/**
 * T35 负载基准：回放与导出链路在 5000 事件量级上的耗时。
 * - 事件账本真实写入（文件库 + 事务批量）；
 * - 测量：agtrace 导出 / 导入 / 纯函数投影回放；
 * - 断言为宽松上界（防退化），实际值输出到控制台供 runbook 记录；
 *   未达上界即视为缺陷（不放宽指标）。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@agentglass/db";
import { BlobStore, EventStore } from "@agentglass/events";
import type { TraceEvent } from "@agentglass/contracts";
import { exportBundle, importBundle } from "@agentglass/replay";
import { initialProjection, reduceTrace } from "@agentglass/projections";

const EVENT_COUNT = 5000;

function synthEvent(runId: string, seq: number): Parameters<EventStore["append"]>[1][number] {
  const kinds = [
    { type: "context.compiled", summary: { included: seq % 7, excluded: seq % 3, estimatedInputTokens: 100 + (seq % 90) } },
    { type: "model.request_prepared", summary: { provider: "fake", modelId: "bench", stream: true } },
    { type: "model.response_completed", summary: { finishReason: "stop", usage: { inputTokens: 120, outputTokens: 40 } } },
    { type: "tool.proposed", summary: { callId: `c${seq}`, toolId: "read_text", argumentsText: '{"path":"a.csv"}' } },
    { type: "tool.call_completed", summary: { callId: `c${seq}`, toolId: "read_text", status: "succeeded" } },
    { type: "policy.stop_decision", summary: { source: "guest", decision: seq % 2 ? "continue" : "stop", completedTurns: seq % 9 } },
  ];
  const k = kinds[seq % kinds.length]!;
  return { type: k.type, summary: k.summary as Record<string, unknown>, conceptIds: ["bench"] };
}

describe("T35 回放负载（5000 事件）", () => {
  it("导出 / 导入 / 投影回放在宽松上界内完成", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ag-load-"));
    const db = openDatabase({ file: join(dataDir, "bench.db") });
            const events = new EventStore(db);
    const runId = "run_bench_load";

    const tWrite0 = performance.now();
    for (let from = 1; from <= EVENT_COUNT; from += 500) {
      const batch = Array.from({ length: 500 }, (_, i) => synthEvent(runId, from + i));
      events.transact(() => {
        events.append(runId, batch);
      });
    }
    const writeMs = performance.now() - tWrite0;

    const all: TraceEvent[] = events.readRange(runId, 0, events.maxSeq(runId));
    expect(all).toHaveLength(EVENT_COUNT);
    const seqs = all.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));

    // 1) agtrace 导出（含脱敏与摘要）
    const tExport = performance.now();
    const bytes = exportBundle({ runId, mode: "live", events: all, reducerVersion: "bench-1" });
    const exportMs = performance.now() - tExport;

    // 2) agtrace 导入（含路径穿越/摘要校验，不执行包内脚本）
    const tImport = performance.now();
    const imported = importBundle(bytes);
    const importMs = performance.now() - tImport;
    expect(imported.ok, `导入失败: ${imported.errors.join("; ")}`).toBe(true);
    expect(imported.manifest?.integrity.eventCount).toBe(EVENT_COUNT);
    expect(imported.events).toHaveLength(EVENT_COUNT);

    // 3) 纯函数投影回放（断网回放的执行核心）
    const tReduce = performance.now();
    let state = initialProjection(runId);
    for (const e of all) state = reduceTrace(state, e);
    const reduceMs = performance.now() - tReduce;

    const line = `bench: 写入5000事件 ${writeMs.toFixed(0)}ms | 导出 ${exportMs.toFixed(0)}ms (${(bytes.length / 1024).toFixed(0)}KB) | 导入 ${importMs.toFixed(0)}ms | 投影回放 ${reduceMs.toFixed(0)}ms`;
    console.log(`[replay-load] ${line}`);

    // 宽松上界：本地参考环境余量充足；超界即缺陷（T35：不改写指标）
    expect(exportMs).toBeLessThan(15_000);
    expect(importMs).toBeLessThan(15_000);
    expect(reduceMs).toBeLessThan(10_000);

    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }, 60_000);
});
