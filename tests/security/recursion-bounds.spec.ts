/**
 * T29 安全测试：有界递归的边界不可被任务参数突破。
 * - 深度硬上限：maxDepth=100 的请求仍被服务端绝对上限（8）截断；
 * - 节点数硬上限：分区过小不会产生超过 64 个节点的调用风暴；
 * - 子调用预算原子性：预算不足的节点显式 BUDGET_EXCEEDED，最终答案诚实声明覆盖缺失，
 *   绝不静默跳过或伪造"完整"结果。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@agentglass/db";
import { BlobStore, EventStore } from "@agentglass/events";
import { BudgetLedger } from "@agentglass/policy";
import { ModelGateway } from "@agentglass/provider-gateway";
import { BoundedRecursionRunner, RECURSION_ABSOLUTE_DEPTH_CAP, RECURSION_ABSOLUTE_NODE_CAP } from "@agentglass/multi-agent";
import type { ModelProfileSnapshot } from "@agentglass/contracts";
import { DEFAULT_BUDGET } from "@agentglass/contracts";

function makeRunner() {
  const dataDir = mkdtempSync(join(tmpdir(), "ag-rec-"));
  const db = openDatabase({ file: ":memory:" });
  const blobs = new BlobStore(db, join(dataDir, "blobs"));
  const events = new EventStore(db);
  const gateway = new ModelGateway(blobs);
  const snap: ModelProfileSnapshot = {
    id: "snap_rec_fake",
    provider: "fake",
    protocol: "fake/v1",
    endpointId: "fake",
    modelId: "fake-deterministic",
    parameters: {},
    capabilities: {
      streaming: false,
      nativeTools: false,
      parallelToolCalls: false,
      structuredOutput: "text_only",
      imageInput: false,
      audioInput: false,
      outputModalities: ["text"],
      usageReporting: "final",
      contextWindow: 32000,
      testedAt: "static-declaration",
      probeSuiteVersion: "fake-1",
    },
  };
  const runner = new BoundedRecursionRunner({
    events,
    blobs,
    budget: new BudgetLedger(db),
    gateway,
    modelSnapshot: snap,
    pollCommands: () => ({ pauseRequested: false, cancelRequested: false }),
  });
  const longText = Array.from({ length: 160 }, (_, i) => `维护要点${i % 50}：设备按周期检查并记录结果，异常时联系认证工程师（条目 ${i}）。`).join("\n");
  return { dataDir, blobs, events, runner, longText };
}

describe("递归边界（服务端硬上限）", () => {
  it("maxDepth=100 仍被绝对上限截断，节点数不超过硬上限", async () => {
    const { dataDir, events, runner, longText } = makeRunner();
    const spec = { id: "run_rec_depth" } as unknown as import("@agentglass/contracts").RunSpec;
    const result = await runner.execute(
      spec,
      {
        systemPrompt: "递归节点",
        rootText: longText,
        question: "本分区的维护要点？",
        maxDepth: 100, // 恶意/配错的深度
        partitionChars: 40, // 极小分区：试图制造调用风暴
        budget: { ...DEFAULT_BUDGET, maxModelCalls: 999 },
      },
      new AbortController().signal,
    );
    expect(result.state).toBe("completed");
    const runId = spec.id;
    const all = events.readRange(runId, 0, events.maxSeq(runId));
    const done = all.find((e) => e.type === "run.completed")!;
    expect(Number((done.summary as Record<string, unknown>).maxDepthReached)).toBeLessThanOrEqual(RECURSION_ABSOLUTE_DEPTH_CAP);
    expect(Number((done.summary as Record<string, unknown>).nodes)).toBeLessThanOrEqual(RECURSION_ABSOLUTE_NODE_CAP);
    rmSync(dataDir, { recursive: true, force: true });
  }, 60_000);

  it("子调用预算不足：节点显式 BUDGET_EXCEEDED，最终答案声明覆盖缺失（不伪造完整）", async () => {
    const { dataDir, blobs, events, runner, longText } = makeRunner();
    const spec = { id: "run_rec_budget" } as unknown as import("@agentglass/contracts").RunSpec;
    const result = await runner.execute(
      spec,
      {
        systemPrompt: "递归节点",
        rootText: longText,
        question: "本分区的维护要点？",
        maxDepth: 2,
        partitionChars: 400,
        budget: { ...DEFAULT_BUDGET, maxModelCalls: 2 }, // 远少于节点数
      },
      new AbortController().signal,
    );
    expect(result.state).toBe("completed");
    const runId = spec.id;
    const all = events.readRange(runId, 0, events.maxSeq(runId));
    const denied = all.filter(
      (e) => e.type === "recursion.node_completed" && String((e.summary as Record<string, unknown>).reason ?? "").includes("BUDGET_EXCEEDED"),
    );
    expect(denied.length).toBeGreaterThan(0);
    const done = all.find((e) => e.type === "run.completed")!;
    expect(Number((done.summary as Record<string, unknown>).budgetDenied)).toBe(denied.length);
    // 最终输出包含诚实缺失声明
    const finalRef = (result.outputRefs[0] as { id: string }).id;
    const finalText = blobs.getText(finalRef);
    expect(finalText.includes("预算不足") || finalText.includes("缺失")).toBe(true);
    rmSync(dataDir, { recursive: true, force: true });
  }, 60_000);
});
