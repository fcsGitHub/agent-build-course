/**
 * 状态图执行器（T19）。
 * - 节点：model（一次模型调用，带步骤指令）/ tool（注册工具，经 ToolBroker）/ transform（注册纯函数）/ gate（审批门，接 T20）；
 * - 边：注册谓词（evalPredicate），条件分支；
 * - 每节点访问上限 + 全图执行上限（有限循环）；
 * - 事件：graph.node_started / graph.node_completed；每节点一次检查点语义。
 * 依据设计文档 v1.1 §13.1—§13.3、§19.5 L19/L20。
 */
import { randomUUID } from "node:crypto";
import type {
  BudgetLimit,
  GraphDefinition,
  GraphState,
  ModelProfileSnapshot,
  RunSpec,
  RuntimeContext,
  RuntimeResult,
  StopReasonCode,
  ToolSpecForModel,
} from "@agentglass/contracts";
import type { BlobStore, EventStore, NewTraceEvent } from "@agentglass/events";
import type { BudgetLedger } from "@agentglass/policy";
import type { ModelGateway } from "@agentglass/provider-gateway";
import type { ToolBroker } from "@agentglass/tools";
import { evalPredicate, validateGraph } from "./validate";
import { ControlGate, CancelledError } from "@agentglass/runtime-reference";
import { compileContext } from "@agentglass/context";

export const GRAPH_ADAPTER_VERSION = "runtime-graph-1";

export interface GraphRuntimeInput {
  systemPrompt: string;
  taskText: string;
  tools: ToolSpecForModel[];
  allowedToolIds: string[];
  budget: BudgetLimit;
  workspaceRoot: string;
  /** 节点"证据是否充分"判定（注册谓词的数据源；默认按是否已有 search 命中） */
  evidenceCheck?: (state: GraphState) => boolean;
}

export interface GraphCollaborators {
  events: EventStore;
  blobs: BlobStore;
  budget: BudgetLedger;
  gateway: ModelGateway;
  broker: ToolBroker;
  modelSnapshot: ModelProfileSnapshot;
  pollCommands: () => { pauseRequested: boolean; cancelRequested: boolean };
}

export class GraphRuntime {
  readonly id = "graph";
  readonly adapterVersion = GRAPH_ADAPTER_VERSION;

  constructor(private readonly deps: GraphCollaborators) {}

  async execute(
    spec: RunSpec,
    definition: GraphDefinition,
    input: GraphRuntimeInput,
    signal: AbortSignal,
  ): Promise<RuntimeResult> {
    const { events, blobs, budget } = this.deps;

    // 校验失败 → 拒绝执行（不静默改图）
    const errors = validateGraph(definition);
    if (errors.length > 0) {
      events.transact(() => {
        events.append(spec.id, [
          graphEvent("run.failed", { errors: errors.map((e) => `${e.code}:${e.message}`) }),
        ]);
      });
      return { state: "failed", reasonCode: "graph_invalid", outputRefs: [] };
    }

    const budgetId = budget.open(spec.id, input.budget);
    const gate = ControlGate.fromSignal(signal, this.deps.pollCommands);
    let state: GraphState = {
      runId: spec.id,
      taskText: input.taskText,
      outputs: {},
      fields: {},
      visits: {},
      totalExecutions: 0,
      finished: false,
    };

    events.transact(() => {
      events.append(spec.id, [
        graphEvent("run.started", {
          graphId: definition.id,
          graphRevision: definition.revision,
          entry: definition.entryNodeId,
        }),
      ]);
    });

    try {
      let currentNode: string | undefined = definition.entryNodeId;
      while (currentNode && !state.finished) {
        // node:<id> 断点：在每个图节点开始前按节点驻留（before_model 语义兼用于模型节点）
        await gate.reach("before_model", currentNode);
        if (budget.wallDeadlineExceeded(budgetId)) {
          return finish("failed", "budget_wall_time_exhausted");
        }
        const node = definition.nodes.find((n) => n.id === currentNode)!;
        const visits = state.visits[node.id] ?? 0;
        if (visits >= definition.maxNodeVisits) {
          // 访问上限：该节点不再执行，走"never/上限"出口
          currentNode = nextNode(definition, node.id, { visits, maxVisits: definition.maxNodeVisits, evidenceSufficient: true, forcedPredicate: "visits_under_limit" });
          if (!currentNode) {
            return finish("completed", "visit_limit_reached");
          }
          continue;
        }
        const execRes = budget.reserve(budgetId, "turn", `node:${node.id}`);
        if (!execRes.granted) {
          return finish("failed", "budget_turns_exhausted");
        }
        budget.settleUse(budgetId, "turn", 1);

        events.transact(() => {
          events.append(spec.id, [
            graphEvent("graph.node_started", { nodeId: node.id, kind: node.kind, visits: visits + 1 }),
          ]);
        });

        state = {
          ...state,
          visits: { ...state.visits, [node.id]: visits + 1 },
          totalExecutions: state.totalExecutions + 1,
        };
        if (state.totalExecutions > definition.maxTotalExecutions) {
          return finish("failed", "budget_turns_exhausted");
        }

        let outputText = "";
        if (node.kind === "model") {
          const modelRes = budget.reserve(budgetId, "model_call", "graph");
          if (!modelRes.granted) return finish("failed", "budget_model_calls_exhausted");
          const stepInput = {
            ...input,
            systemPrompt: `${input.systemPrompt}\n\n【图节点 ${node.id}】${node.handlerId}`,
            tools: node.allowTools ? input.tools : [],
            allowedToolIds: node.allowTools ? input.allowedToolIds : [],
          };
          const compiled = compileForNode(spec.id, this.deps, stepInput, state, node.id);
          const body = this.deps.blobs.getJson<unknown>(compiled.messageBodyRef.id);
          const result = await invokeModelNode(this.deps, spec, budgetId, body, stepInput, signal);
          budget.settleUse(budgetId, "model_call", 1, {
            inputTokens: result.response.usage.inputTokens,
            outputTokens: result.response.usage.outputTokens,
          });
          outputText = result.response.messageText;
          // 工具请求（allowTools 节点）
          if (result.response.toolRequests.length > 0 && node.allowTools) {
            const executed = await executeNodeTools(
              this.deps,
              spec,
              input,
              callRequests(result.response.toolRequests),
            );
            state.fields[`tools:${node.id}`] = executed;
          }
        } else if (node.kind === "tool") {
          const args = resolveArgs(node.argsTemplate ?? {}, state);
          const toolRes = budget.reserve(budgetId, "tool_call", "graph");
          if (!toolRes.granted) return finish("failed", "budget_tool_calls_exhausted");
          const callId = `call_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
          events.transact(() => {
            events.append(spec.id, [
              graphEvent("tool.proposed", {
                callId,
                toolId: node.handlerId,
                argumentsText: JSON.stringify(args).slice(0, 300),
                executed: false,
                nodeId: node.id,
              }),
              graphEvent("tool.validated", { callId, toolId: node.handlerId, nodeId: node.id }),
            ]);
          });
          const result = await this.deps.broker.execute({
            toolId: node.handlerId,
            revision: "1.0.0",
            args,
            ctx: {
              runId: spec.id,
              workspaceRoot: input.workspaceRoot,
              allowedToolIds: input.allowedToolIds,
              deadlineAt: new Date(Date.now() + input.budget.maxWallTimeMs).toISOString(),
              maxOutputBytes: 512 * 1024,
            },
            idempotencyKey: `${spec.id}:${node.id}:${state.visits[node.id]}`,
          });
          budget.settleUse(budgetId, "tool_call", 1);
          outputText = JSON.stringify(result.outputSummary ?? { error: result.errorMessage ?? result.reasonCode });
          const resultRef = blobs.putText(outputText);
          events.transact(() => {
            events.append(spec.id, [
              graphEvent("tool.call_completed", {
                callId,
                toolId: node.handlerId,
                status: result.status,
                reasonCode: result.reasonCode ?? null,
                nodeId: node.id,
              }, resultRef),
            ]);
          });
          state.fields[`tools:${node.id}:${state.visits[node.id]}`] = result.outputSummary ?? { status: result.status };
        } else if (node.kind === "transform") {
          outputText = applyTransform(node.handlerId, state);
        } else if (node.kind === "gate") {
          // 审批门：审批语义由平台策略层实现（T20 集成点）；基础图把 gate 视作
          // "需要 run 处于有效授权"——由 worker 注入的 approvalCheck 决定。
          const check = input.evidenceCheck?.(state) ?? true;
          outputText = check ? "gate:pass" : "gate:blocked";
        }

        state = {
          ...state,
          outputs: { ...state.outputs, [node.id]: outputText.slice(0, 4000) },
        };

        const stateRef = blobs.putJson(state);
        events.transact(() => {
          events.append(spec.id, [
            graphEvent("graph.node_completed", {
              nodeId: node.id,
              kind: node.kind,
              outputChars: outputText.length,
            }),
            graphEvent("checkpoint.committed", {
              checkpointKind: "graph_node",
              nodeId: node.id,
              stateSchemaVersion: "graph-state-v1",
              stateRef: stateRef.id,
            }),
          ]);
        });

        if (definition.exitNodeIds.includes(node.id)) {
          state.finished = true;
          const finalRef = blobs.putText(outputText, "text/plain; charset=utf-8");
          events.transact(() => {
            events.append(spec.id, [
              graphEvent("run.completed", { stopReason: "final_answer", lastNode: node.id, outputRef: finalRef.id }),
            ]);
          });
          return { state: "completed", reasonCode: "final_answer", outputRefs: [finalRef] };
        }

        currentNode = nextNode(definition, node.id, {
          visits: state.visits[node.id] ?? 0,
          maxVisits: definition.maxNodeVisits,
          evidenceSufficient: input.evidenceCheck?.(state) ?? hasSearchEvidence(state),
        });
        if (!currentNode) {
          return finish("completed", "no_outgoing_edge_taken");
        }
      }
      return finish("completed", "graph_finished");
    } catch (err) {
      if (err instanceof CancelledError) {
        return { state: "cancelled", reasonCode: "cancelled", outputRefs: [] };
      }
      events.transact(() => {
        events.append(spec.id, [
          graphEvent("run.failed", { error: String(err).slice(0, 400) }),
        ]);
      });
      return { state: "failed", reasonCode: "graph_error", outputRefs: [] };
    }

    function finish(stateName: "completed" | "failed", reason: StopReasonCode | string): RuntimeResult {
      const st = state;
      events.transact(() => {
        events.append(spec.id, [
          graphEvent(stateName === "completed" ? "run.completed" : "run.failed", {
            stopReason: reason,
            totalExecutions: st.totalExecutions,
          }),
        ]);
      });
      void budgetId;
      return {
        state: stateName,
        reasonCode: reason,
        outputRefs: [],
      };
    }
  }
}

// ---- 辅助 ----

function nextNode(
  def: GraphDefinition,
  from: string,
  ctx: { visits: number; maxVisits: number; evidenceSufficient: boolean; forcedPredicate?: string },
): string | undefined {
  const outEdges = def.edges.filter((e) => e.from === from);
  for (const e of outEdges) {
    const predicate = ctx.forcedPredicate === "visits_under_limit" && e.predicateId === "visits_under_limit"
      ? "visits_under_limit"
      : e.predicateId;
    if (evalPredicate(predicate, ctx)) return e.to;
  }
  // 无谓词命中的出边集合里找 always（保持顺序）
  const always = outEdges.find((e) => !e.predicateId || e.predicateId === "always");
  return always?.to;
}

function callRequests(trs: Array<{ id: string; name: string; argumentsText: string; arguments?: import("@agentglass/contracts").JsonValue; parseError?: string }>) {
  return trs;
}

async function executeNodeTools(
  deps: GraphCollaborators,
  spec: RunSpec,
  input: GraphRuntimeInput,
  toolRequests: Array<{ id: string; name: string; argumentsText: string; arguments?: import("@agentglass/contracts").JsonValue; parseError?: string }>,
): Promise<unknown> {
  const results: unknown[] = [];
  for (const tr of toolRequests) {
    const result = await deps.broker.execute({
      toolId: tr.name,
      revision: "1.0.0",
      args: tr.arguments ?? {},
      ctx: {
        runId: spec.id,
        workspaceRoot: input.workspaceRoot,
        allowedToolIds: input.allowedToolIds,
        deadlineAt: new Date(Date.now() + input.budget.maxWallTimeMs).toISOString(),
        maxOutputBytes: 512 * 1024,
      },
      idempotencyKey: `${spec.id}:${tr.id}`,
    });
    results.push({ toolId: tr.name, status: result.status, output: result.outputSummary ?? null });
  }
  return results;
}

const TRANSFORMS: Record<string, (state: GraphState) => string> = {
  "plan-to-text": (state) => {
    const plan = state.fields.plan as Array<{ step: string; done?: boolean }> | undefined;
    if (!Array.isArray(plan)) return "（无计划）";
    return plan.map((p, i) => `${i + 1}. ${p.step}${p.done ? " ✓" : ""}`).join("\n");
  },
  "evidence-summary": (state) => {
    const keys = Object.keys(state.fields).filter((k) => k.startsWith("tools:"));
    return `已收集 ${keys.length} 次工具证据`;
  },
};

function applyTransform(handlerId: string, state: GraphState): string {
  const fn = TRANSFORMS[handlerId];
  if (!fn) return `（未注册转换器: ${handlerId}）`;
  return fn(state);
}

function resolveArgs(
  template: Record<string, string>,
  state: GraphState,
): import("@agentglass/contracts").JsonValue {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(template)) {
    if (v.startsWith("{{task}}")) out[k] = state.taskText.slice(0, 120);
    else if (v.startsWith("{{last:")) out[k] = state.outputs[v.slice(7, -2)] ?? "";
    else out[k] = v;
  }
  return out as import("@agentglass/contracts").JsonValue;
}

function hasSearchEvidence(state: GraphState): boolean {
  return Object.entries(state.fields).some(([k, v]) => {
    if (!k.startsWith("tools:")) return false;
    const arr = v as Array<{ toolId?: string; output?: { hit_count?: number } }>;
    return Array.isArray(arr) && arr.some((x) => x.toolId === "search_documents" && (x.output?.hit_count ?? 0) > 0);
  });
}

function compileForNode(
  runId: string,
  deps: GraphCollaborators,
  input: GraphRuntimeInput,
  state: GraphState,
  nodeId: string,
) {
  // 图节点的上下文：system + 任务 + 此前节点输出摘要（按 reducer graph-state-v1）
  const prior = Object.entries(state.outputs)
    .map(([id, text]) => `【节点 ${id}】${text.slice(0, 600)}`)
    .join("\n\n");
  const compiled = compileContext(
    {
      runId,
      systemPrompt: input.systemPrompt,
      toolSchemas: input.tools,
      candidates: [
        { id: "task", role: "user", content: input.taskText },
        ...(prior ? [{ id: `graph:${nodeId}:prior`, role: "user" as const, content: `此前节点输出：\n${prior}` }] : []),
      ],
      budget: {
        contextLimit: deps.modelSnapshot.capabilities.contextWindow ?? 32_000,
        outputReserveTokens: 2048,
        safetyReserveTokens: 512,
      },
    },
    (v) => deps.blobs.putJson(v),
  );
  return compiled.compiled;
}

async function invokeModelNode(
  deps: GraphCollaborators,
  spec: RunSpec,
  budgetId: string,
  bodyValue: unknown,
  input: GraphRuntimeInput,
  signal: AbortSignal,
): Promise<{ response: import("@agentglass/contracts").ModelResponse }> {
  const bodyJson = bodyValue as { messages?: unknown[] };
  const result = await deps.gateway.invoke(deps.modelSnapshot, bodyJson.messages ?? [], {
    stream: false,
    tools: input.tools.length > 0 ? input.tools : undefined,
    maxOutputTokens: input.budget.maxOutputTokens,
    signal,
  });
  let response = result.response;
  if (result.stream) {
    response = await result.stream.final;
  }
  if (!response) throw new Error("GRAPH_MODEL_NO_RESPONSE");
  deps.events.transact(() => {
    deps.events.append(spec.id, [
      {
        type: "model.response_completed",
        summary: {
          finishReason: response.finishReason,
          toolRequestCount: response.toolRequests.length,
          usage: { inputTokens: response.usage.inputTokens ?? null, outputTokens: response.usage.outputTokens ?? null },
          messageChars: response.messageText.length,
        },
        payloadRef: deps.blobs.putText(response.messageText || response.rawText),
        conceptIds: ["graph", "model-response"],
      },
    ]);
  });
  void budgetId;
  return { response };
}

function graphEvent(
  type: string,
  summary: Record<string, unknown>,
  payloadRef?: import("@agentglass/contracts").BlobRef,
): NewTraceEvent {
  return {
    type,
    summary,
    payloadRef,
    conceptIds: ["state-graph"],
  };
}

export function newGraphRunId(): string {
  return `gr_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
