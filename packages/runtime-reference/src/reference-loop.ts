/**
 * 透明参考循环（T06）。教学核心文件：小而完整、可直接阅读。
 * 真实模型调用 + 真实工具执行 + 显式停止原因 + 预算硬边界 + 可暂停边界。
 * 依据设计文档 v1.1 第 3.1/5.1/8.4/9.8 节。
 */
import { randomUUID } from "node:crypto";
import type {
  BlobRef,
  Boundary,
  BudgetLimit,
  JsonValue,
  ModelProfileSnapshot,
  ModelResponse,
  RunSpec,
  RuntimeContext,
  RuntimeResult,
  StopReasonCode,
  ToolSpecForModel,
} from "@agentglass/contracts";
import type { BlobStore, EventStore, NewTraceEvent } from "@agentglass/events";
import type { BudgetLedger } from "@agentglass/policy";
import type { ModelGateway } from "@agentglass/provider-gateway";
import { FakeProviderError } from "@agentglass/provider-gateway";
import { compileContext } from "@agentglass/context";
import type { ContextCandidate } from "@agentglass/context";
import type { ToolBroker } from "@agentglass/tools";
import { ControlGate, CancelledError } from "./control-gate";
import type { LessonExtensionHost, LoopObservation } from "./extension-bindings";
import { DEFAULT_LOOP_CONTINUE } from "./extension-bindings";

export const REFERENCE_ADAPTER_VERSION = "reference-loop-1";
export const STATE_SCHEMA_VERSION = "lesson-state-v1";

/** 课程运行时输入（由 worker 从课程包与运行记录装配） */
export interface LessonRuntimeInput {
  profile: "single_call" | "agent_loop" | "chain" | "graph" | "multi_agent" | "recursion" | "rsi";
  systemPrompt: string;
  /** 会话前缀候选（已接纳输入的既有轮次） */
  priorCandidates: ContextCandidate[];
  /** 本次任务输入正文 */
  taskText: string;
  tools: ToolSpecForModel[];
  allowedToolIds: string[];
  budget: BudgetLimit;
  /** 工具执行工作区（run 专属目录；与平台代码隔离） */
  workspaceRoot: string;
  /** 流式输出 */
  stream: boolean;
  structuredOutput?: { schemaId: string };
  /** 工具结果文本上限（进上下文前截断，完整内容走工件） */
  maxToolResultChars: number;
  /** 固定工作流链（L08）：按序执行的步骤；提供时 profile 视为 chain */
  chainSteps?: Array<{ instruction: string; allowTools: boolean }>;
  /** 上下文压缩策略（L15）：tool_result_head 把历史工具结果压缩为首段+指针 */
  compaction?: "none" | "tool_result_head";
  /** T30：chain 步骤工具失败后注入失败反思（下一步建议） */
  reflectionOnFailure?: boolean;
}

export interface LoopCollaborators {
  events: EventStore;
  blobs: BlobStore;
  budget: BudgetLedger;
  gateway: ModelGateway;
  broker: ToolBroker;
  extensions: LessonExtensionHost;
  modelSnapshot: ModelProfileSnapshot;
  pollCommands: () => { pauseRequested: boolean; cancelRequested: boolean };
  gateHooks?: import("./control-gate").ControlGateEvents;
  /** T23 harness hooks：after_model 阶段（含 diff 落事件）；安全路径（授权/预算）不经过 hooks */
  hooks?: import("@agentglass/harness").HookRegistry;
  /** T30 反思服务（失败分析/记录/注入） */
  reflection?: import("@agentglass/evolution").ReflectionService;
  /** T20 审批集成：gated 工具在派发前必须持有有效审批；未批准时运行驻留（awaiting_approval） */
  approval?: {
    gatedToolIds: string[];
    request(
      runId: string,
      toolId: string,
      toolRevision: string,
      args: Record<string, unknown>,
    ): string;
    verify(approvalId: string, args: Record<string, unknown>): { valid: boolean; reason?: string };
    waitDecision(approvalId: string, signal: AbortSignal): Promise<"granted" | "rejected">;
    onStateChange(state: "awaiting_approval" | "running"): void;
  };
}

interface RunMessage extends ContextCandidate {
  /** 原子组关联（assistant tool_calls / tool result 配对） */
}

export class ReferenceRuntime {
  readonly id = "reference";
  readonly adapterVersion = REFERENCE_ADAPTER_VERSION;

  capabilities() {
    return {
      boundaries: ["before_model", "after_model", "before_tool", "after_tool", "turn_end"] as Boundary[],
      contextCapture: "wire_and_compiled" as const,
      resume: "turn_boundary" as const,
      fork: "input_only" as const,
      toolInterception: true,
      nestedRuns: false,
      editableSlots: ["loop_continue"],
      revisionFork: "same_revision_only" as const,
    };
  }

  constructor(private readonly deps: LoopCollaborators) {}

  async start(
    spec: RunSpec,
    ctx: RuntimeContext,
    signal: AbortSignal,
    lessonInput: LessonRuntimeInput,
  ): Promise<RuntimeResult> {
    const { events, blobs, budget } = this.deps;
    const startedAt = Date.now();
    const budgetId = budget.open(spec.id, lessonInput.budget);
    const gate = ControlGate.fromSignal(signal, this.deps.pollCommands, this.deps.gateHooks);

    // run.started
    events.transact(() => {
      events.append(spec.id, [
        event("run.started", {
          summary: {
            profile: lessonInput.profile,
            adapter: this.adapterVersion,
            agentRevisionId: spec.agentRevisionId,
            modelProvider: this.deps.modelSnapshot.provider,
            modelId: this.deps.modelSnapshot.modelId,
          },
        }),
      ]);
    });

    const messages: RunMessage[] = [...lessonInput.priorCandidates];
    messages.push({ id: `m${messages.length + 1}`, role: "user", content: lessonInput.taskText });

    let stopReason: StopReasonCode | null = null;
    let finalText = "";
    let completedTurns = 0;
    let hasNewObservation = true;
    let lastCallHadToolRequests = false;

    const outputRefs: BlobRef[] = [];

    try {
      if (lessonInput.profile === "single_call") {
        const r = await this.runSingleCall(spec, gate, lessonInput, messages, budgetId, signal);
        finalText = r.finalText;
        outputRefs.push(...r.outputRefs);
        stopReason = r.stopReason;
      } else if (lessonInput.chainSteps && lessonInput.chainSteps.length > 0) {
        // —— 固定工作流链（L08）：路径由程序决定，不由模型决定 ——
        const r = await this.runChain(spec, gate, lessonInput, messages, budgetId, signal);
        finalText = r.finalText;
        stopReason = r.stopReason;
        completedTurns = r.completedTurns;
      } else {
        // —— 观察与行动循环 ——
        for (;;) {
          // 循环顶安全边界：只响应手动暂停/取消。turn_end 断点语义 = 每轮结束后
          // （检查点提交前，见循环底部），否则第 0 轮与每轮结束后会重复驻留
          await gate.reach("turn_end", undefined, { ignoreBreakpoints: true });
          if (budget.wallDeadlineExceeded(budgetId)) {
            stopReason = "budget_wall_time_exhausted";
            break;
          }
          // 1) 循环继续判定：先经学习者扩展点（隔离客体），宿主仍执行硬上限
          if (completedTurns > 0) {
            hasNewObservation = lastCallHadToolRequests;
            const observation: LoopObservation = {
              completedTurns,
              hasNewObservation,
              finalAnswerReady: !lastCallHadToolRequests,
            };
            const ext = await this.deps.extensions.call({ slot: "loop_continue", arg: observation });
            let continueDecision: boolean | null = null;
            let decisionSource = "learner_policy";
            if (ext.ok && typeof ext.value === "boolean") {
              continueDecision = ext.value;
              events.transact(() => {
                events.append(spec.id, [
                  event("code.policy_invoked", {
                    summary: { slot: "loop_continue", decision: ext.value, completedTurns },
                    conceptIds: ["loop-termination", "learner-code"],
                  }),
                ]);
              });
            } else if (ext.error != null && ext.error.startsWith("EXTENSION_SLOT_NOT_BOUND")) {
              // 本课程未开放该扩展槽：回退课程默认策略（仍受宿主硬预算约束）
              continueDecision = DEFAULT_LOOP_CONTINUE(observation);
              decisionSource = "default_policy";
            } else {
              // 策略错误：记录并终止（不得把非法返回当作"继续"或"停止"）
              events.transact(() => {
                events.append(spec.id, [
                  event("code.execution_failed", {
                    summary: { slot: "loop_continue", error: ext.error ?? `返回类型不合法: ${typeof ext.value}`, guestDiagnostic: ext.guestDiagnostic },
                    dataClass: "public",
                  }),
                ]);
              });
              stopReason = "policy_error";
              break;
            }
            if (continueDecision === false) {
              events.transact(() => {
                events.append(spec.id, [
                  event("policy.stop_decision", {
                    summary: { decision: "stop", source: decisionSource, completedTurns },
                    conceptIds: ["loop-termination"],
                  }),
                ]);
              });
              stopReason = "policy_stop";
              break;
            }
            events.transact(() => {
              events.append(spec.id, [
                event("policy.stop_decision", {
                  summary: { decision: "continue", source: decisionSource, completedTurns },
                  conceptIds: ["loop-termination"],
                }),
              ]);
            });
          }

          // 2) 硬预算：轮数
          const turnRes = budget.reserve(budgetId, "turn", "loop");
          if (!turnRes.granted) {
            stopReason = "budget_turns_exhausted";
            break;
          }
          budget.settleUse(budgetId, "turn", 1);

          // 3) before_model 边界
          await gate.reach("before_model");

          // 4) 上下文编译
          const compiledResult = this.compileForCall(spec.id, lessonInput, messages);
          events.transact(() => {
            const included = compiledResult.compiled.items.filter((i) => i.selected).length;
            const excluded = compiledResult.compiled.items.length - included;
            events.append(spec.id, [
              event("context.compiled", {
                summary: {
                  compiledContextId: compiledResult.compiled.callId,
                  included,
                  excluded,
                  estimatedInputTokens: compiledResult.compiled.estimatedInputTokens,
                  itemDecisionsRef: compiledResult.itemDecisionsRef,
                },
                payloadRef: compiledResult.compiled.messageBodyRef,
                conceptIds: ["context-compilation"],
                source: {
                  manifestId: spec.sourceManifestId,
                  fileId: "context/compiler.ts",
                  symbol: "compileContext",
                  regionId: "context-compile",
                  startLine: 1,
                  endLine: 1,
                },
              }),
            ]);
          });

          // 5) 预算预留：模型调用
          const modelRes = budget.reserve(budgetId, "model_call", "loop");
          if (!modelRes.granted) {
            stopReason = "budget_model_calls_exhausted";
            break;
          }

          // 6) 模型调用（含流式与事件）
          const bodyValue = this.deps.blobs.getJson<unknown>(compiledResult.compiled.messageBodyRef.id);
          const callResult = await this.invokeModel(spec, budgetId, bodyValue, lessonInput, messages, signal);

          budget.settleUse(budgetId, "model_call", 1, {
            inputTokens: callResult.response.usage.inputTokens,
            outputTokens: callResult.response.usage.outputTokens,
          });

          // 7) 工具请求
          lastCallHadToolRequests = callResult.response.toolRequests.length > 0;
          if (lastCallHadToolRequests) {
            messages.push({
              id: `m${messages.length + 1}`,
              role: "assistant",
              content: callResult.response.messageText || null,
              toolCalls: callResult.response.toolRequests.map((tr) => ({
                id: tr.id,
                name: tr.name,
                argsText: tr.argumentsText,
              })),
            });
            const toolOk = await this.executeTools(
              spec,
              ctx,
              gate,
              lessonInput,
              callResult.response.toolRequests.map((tr) => ({
                id: tr.id,
                name: tr.name,
                argsText: tr.argumentsText,
                arguments: tr.arguments,
                parseError: tr.parseError,
              })),
              messages,
            );
            if (!toolOk) {
              stopReason = "tool_denied_unrecoverable";
              break;
            }
          } else {
            messages.push({
              id: `m${messages.length + 1}`,
              role: "assistant",
              content: callResult.response.messageText,
            });
          }

          completedTurns += 1;

          // 8) 单轮结束：检查点
          await gate.reach("turn_end");
          const stateRef = blobs.putJson({
            schemaVersion: STATE_SCHEMA_VERSION,
            completedTurns,
            messagesCount: messages.length,
          });
          events.transact(() => {
            events.append(spec.id, [
              event("checkpoint.committed", {
                summary: {
                  checkpointKind: "turn_end",
                  completedTurns,
                  stateSchemaVersion: STATE_SCHEMA_VERSION,
                },
                payloadRef: stateRef,
                conceptIds: ["checkpoint"],
              }),
            ]);
          });

          // 9) 结束条件：无工具请求 = 模型给出最终回答
          if (!lastCallHadToolRequests) {
            stopReason = "final_answer";
            finalText = callResult.response.messageText;
            break;
          }
        }
      }

      if (stopReason == null) stopReason = "policy_stop";
      const finalTextRef = blobs.putText(finalText || "", "text/plain; charset=utf-8");
      outputRefs.unshift(finalTextRef);
      const eventId = events.transact(() =>
        events.append(spec.id, [
          event("run.completed", {
            summary: { stopReason, completedTurns, outputChars: finalText.length },
            payloadRef: finalTextRef,
            conceptIds: ["run-lifecycle"],
          }),
        ]),
      );
      void eventId;
      return { state: "completed", reasonCode: stopReason, outputRefs };
    } catch (err) {
      if (err instanceof CancelledError) {
        return { state: "cancelled", reasonCode: "cancelled", outputRefs };
      }
      const message = String(err).slice(0, 500);
      events.transact(() => {
        events.append(spec.id, [
          event("run.failed", {
            summary: { error: message },
            conceptIds: ["run-lifecycle"],
          }),
        ]);
      });
      return { state: "failed", reasonCode: "model_error", outputRefs };
    } finally {
      void startedAt;
    }
  }

  async resume(): Promise<RuntimeResult> {
    // 参考循环 R0 支持 turn_boundary 恢复的最小语义：不支持任意行继续。
    return { state: "failed", reasonCode: "UNSUPPORTED_CAPABILITY", outputRefs: [] };
  }

  // ---- 固定工作流链（L08）：每步一次模型调用；工具按步骤白名单执行；无自主循环 ----
  private async runChain(
    spec: RunSpec,
    gate: ControlGate,
    lessonInput: LessonRuntimeInput,
    messages: RunMessage[],
    budgetId: string,
    signal: AbortSignal,
  ): Promise<{ finalText: string; stopReason: StopReasonCode; completedTurns: number }> {
    const { events, budget } = this.deps;
    const steps = lessonInput.chainSteps!;
    // T30：跨步骤失败反思（上一步工具失败 → 下一步注入反思与建议）
    let lastFailure: { toolId: string; errorText: string; stage: string } | null = null;
    let reflectionRecords = 0;
    let completedTurns = 0;
    for (const [stepIndex, step] of steps.entries()) {
      await gate.reach("before_model");
      const turnRes = budget.reserve(budgetId, "turn", "chain");
      if (!turnRes.granted) return { finalText: "", stopReason: "budget_turns_exhausted", completedTurns };
      budget.settleUse(budgetId, "turn", 1);
      const modelRes = budget.reserve(budgetId, "model_call", "chain");
      if (!modelRes.granted) return { finalText: "", stopReason: "budget_model_calls_exhausted", completedTurns };

      // 步骤指令作为 host 侧 system 追加（控制流由程序拥有）
      // T30：上一步工具失败 → 注入失败反思（来源标签 + 建议）
      let reflectionPrefix = "";
      if (lessonInput.reflectionOnFailure && lastFailure && stepIndex > 0 && this.deps.reflection) {
        const record = this.analyzeAndRecord(spec.id, stepIndex - 1, lastFailure);
        reflectionPrefix = `${this.deps.reflection.injectReflection(record)}\n`;
        lastFailure = null;
      }
      const stepInput: LessonRuntimeInput = {
        ...lessonInput,
        systemPrompt: `${lessonInput.systemPrompt}

【固定工作流 · 步骤 ${stepIndex + 1}/${steps.length}】${step.instruction}`,
        tools: step.allowTools ? lessonInput.tools : [],
        allowedToolIds: step.allowTools ? lessonInput.allowedToolIds : [],
      };
      const compiledResult = this.compileForCall(spec.id, stepInput, messages);
      events.transact(() => {
        events.append(spec.id, [
          event("context.compiled", {
            summary: {
              compiledContextId: compiledResult.compiled.callId,
              included: compiledResult.compiled.items.filter((i) => i.selected).length,
              excluded: compiledResult.compiled.items.length - compiledResult.compiled.items.filter((i) => i.selected).length,
              estimatedInputTokens: compiledResult.compiled.estimatedInputTokens,
              itemDecisionsRef: compiledResult.itemDecisionsRef,
              workflow: "chain",
              step: stepIndex + 1,
            },
            payloadRef: compiledResult.compiled.messageBodyRef,
            conceptIds: ["workflow", "context-compilation"],
          }),
        ]);
      });
      const bodyValue = this.deps.blobs.getJson<unknown>(compiledResult.compiled.messageBodyRef.id);
      const callResult = await this.invokeModel(spec, budgetId, bodyValue, stepInput, messages, signal);
      budget.settleUse(budgetId, "model_call", 1, {
        inputTokens: callResult.response.usage.inputTokens,
        outputTokens: callResult.response.usage.outputTokens,
      });
      completedTurns += 1;
      const isLast = stepIndex === steps.length - 1;
      if (callResult.response.toolRequests.length > 0 && step.allowTools) {
        messages.push({
          id: `m${messages.length + 1}`,
          role: "assistant",
          content: callResult.response.messageText || null,
          toolCalls: callResult.response.toolRequests.map((tr) => ({
            id: tr.id,
            name: tr.name,
            argsText: tr.argumentsText,
          })),
        });
        await this.executeTools(
          spec,
          { runId: spec.id } as RuntimeContext,
          gate,
          stepInput,
          callResult.response.toolRequests.map((tr) => ({
            id: tr.id,
            name: tr.name,
            argsText: tr.argumentsText,
            arguments: tr.arguments,
            parseError: tr.parseError,
          })),
          messages,
        );
        // T30：检测本步工具失败（结果消息含 error 字段）→ 待下一步注入反思
        const lastTool = [...messages].reverse().find((m) => m.role === "tool");
        if (lastTool?.content != null && /"error"/.test(lastTool.content)) {
          lastFailure = {
            toolId: "unknown",
            errorText: lastTool.content.slice(0, 300),
            stage: `chain 步骤 ${completedTurns + 1}`,
          };
        }
      } else {
        messages.push({
          id: `m${messages.length + 1}`,
          role: "assistant",
          content: callResult.response.messageText,
        });
        if (isLast) {
          return { finalText: callResult.response.messageText, stopReason: "final_answer", completedTurns };
        }
      }
    }
    return { finalText: "", stopReason: "policy_stop", completedTurns };
  }

  /** T30：分析失败并记录反思事件 */
  private analyzeAndRecord(
    runId: string,
    stepIndex: number,
    failure: { toolId: string; errorText: string; stage: string },
  ): import("@agentglass/evolution").ReflectionRecord {
    const svc = this.deps.reflection;
    if (!svc) throw new Error("REFLECTION_SERVICE_MISSING");
    const record = svc.analyzeFailure(runId, {
      stage: failure.stage,
      toolId: failure.toolId,
      errorText: failure.errorText,
    });
    svc.record(runId, record);
    return record;
  }

  // ---- 单次调用（L00—L03） ----
  private async runSingleCall(
    spec: RunSpec,
    gate: ControlGate,
    lessonInput: LessonRuntimeInput,
    messages: RunMessage[],
    budgetId: string,
    signal: AbortSignal,
  ): Promise<{ finalText: string; outputRefs: BlobRef[]; stopReason: StopReasonCode }> {
    await gate.reach("before_model");
    const { events, budget } = this.deps;
    const compiledResult = this.compileForCall(spec.id, lessonInput, messages);
    events.transact(() => {
      const included = compiledResult.compiled.items.filter((i) => i.selected).length;
      events.append(spec.id, [
        event("context.compiled", {
          summary: {
            compiledContextId: compiledResult.compiled.callId,
            included,
            excluded: compiledResult.compiled.items.length - included,
            estimatedInputTokens: compiledResult.compiled.estimatedInputTokens,
            itemDecisionsRef: compiledResult.itemDecisionsRef,
          },
          payloadRef: compiledResult.compiled.messageBodyRef,
          conceptIds: ["context-compilation"],
        }),
      ]);
    });
    const res = budget.reserve(budgetId, "model_call", "single");
    if (!res.granted) {
      return { finalText: "", outputRefs: [], stopReason: "budget_model_calls_exhausted" };
    }
    const bodyValue = this.deps.blobs.getJson<unknown>(compiledResult.compiled.messageBodyRef.id);
    const callResult = await this.invokeModel(spec, budgetId, bodyValue, lessonInput, messages, signal);
    budget.settleUse(budgetId, "model_call", 1, {
      inputTokens: callResult.response.usage.inputTokens,
      outputTokens: callResult.response.usage.outputTokens,
    });
    const finalText = callResult.response.messageText;
    return { finalText, outputRefs: [], stopReason: "final_answer" };
  }

  // ---- 模型调用（准备→派发→流式→完成/失败；有限重试） ----
  private async invokeModel(
    spec: RunSpec,
    budgetId: string,
    bodyValue: unknown,
    lessonInput: LessonRuntimeInput,
    _messages: RunMessage[],
    signal: AbortSignal,
  ): Promise<{ response: import("@agentglass/contracts").ModelResponse }> {
    const { events, gateway, modelSnapshot, blobs } = this.deps;
    const bodyJson = bodyValue as { messages?: unknown[]; tools?: unknown };
    const wireBody = {
      ...bodyJson,
      model: modelSnapshot.modelId,
      stream: lessonInput.stream,
      max_tokens: lessonInput.budget.maxOutputTokens,
    };
    const wireRef = blobs.putJson(wireBody);
    events.transact(() => {
      events.append(spec.id, [
        event("model.request_prepared", {
          summary: {
            modelId: modelSnapshot.modelId,
            provider: modelSnapshot.provider,
            stream: lessonInput.stream,
            wireCapture: true,
          },
          payloadRef: wireRef,
          conceptIds: ["model-request"],
        }),
      ]);
    });

    let attempt = 0;
    let lastError: unknown = undefined;
    const maxAttempts = 2; // 冻结重试策略：限流/网络瞬断一次重试
    while (attempt < maxAttempts) {
      attempt += 1;
      events.transact(() => {
        events.append(spec.id, [
          event("model.request_dispatched", { summary: { attempt } , conceptIds: ["model-request"] }),
        ]);
      });
      try {
        const result = await gateway.invoke(modelSnapshot, bodyJson.messages ?? [], {
          stream: lessonInput.stream,
          tools: lessonInput.tools.length > 0 ? lessonInput.tools : undefined,
          maxOutputTokens: lessonInput.budget.maxOutputTokens,
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
                  event("model.delta_batch", { summary: { chars: batchChars }, payloadRef, conceptIds: ["streaming"] }),
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
              event("model.response_truncated", { summary: { finishReason: "length" }, conceptIds: ["model-response"] }),
            ]);
          });
        }
        events.transact(() => {
          events.append(spec.id, [
            event("model.response_completed", {
              summary: {
                finishReason: response.finishReason,
                toolRequestCount: response.toolRequests.length,
                usage: {
                  inputTokens: response.usage.inputTokens ?? null,
                  outputTokens: response.usage.outputTokens ?? null,
                },
                messageChars: response.messageText.length,
              },
              payloadRef: blobs.putText(response.messageText || response.rawText),
              conceptIds: ["model-response"],
            }),
          ]);
        });
        // T23 after_model hooks：mutating hook 修改输出文本 → hook.diff 事件（可观察）
        if (this.deps.hooks) {
          const stage = await this.deps.hooks.runStage("after_model", {
            runId: spec.id,
            stage: "after_model",
            data: { messageText: response.messageText },
          });
          for (const d of stage.diffs) {
            events.transact(() => {
              events.append(spec.id, [
                event("hook.diff", {
                  summary: { hookId: d.hookId, diff: d.diff.slice(0, 200) },
                  conceptIds: ["harness"],
                }),
              ]);
            });
          }
          if (stage.data.messageText !== response.messageText) {
            response = { ...response, messageText: String(stage.data.messageText) };
          }
        }
        return { response };
      } catch (err) {
        lastError = err;
        const retryable =
          err instanceof FakeProviderError
            ? false
            : /HTTP_429|HTTP_5\d\d|fetch failed|ECONNRESET|ETIMEDOUT/i.test(String(err));
        events.transact(() => {
          events.append(spec.id, [
            event("model.request_failed", {
              summary: { attempt, retryable, error: String(err).slice(0, 300) },
              conceptIds: ["model-request"],
            }),
          ]);
        });
        if (!retryable || attempt >= maxAttempts || signal.aborted) break;
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
    const { budget } = this.deps;
    budget.settleUse(budgetId, "model_call", 1);
    throw lastError ?? new Error("MODEL_CALL_FAILED");
  }

  // ---- 工具请求 → 校验 → 执行（T05 代理） ----
  private async executeTools(
    spec: RunSpec,
    ctx: RuntimeContext,
    gate: ControlGate,
    lessonInput: LessonRuntimeInput,
    toolRequests: Array<{
      id: string;
      name: string;
      argsText: string;
      arguments?: JsonValue;
      parseError?: string;
    }>,
    messages: RunMessage[],
  ): Promise<boolean> {
    const { events, blobs, broker } = this.deps;
    const deadline = new Date(Date.now() + lessonInput.budget.maxWallTimeMs);
    // 工具请求事件（模型提出 ≠ 已执行）
    for (const tr of toolRequests) {
      events.transact(() => {
        events.append(spec.id, [
          event("tool.proposed", {
            summary: {
              callId: tr.id,
              toolId: tr.name,
              argumentsText: tr.argsText.slice(0, 500),
              parseError: tr.parseError ?? null,
              executed: false,
            },
            conceptIds: ["tool-use"],
          }),
        ]);
      });
    }
    let deniedAll = true;
    let anyExecuted = false;
    // 并发派发（调度属性）：每个请求独立事件与工件；结果按请求顺序入上下文
    const settled = await Promise.all(
      toolRequests.map(async (tr) => {
        await gate.reach("before_tool");
        if (tr.parseError) {
          events.transact(() => {
            events.append(spec.id, [
              event("tool.denied", {
                summary: { callId: tr.id, toolId: tr.name, reason: "INVALID_TOOL_ARGUMENTS" },
                conceptIds: ["tool-use"],
              }),
            ]);
          });
          return {
            tr,
            message: {
              id: `mtl_${tr.id}`,
              role: "tool" as const,
              toolCallId: tr.id,
              content: JSON.stringify({ error: "参数不是合法 JSON，工具未执行" }),
            },
            status: "denied" as const,
          };
        }
        events.transact(() => {
          events.append(spec.id, [
            event("tool.validated", { summary: { callId: tr.id, toolId: tr.name }, conceptIds: ["tool-use"] }),
          ]);
        });
        // T20 审批门：workspace_write 类工具派发前必须持有有效审批
        if (this.deps.approval?.gatedToolIds.includes(tr.name)) {
          const args = (tr.arguments ?? {}) as Record<string, unknown>;
          const approvalId = this.deps.approval.request(spec.id, tr.name, "1.0.0", args);
          this.deps.approval.onStateChange("awaiting_approval");
          const decision = await this.deps.approval.waitDecision(approvalId, signalOfNone());
          this.deps.approval.onStateChange("running");
          const check = this.deps.approval.verify(approvalId, args);
          if (decision !== "granted" || !check.valid) {
            events.transact(() => {
              events.append(spec.id, [
                event("approval.rejected", {
                  summary: { approvalId, toolId: tr.name, reason: check.reason ?? decision },
                  conceptIds: ["approval"],
                }),
              ]);
            });
            return {
              tr,
              status: "denied",
              message: {
                id: `mtl_${tr.id}`,
                role: "tool" as const,
                toolCallId: tr.id,
                content: JSON.stringify({ error: "写入被拒绝：缺少有效审批", reason: check.reason ?? decision }),
              },
            };
          }
          events.transact(() => {
            events.append(spec.id, [
              event("approval.granted", {
                summary: { approvalId, toolId: tr.name },
                conceptIds: ["approval"],
              }),
            ]);
          });
        }
        const result = await broker.execute({
          toolId: tr.name,
          revision: "1.0.0",
          args: tr.arguments ?? {},
          ctx: {
            runId: spec.id,
            workspaceRoot: lessonInput.workspaceRoot,
            allowedToolIds: lessonInput.allowedToolIds,
            deadlineAt: deadline.toISOString(),
            maxOutputBytes: 512 * 1024,
          },
          idempotencyKey: `${spec.id}:${tr.id}`,
        });
        const content =
          result.status === "succeeded"
            ? JSON.stringify(result.outputSummary ?? {})
            : JSON.stringify({ error: result.errorMessage ?? result.reasonCode });
        const truncated =
          content.length > lessonInput.maxToolResultChars
            ? content.slice(0, lessonInput.maxToolResultChars) + "…[TRUNCATED]"
            : content;
        const resultRef = blobs.putText(content);
        events.transact(() => {
          events.append(spec.id, [
            event("tool.call_completed", {
              summary: {
                callId: tr.id,
                toolId: tr.name,
                status: result.status,
                reasonCode: result.reasonCode ?? null,
                resultChars: content.length,
                truncatedIntoContext: content.length !== truncated.length,
              },
              payloadRef: resultRef,
              conceptIds: ["tool-use"],
            }),
          ]);
        });
        return {
          tr,
          status: result.status,
          message: {
            id: `mtl_${tr.id}`,
            role: "tool" as const,
            toolCallId: tr.id,
            content: truncated,
          },
        };
      }),
    );
    for (const s of settled) {
      messages.push(s.message);
      if (s.status === "succeeded" || s.status === "failed") {
        deniedAll = false;
        anyExecuted = true;
      }
    }
    void deniedAll;
    void anyExecuted;
    return true;
  }

  private compileForCall(
    runId: string,
    lessonInput: LessonRuntimeInput,
    messages: RunMessage[],
  ) {
    // 预算取两者较小值：模型上下文窗口与课程预算（课程预算收紧时教学可见排除原因）
    const modelWindow = this.deps.modelSnapshot.capabilities.contextWindow ?? Number.MAX_SAFE_INTEGER;
    const lessonCap = lessonInput.budget.maxInputTokens > 0 ? lessonInput.budget.maxInputTokens : Number.MAX_SAFE_INTEGER;
    const contextLimit = Math.min(modelWindow, lessonCap);
    // 输出/安全预留只在「与输出共享空间」的模型窗口上扣除；课程输入预算本身已是
    // 输入侧上限，再扣预留会把余量算成负数（L14 这类收紧课会退化为只剩系统提示）
    const sharedWindow = contextLimit === modelWindow;
    const candidates =
      lessonInput.compaction === "tool_result_head"
        ? compactToolResults(messages)
        : messages;
    const result = compileContext(
      {
        runId,
        systemPrompt: lessonInput.systemPrompt,
        toolSchemas: lessonInput.tools,
        candidates,
        budget: {
          contextLimit,
          outputReserveTokens: sharedWindow ? Math.min(4096, lessonInput.budget.maxOutputTokens) : 0,
          safetyReserveTokens: sharedWindow ? 512 : 0,
        },
      },
      (v) => this.deps.blobs.putJson(v),
    );
    // 逐项选入/排除决策单独成 blob（不混入 messageBodyRef：该体会原样拼进出站载荷）
    const itemDecisionsRef = this.deps.blobs.putJson(
      result.compiled.items.map((i) => ({
        id: i.id,
        kind: i.kind,
        trust: i.trust,
        priority: i.priority,
        atomicGroupId: i.atomicGroupId ?? null,
        estimatedTokens: i.estimatedTokens,
        selected: i.selected,
        decision: i.decision,
        decisionReason: i.decisionReason ?? null,
      })),
    ).id;
    return { ...result, itemDecisionsRef };
  }
}

function signalOfNone(): AbortSignal {
  return new AbortController().signal;
}

export function event(type: string, e: Omit<NewTraceEvent, "type">): NewTraceEvent {
  return { type, ...e };
}

export type { ModelResponse };

/** L15 压缩策略：把候选中的工具结果压缩为首段+指针（decision 保留为 compressed 语义说明）。 */
function compactToolResults(messages: RunMessage[]): RunMessage[] {
  return messages.map((m) => {
    if (m.role !== "tool" || m.content == null) return m;
    if (m.content.length <= 400) return m;
    return {
      ...m,
      content: m.content.slice(0, 400) + "…[已压缩：完整工具结果见工件；模型此轮只见首段]",
    };
  });
}
