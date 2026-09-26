/**
 * 多 Agent 协调器（T27）。
 * - 三种拓扑语义：parallel（并行研究，确定性合并）、handoff（控制权串行移交）、blackboard（并发写黑板，冲突保留两版本）；
 * - TaskEnvelope：子任务预算从父预算**原子预留**（共享 BudgetLedger，同一 budgetId 多 owner）；
 * - 取消传播：父 AbortSignal → 全部子 AbortController；
 * - 因果：agent.delegated / agent.result_received 事件 + causationEventIds 链；
 * - 上下文隔离：子 agent 只见任务包文本与白名单工具，不见父对话。
 * 依据设计文档 v1.1 §16、验收 T27/A07 相邻面。
 */
import { randomUUID } from "node:crypto";
import type {
  BudgetLimit,
  MergeRecord,
  ModelProfileSnapshot,
  RunSpec,
  RuntimeResult,
  StopReasonCode,
  ToolSpecForModel,
} from "@agentglass/contracts";
import type { BlobStore, EventStore, NewTraceEvent } from "@agentglass/events";
import type { BudgetLedger } from "@agentglass/policy";
import type { ModelGateway } from "@agentglass/provider-gateway";
import type { ToolBroker } from "@agentglass/tools";
import { compileContext } from "@agentglass/context";
import { ControlGate, CancelledError } from "@agentglass/runtime-reference";

export const MULTI_AGENT_ADAPTER_VERSION = "multi-agent-1";
export const STATE_SCHEMA_VERSION = "multi-agent-state-v1";

export type Topology = "parallel" | "handoff" | "blackboard";

export interface WorkerDef {
  id: string;
  goal: string;
  tools: string[];
}

export interface MultiAgentInput {
  topology: Topology;
  systemPrompt: string;
  taskText: string;
  /** supervisor/parallel 的 worker 定义（goal 模板 + 工具白名单） */
  workers: WorkerDef[];
  /** handoff 顺序（handoff 拓扑时的移交链） */
  handoffChain?: string[];
  tools: ToolSpecForModel[];
  allowedToolIds: string[];
  budget: BudgetLimit;
  workspaceRoot: string;
  /** 并发写同一黑板键的制造开关（L32 教学注入；默认 false） */
  forceConflictKey?: string | null;
}

export interface MultiAgentCollaborators {
  events: EventStore;
  blobs: BlobStore;
  budget: BudgetLedger;
  gateway: ModelGateway;
  broker: ToolBroker;
  modelSnapshot: ModelProfileSnapshot;
  pollCommands: () => { pauseRequested: boolean; cancelRequested: boolean };
}

interface WorkerOutcome {
  taskId: string;
  workerId: string;
  status: "succeeded" | "failed" | "cancelled";
  text: string;
  causeEventIds: string[];
}

export class MultiAgentCoordinator {
  readonly id = "multi-agent";
  readonly adapterVersion = MULTI_AGENT_ADAPTER_VERSION;
  private blackboard = new Map<string, MergeRecord>();

  constructor(private readonly deps: MultiAgentCollaborators) {}

  async execute(
    spec: RunSpec,
    input: MultiAgentInput,
    signal: AbortSignal,
  ): Promise<RuntimeResult> {
    const { events, blobs, budget } = this.deps;
    const budgetId = budget.open(spec.id, input.budget);
    const gate = ControlGate.fromSignal(signal, this.deps.pollCommands);

    events.transact(() => {
      events.append(spec.id, [
        evt("run.started", {
          topology: input.topology,
          workers: input.workers.map((w) => w.id),
          adapter: this.adapterVersion,
        }),
      ]);
    });

    try {
      const outcomes: WorkerOutcome[] = [];
      const outputRefs: import("@agentglass/contracts").BlobRef[] = [];

      if (input.topology === "handoff") {
        // 控制权串行移交：前一个 worker 的输出成为下一个的输入
        const chain = input.handoffChain ?? input.workers.map((w) => w.id);
        let carry = input.taskText;
        for (const workerId of chain) {
          await gate.reach("before_model");
          const worker = input.workers.find((w) => w.id === workerId);
          if (!worker) continue;
          const r = await this.runWorker(spec, budgetId, input, worker, carry, signal, outcomes);
          outcomes.push(r.outcome);
          carry = r.text;
          if (workerId === chain.at(-1)) {
            const finalRef = blobs.putText(r.text, "text/plain; charset=utf-8");
            outputRefs.push(finalRef);
            events.transact(() => {
              events.append(spec.id, [
                evt("agent.handed_off", { from: workerId, to: "(final)", final: true }),
              ]);
            });
          } else {
            events.transact(() => {
              events.append(spec.id, [
                evt("agent.handed_off", { from: workerId, to: chain[chain.indexOf(workerId) + 1] }),
              ]);
            });
          }
        }
      } else {
        // parallel / blackboard：并发 worker，各自独立上下文与因果链
        const settled = await Promise.all(
          input.workers.map((worker) =>
            this.runWorker(spec, budgetId, input, worker, input.taskText, signal, outcomes),
          ),
        );
        outcomes.push(...settled.map((s) => s.outcome));

        if (input.topology === "parallel") {
          // 确定性合并：按任务声明顺序（非完成顺序）汇合
          const merged = input.workers
            .map((w) => outcomes.find((o) => o.workerId === w.id))
            .filter((o): o is WorkerOutcome => o != null && o.status === "succeeded")
            .map((o) => `【${o.workerId}】${o.text}`);
          const text = merged.join("\n\n");
          outputRefs.push(blobs.putText(text, "text/plain; charset=utf-8"));
        }

        if (input.topology === "blackboard") {
          // 并发写黑板：同键冲突 → 保留两版本（不静默覆盖）
          const key = input.forceConflictKey ?? "shared-findings";
          const writes = settled
            .filter((s) => s.noteWrite != null)
            .map((s) => s.noteWrite!);
          let record = this.blackboard.get(key);
          for (const w of writes) {
            if (record && record.versions.some((v) => v.content !== w.content)) {
              record = {
                ...record,
                conflict: true,
                versions: [...record.versions, { taskId: w.taskId, content: w.content }],
                mergedBy: "conflict-kept-both",
              };
            } else if (record) {
              record = {
                ...record,
                versions: [...record.versions, { taskId: w.taskId, content: w.content }],
              };
            } else {
              record = {
                key,
                conflict: false,
                versions: [{ taskId: w.taskId, content: w.content }],
                mergedBy: "sequential",
                causeEventIds: [],
              };
            }
          }
          if (record) {
            this.blackboard.set(key, record);
            const recordRef = blobs.putJson(record);
            events.transact(() => {
              events.append(spec.id, [
                evt("agent.result_received", {
                  blackboardKey: key,
                  conflict: record!.conflict,
                  versions: record!.versions.length,
                  mergedBy: record!.mergedBy,
                  recordRef: recordRef.id,
                }),
              ]);
            });
          }
          const text = (record?.versions ?? [])
            .map((v) => `【${v.taskId}】${v.content}`)
            .join("\n\n");
          outputRefs.push(blobs.putText(text, "text/plain; charset=utf-8"));
        }
      }

      const anyCancelled = outcomes.some((o) => o.status === "cancelled");
      const allFailed = outcomes.every((o) => o.status === "failed");
      const stopReason: StopReasonCode = anyCancelled
        ? "cancelled"
        : allFailed
          ? "model_error"
          : "final_answer";
      const finalRef = blobs.putText(
        outputRefs.at(-1) ? this.deps.blobs.getText(outputRefs.at(-1)!.id) : "",
        "text/plain; charset=utf-8",
      );
      events.transact(() => {
        events.append(spec.id, [
          evt("run.completed", {
            stopReason,
            workers: outcomes.length,
            succeeded: outcomes.filter((o) => o.status === "succeeded").length,
            outputRef: finalRef.id,
          }),
        ]);
      });
      return {
        state: stopReason === "cancelled" ? "cancelled" : "completed",
        reasonCode: stopReason,
        outputRefs: [finalRef],
      };
    } catch (err) {
      if (err instanceof CancelledError) {
        return { state: "cancelled", reasonCode: "cancelled", outputRefs: [] };
      }
      events.transact(() => {
        events.append(spec.id, [
          evt("run.failed", { error: String(err).slice(0, 400) }),
        ]);
      });
      return { state: "failed", reasonCode: "coordinator_error", outputRefs: [] };
    }

    function evt(type: string, summary: Record<string, unknown>, payloadRef?: import("@agentglass/contracts").BlobRef): NewTraceEvent {
      return { type, summary, payloadRef, conceptIds: ["multi-agent"] };
    }
  }

  /** 单个子 agent：独立上下文（任务包文本）、原子预算预留、因果链、取消传播 */
  /**
   * 子 agent 模型调用：与主循环同一可观测合同——请求准备（wire 证据）→ 派发 →
   * 流式 delta（能力支持时）→ 完成/失败。所有事件 summary 携带 workerId，
   * 前端据此把流式回合归属到对应 worker（多 agent 通信输出）。
   */
  private async invokeWorkerModel(
    spec: RunSpec,
    input: MultiAgentInput,
    worker: WorkerDef,
    taskId: string,
    messages: unknown[],
    causeEventIds: string[],
    signal: AbortSignal,
  ): Promise<import("@agentglass/contracts").ModelResponse> {
    const { events, gateway, blobs, modelSnapshot } = this.deps;
    const stream = modelSnapshot.capabilities.streaming === true;
    const wireBody = {
      messages,
      model: modelSnapshot.modelId,
      stream,
      max_tokens: input.budget.maxOutputTokens,
    };
    const wireRef = blobs.putJson(wireBody);
    events.transact(() => {
      events.append(spec.id, [
        {
          type: "model.request_prepared",
          summary: {
            workerId: worker.id,
            taskId,
            modelId: modelSnapshot.modelId,
            provider: modelSnapshot.provider,
            stream,
            wireCapture: true,
          },
          payloadRef: wireRef,
          causationEventIds: causeEventIds,
          conceptIds: ["model-request", "multi-agent"],
        },
      ]);
    });
    events.transact(() => {
      events.append(spec.id, [
        {
          type: "model.request_dispatched",
          summary: { workerId: worker.id, taskId, attempt: 1 },
          causationEventIds: causeEventIds,
          conceptIds: ["model-request", "multi-agent"],
        },
      ]);
    });
    try {
      const result = await gateway.invoke(modelSnapshot, messages, {
        stream,
        tools: worker.tools.length > 0 ? input.tools.filter((t) => worker.tools.includes(t.name)) : undefined,
        maxOutputTokens: input.budget.maxOutputTokens,
        signal,
      });
      let response: import("@agentglass/contracts").ModelResponse;
      if (result.stream) {
        let batchChars = 0;
        let batchBuffer = "";
        for await (const batch of result.stream.deltas) {
          for (const d of batch) {
            if (d.kind === "text") {
              batchBuffer += d.text;
              batchChars += d.text.length;
            }
          }
          if (batchChars >= 64) {
            const payloadRef = blobs.putText(batchBuffer);
            events.transact(() => {
              events.append(spec.id, [
                {
                  type: "model.delta_batch",
                  summary: { workerId: worker.id, taskId, chars: batchChars },
                  payloadRef,
                  causationEventIds: causeEventIds,
                  conceptIds: ["streaming", "multi-agent"],
                },
              ]);
            });
            batchChars = 0;
            batchBuffer = "";
          }
        }
        response = await result.stream.final;
      } else {
        if (!result.response) throw new Error("PROVIDER_RETURNED_NEITHER_STREAM_NOR_RESPONSE");
        response = result.response;
      }
      if (response.finishReason === "length") {
        events.transact(() => {
          events.append(spec.id, [
            {
              type: "model.response_truncated",
              summary: { workerId: worker.id, taskId, finishReason: "length" },
              causationEventIds: causeEventIds,
              conceptIds: ["model-response", "multi-agent"],
            },
          ]);
        });
      }
      events.transact(() => {
        events.append(spec.id, [
          {
            type: "model.response_completed",
            summary: {
              workerId: worker.id,
              taskId,
              finishReason: response.finishReason,
              toolRequestCount: response.toolRequests.length,
              usage: {
                inputTokens: response.usage.inputTokens ?? null,
                outputTokens: response.usage.outputTokens ?? null,
              },
              messageChars: response.messageText.length,
            },
            payloadRef: blobs.putText(response.messageText || response.rawText),
            causationEventIds: causeEventIds,
            conceptIds: ["model-response", "multi-agent"],
          },
        ]);
      });
      return response;
    } catch (err) {
      events.transact(() => {
        events.append(spec.id, [
          {
            type: "model.request_failed",
            summary: { workerId: worker.id, taskId, error: String(err).slice(0, 300) },
            causationEventIds: causeEventIds,
            conceptIds: ["model-request", "multi-agent"],
          },
        ]);
      });
      throw err;
    }
  }

  private async runWorker(
    spec: RunSpec,
    budgetId: string,
    input: MultiAgentInput,
    worker: WorkerDef,
    taskText: string,
    parentSignal: AbortSignal,
    _outcomes: WorkerOutcome[],
  ): Promise<{ outcome: WorkerOutcome; text: string; noteWrite?: { taskId: string; content: string } }> {
    const { events, budget } = this.deps;
    const taskId = `task_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const childAbort = new AbortController();
    // 取消传播：父取消 → 子取消
    const propagate = (): void => childAbort.abort();
    parentSignal.addEventListener("abort", propagate, { once: true });

    // 原子预留：多个并发子任务从同一 budget 行扣减（超出即拒绝）
    const modelRes = budget.reserve(budgetId, "model_call", taskId);
    if (!modelRes.granted) {
      parentSignal.removeEventListener("abort", propagate);
      const outcome: WorkerOutcome = {
        taskId,
        workerId: worker.id,
        status: "failed",
        text: "（预算不足，子任务未获准）",
        causeEventIds: [],
      };
      events.transact(() => {
        events.append(spec.id, [
          evt("agent.result_received", { taskId, workerId: worker.id, status: "failed", reason: "BUDGET_EXCEEDED" }),
        ]);
      });
      return { outcome, text: outcome.text };
    }

    const delegatedEvent = evt("agent.delegated", {
      taskId,
      workerId: worker.id,
      goal: worker.goal.slice(0, 160),
      depth: 1,
      tools: worker.tools,
    });
    let causeIds: string[] = [];
    events.transact(() => {
      const [e] = events.append(spec.id, [delegatedEvent]);
      causeIds = e ? [e.eventId] : [];
    });

    try {
      const compiled = compileWorkerContext(
        this.deps,
        spec.id,
        input,
        worker,
        taskText,
      );
      // 子 agent 上下文隔离的证据：编译结果入账本（前端上下文检视器可逐 worker 检视）
      events.transact(() => {
        events.append(spec.id, [
          {
            type: "context.compiled",
            summary: {
              workerId: worker.id,
              taskId,
              compiledContextId: compiled.callId,
              included: compiled.items.filter((i) => i.selected).length,
              excluded: compiled.items.filter((i) => !i.selected).length,
              estimatedInputTokens: compiled.estimatedInputTokens,
              isolation: "worker-only（不见父对话与其他 worker 输出）",
            },
            payloadRef: compiled.messageBodyRef,
            causationEventIds: causeIds,
            conceptIds: ["context-compilation", "multi-agent"],
          },
        ]);
      });
      const body = this.deps.blobs.getJson<{ messages?: unknown[] }>(compiled.messageBodyRef.id);
      const response = await this.invokeWorkerModel(
        spec,
        input,
        worker,
        taskId,
        body.messages ?? [],
        causeIds,
        childAbort.signal,
      );
      budget.settleUse(budgetId, "model_call", 1, {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      });

      let noteWrite: { taskId: string; content: string } | undefined;
      if (input.topology === "blackboard" && response.toolRequests.length > 0) {
        // blackboard 拓扑下的工具请求：本版本 worker 无独立工具代理循环，
        // 将请求记录为证据（诚实：不冒充已执行）
        noteWrite = { taskId, content: response.messageText.slice(0, 400) };
      } else if (input.topology === "blackboard") {
        // 黑板写入带 worker 视角前缀：不同 worker 对同一键的独立贡献
        noteWrite = { taskId, content: `【${worker.id} 视角】${response.messageText.slice(0, 300)}` };
      }

      events.transact(() => {
        events.append(spec.id, [
          {
            type: "agent.result_received",
            summary: { taskId, workerId: worker.id, status: "succeeded", outputChars: response.messageText.length },
            causationEventIds: causeIds,
            conceptIds: ["multi-agent"],
          },
        ]);
      });
      parentSignal.removeEventListener("abort", propagate);
      return {
        outcome: {
          taskId,
          workerId: worker.id,
          status: "succeeded",
          text: response.messageText,
          causeEventIds: causeIds,
        },
        text: response.messageText,
        noteWrite,
      };
    } catch (err) {
      parentSignal.removeEventListener("abort", propagate);
      const cancelled = childAbort.signal.aborted || err instanceof CancelledError;
      events.transact(() => {
        events.append(spec.id, [
          {
            type: "agent.result_received",
            summary: {
              taskId,
              workerId: worker.id,
              status: cancelled ? "cancelled" : "failed",
              error: String(err).slice(0, 160),
            },
            causationEventIds: causeIds,
            conceptIds: ["multi-agent"],
          },
        ]);
      });
      return {
        outcome: {
          taskId,
          workerId: worker.id,
          status: cancelled ? "cancelled" : "failed",
          text: "",
          causeEventIds: causeIds,
        },
        text: "",
      };
    }
  }
}

function compileWorkerContext(
  deps: MultiAgentCollaborators,
  runId: string,
  input: MultiAgentInput,
  worker: WorkerDef,
  taskText: string,
) {
  // 上下文隔离：子 agent 只见自己的任务包（goal + 任务文本摘要），不见父对话与其他 worker 输出
  const toolSchemas = input.tools.filter((t) => worker.tools.includes(t.name));
  const compiled = compileContext(
    {
      runId,
      systemPrompt: `${input.systemPrompt}\n\n【你是子任务执行者 ${worker.id}】${worker.goal}`,
      toolSchemas,
      candidates: [{ id: `worker:${worker.id}:task`, role: "user", content: taskText.slice(0, 800) }],
      budget: {
        contextLimit: deps.modelSnapshot.capabilities.contextWindow ?? 32_000,
        outputReserveTokens: 1024,
        safetyReserveTokens: 256,
      },
    },
    (v) => deps.blobs.putJson(v),
  );
  return compiled.compiled;
}

function evt(type: string, summary: Record<string, unknown>, payloadRef?: import("@agentglass/contracts").BlobRef): NewTraceEvent {
  return { type, summary, payloadRef, conceptIds: ["multi-agent"] };
}

