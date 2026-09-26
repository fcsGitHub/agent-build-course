/**
 * 有界递归运行器（T29，L35）。
 * - 外部化长输入：长文本一次性入 blob，节点只携带自己的分区；
 * - 递归树：分区过大且未到深度上限 → 行边界二分；叶子节点对分区回答问题，内部节点合并子答案；
 * - 子调用预算：每个节点的模型调用从父预算**原子预留**（共享 BudgetLedger 行），不足显式 BUDGET_EXCEEDED；
 * - 深度上限：manifest 声明 + 服务端绝对上限双重约束；超限分区诚实标记 truncated，不冒充完整覆盖；
 * - 取消传播：父 AbortSignal → 节点 AbortController。
 * 依据设计文档 v1.1 §4.8 L35、T29（有界递归实验）。
 */
import { randomUUID } from "node:crypto";
import type {
  BudgetLimit,
  ModelProfileSnapshot,
  RunSpec,
  RuntimeResult,
} from "@agentglass/contracts";
import type { BlobStore, EventStore, NewTraceEvent } from "@agentglass/events";
import type { BudgetLedger } from "@agentglass/policy";
import type { ModelGateway } from "@agentglass/provider-gateway";
import { ControlGate, CancelledError } from "@agentglass/runtime-reference";

export const RECURSION_ADAPTER_VERSION = "bounded-recursion-1";
/** 服务端绝对深度上限：即使 manifest 配错也不能无界递归 */
export const RECURSION_ABSOLUTE_DEPTH_CAP = 8;
/** 节点数硬上限：防止分区过小导致爆炸 */
export const RECURSION_ABSOLUTE_NODE_CAP = 64;

export interface RecursionInput {
  systemPrompt: string;
  /** 外部化长输入全文（入 blob 一次，节点只携带分区） */
  rootText: string;
  /** 每个叶子分区要回答的问题 */
  question: string;
  /** 递归深度上限（服务端再套绝对上限） */
  maxDepth: number;
  /** 分区字符数（叶子最大长度） */
  partitionChars: number;
  budget: BudgetLimit;
}

export interface RecursionCollaborators {
  events: EventStore;
  blobs: BlobStore;
  budget: BudgetLedger;
  gateway: ModelGateway;
  modelSnapshot: ModelProfileSnapshot;
  pollCommands: () => { pauseRequested: boolean; cancelRequested: boolean };
}

interface RecNodeOutcome {
  nodeId: string;
  depth: number;
  status: "succeeded" | "failed";
  text: string;
  truncated: boolean;
  chars: number;
}

export class BoundedRecursionRunner {
  readonly id = "bounded-recursion";
  readonly adapterVersion = RECURSION_ADAPTER_VERSION;

  constructor(private readonly deps: RecursionCollaborators) {}

  async execute(spec: RunSpec, input: RecursionInput, signal: AbortSignal): Promise<RuntimeResult> {
    const { events, blobs, budget } = this.deps;
    if (input.partitionChars <= 0) throw new Error("RECURSION_PARTITION_INVALID: partition_chars 必须 > 0");
    const depthCap = Math.min(Math.max(1, input.maxDepth), RECURSION_ABSOLUTE_DEPTH_CAP);
    const budgetId = budget.open(spec.id, input.budget);
    const gate = ControlGate.fromSignal(signal, this.deps.pollCommands);

    // 外部化：根文本一次性入 blob；事件只引用，不内联全文
    const rootRef = blobs.putText(input.rootText, "text/plain; charset=utf-8");
    events.transact(() => {
      events.append(spec.id, [
        nodeEvt("run.started", {
          adapter: this.adapterVersion,
          depthCap,
          partitionChars: input.partitionChars,
          rootChars: input.rootText.length,
          rootRef: rootRef.id,
        }),
      ]);
    });

    let nodeCount = 0;
    let maxDepthReached = 0;
    const outcomes: RecNodeOutcome[] = [];
    const entered = { n: 0 }; // 已进入执行的节点数（进入即计数，先于任何 fan-out）

    try {
      const finalText = await this.runNode(
        spec, input, budgetId, gate, signal, depthCap, entered,
        { text: input.rootText, depth: 1, label: "root" },
        outcomes, (n) => { nodeCount = n; }, (d) => { maxDepthReached = Math.max(maxDepthReached, d); },
      );

      const failed = outcomes.filter((o) => o.status === "failed");
      const stopReason = outcomes.length > 0 && failed.length === outcomes.length ? "model_error" : "final_answer";
      const finalRef = blobs.putText(finalText, "text/plain; charset=utf-8");
      events.transact(() => {
        events.append(spec.id, [
          nodeEvt("run.completed", {
            stopReason,
            nodes: outcomes.length,
            failed: failed.length,
            budgetDenied: outcomes.filter((o) => o.text.includes("BUDGET_EXCEEDED")).length,
            maxDepthReached,
          }),
        ]);
      });
      void nodeCount;
      return { state: "completed", reasonCode: stopReason, outputRefs: [finalRef] };
    } catch (err) {
      if (err instanceof CancelledError) {
        return { state: "cancelled", reasonCode: "cancelled", outputRefs: [] };
      }
      events.transact(() => {
        events.append(spec.id, [nodeEvt("run.failed", { error: String(err).slice(0, 400) })]);
      });
      return { state: "failed", reasonCode: "coordinator_error", outputRefs: [] };
    }
  }

  /** 单节点：分区 →（超限且未到上限则二分递归）→ 叶子回答/内部合并 */
  private async runNode(
    spec: RunSpec,
    input: RecursionInput,
    budgetId: string,
    gate: ControlGate,
    parentSignal: AbortSignal,
    depthCap: number,
    entered: { n: number },
    node: { text: string; depth: number; label: string },
    outcomes: RecNodeOutcome[],
    bumpCount: (n: number) => void,
    bumpDepth: (d: number) => void,
  ): Promise<string> {
    // 节点进入即计数：fan-out 之前就拒绝超限子树（不能等结果回收才发现爆炸）
    if (entered.n >= RECURSION_ABSOLUTE_NODE_CAP) {
      return "（节点数超硬上限，本分区未执行——诚实缺失）";
    }
    entered.n += 1;
    bumpDepth(node.depth);

    const isLeaf = node.depth >= depthCap || node.text.length <= input.partitionChars;
    if (!isLeaf) {
      // 行边界二分：优先在换行处切开，失败退回中点
      const mid = Math.floor(node.text.length / 2);
      let split = node.text.indexOf("\n", mid);
      if (split < 0 || split > node.text.length - 1) split = mid;
      const left = { text: node.text.slice(0, split), depth: node.depth + 1, label: `${node.label}.L` };
      const right = { text: node.text.slice(split + 1), depth: node.depth + 1, label: `${node.label}.R` };
      bumpCount(2);
      await gate.reach("before_model");
      const [l, r] = await Promise.all([
        this.runNode(spec, input, budgetId, gate, parentSignal, depthCap, entered, left, outcomes, bumpCount, bumpDepth),
        this.runNode(spec, input, budgetId, gate, parentSignal, depthCap, entered, right, outcomes, bumpCount, bumpDepth),
      ]);
      const nodeId = `n_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
      const missing = [l, r].filter((t) => t.includes("（预算不足") || t.includes("未执行"));
      const merged = await this.answerLeaf(
        spec, input, budgetId, gate, parentSignal,
        `${input.question}\n\n以下是子分区的回答${missing.length > 0 ? `（注意：${missing.length} 个子分区缺失，如实说明覆盖不完整）` : ""}：\n\n【左】${l}\n\n【右】${r}`,
        nodeId, node.depth, `${node.label}(merge)`, node.text.length,
      );
      const ownDenied = merged.includes("BUDGET_EXCEEDED");
      outcomes.push({ nodeId, depth: node.depth, status: missing.length > 0 || ownDenied ? "failed" : "succeeded", text: merged, truncated: missing.length > 0 || ownDenied, chars: node.text.length });
      return merged;
    }

    const truncated = node.depth >= depthCap && node.text.length > input.partitionChars;
    const nodeId = `n_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const text = await this.answerLeaf(
      spec, input, budgetId, gate, parentSignal,
      truncated
        ? `${input.question}\n\n（已达深度上限，以下为分区截断内容——回答必须声明覆盖不完整）\n\n${node.text.slice(0, input.partitionChars)}`
        : `${input.question}\n\n${node.text}`,
      nodeId, node.depth, node.label, node.text.length,
    );
    outcomes.push({ nodeId, depth: node.depth, status: "succeeded", text, truncated, chars: node.text.length });
    return text;
  }

  /** 叶子/合并调用：原子预算预留 → recursion 事件 → 真实模型调用 */
  private async answerLeaf(
    spec: RunSpec,
    input: RecursionInput,
    budgetId: string,
    gate: ControlGate,
    parentSignal: AbortSignal,
    userText: string,
    nodeId: string,
    depth: number,
    label: string,
    sourceChars: number,
  ): Promise<string> {
    const { events, budget, gateway } = this.deps;
    await gate.reach("before_model");

    const res = budget.reserve(budgetId, "model_call", nodeId);
    if (!res.granted) {
      events.transact(() => {
        events.append(spec.id, [
          nodeEvt("recursion.node_completed", { nodeId, depth, label, status: "failed", reason: "BUDGET_EXCEEDED" }),
        ]);
      });
      return "（预算不足，本节点未获准执行 BUDGET_EXCEEDED）";
    }

    const abort = new AbortController();
    const propagate = (): void => abort.abort();
    parentSignal.addEventListener("abort", propagate, { once: true });

    let causeIds: string[] = [];
    events.transact(() => {
      const [e] = events.append(spec.id, [
        nodeEvt("recursion.node_started", { nodeId, depth, label, sourceChars }),
      ]);
      causeIds = e ? [e.eventId] : [];
    });

    try {
      const result = await gateway.invoke(
        this.deps.modelSnapshot,
        [
          { id: "s1", role: "system", content: input.systemPrompt },
          { id: "u1", role: "user", content: userText },
        ],
        { stream: false, maxOutputTokens: input.budget.maxOutputTokens, signal: abort.signal },
      );
      let response = result.response;
      if (result.stream) response = await result.stream.final;
      if (!response) throw new Error("RECURSION_NO_RESPONSE");
      budget.settleUse(budgetId, "model_call", 1, {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      });
      events.transact(() => {
        events.append(spec.id, [
          {
            type: "recursion.node_completed",
            summary: {
              nodeId, depth, label, status: "succeeded",
              answerChars: response.messageText.length,
              usage: { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens },
            },
            causationEventIds: causeIds,
            conceptIds: ["recursion"],
          },
        ]);
      });
      return response.messageText;
    } catch (err) {
      events.transact(() => {
        events.append(spec.id, [
          {
            type: "recursion.node_completed",
            summary: { nodeId, depth, label, status: "failed", reason: String(err).slice(0, 120) },
            causationEventIds: causeIds,
            conceptIds: ["recursion"],
          },
        ]);
      });
      return "（本节点执行失败，覆盖不完整）";
    } finally {
      parentSignal.removeEventListener("abort", propagate);
    }
  }
}

function nodeEvt(type: string, summary: Record<string, unknown>): NewTraceEvent {
  return { type, summary, conceptIds: ["recursion"] };
}
