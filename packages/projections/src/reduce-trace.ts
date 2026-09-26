/**
 * 纯函数投影（T10；用例 1）。同一份已提交事件 + 相同 reducer 版本 → 相同投影摘要。
 * reducer 不读取当前时间、随机数、网络或数据库动态值。
 * 依据设计文档 v1.1 第 18.2 节。
 */
import { createHash } from "node:crypto";
import type { TraceEvent } from "@agentglass/contracts";

export interface ProjectionMessage {
  seq: number;
  role: "user" | "assistant" | "tool" | "system";
  toolCallId?: string;
  toolName?: string;
  text: string;
  truncated?: boolean;
}

export interface ProjectionToolCall {
  callId: string;
  toolId: string;
  status: "proposed" | "validated" | "denied" | "executed" | "failed" | "unknown";
  argsPreview: string;
  resultPreview?: string;
  proposedSeq: number;
}

export interface ProjectionModelCall {
  callId: string;
  seq: number;
  modelId: string;
  provider: string;
  finishReason?: string;
  usageInputTokens?: number;
  usageOutputTokens?: number;
  truncated?: boolean;
}

export interface ProjectionState {
  reducerVersion: string;
  runId: string;
  lastSeq: number;
  runState: string;
  stopReason?: string;
  messages: ProjectionMessage[];
  toolCalls: ProjectionToolCall[];
  modelCalls: ProjectionModelCall[];
  contextCompilations: Array<{ seq: number; included: number; excluded: number; estimatedTokens: number; compiledContextId: string }>;
  stopDecisions: Array<{ seq: number; decision: string; source: string; completedTurns: number }>;
  checkpoints: Array<{ seq: number; completedTurns: number }>;
  finalAnswer?: string;
  eventCount: number;
}

export const REDUCER_VERSION = "reduce-trace-1";

export function initialProjection(runId = ""): ProjectionState {
  return {
    reducerVersion: REDUCER_VERSION,
    runId,
    lastSeq: 0,
    runState: "unknown",
    messages: [],
    toolCalls: [],
    modelCalls: [],
    contextCompilations: [],
    stopDecisions: [],
    checkpoints: [],
    eventCount: 0,
  };
}

/** 同 seq 重复幂等；同 seq 不同内容抛错（账本冲突）。乱序到达时由调用方排序/补拉。 */
export function reduceTrace(state: ProjectionState, event: TraceEvent): ProjectionState {
  if (event.seq <= state.lastSeq) {
    // 已应用（重复投递）：幂等跳过
    return state;
  }
  if (event.seq !== state.lastSeq + 1) {
    throw new Error(`SEQ_GAP: 期望 ${state.lastSeq + 1}，收到 ${event.seq}（需补拉）`);
  }
  const next: ProjectionState = {
    ...state,
    lastSeq: event.seq,
    eventCount: state.eventCount + 1,
    runId: event.runId || state.runId,
  };
  const s = event.summary as Record<string, unknown>;
  switch (event.type) {
    case "run.state_changed":
    case "run.started":
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
    case "run.paused":
      next.runState = event.type === "run.state_changed" ? String(s.state ?? event.type) : event.type.replace("run.", "");
      if (s.stopReason) next.stopReason = String(s.stopReason);
      if (event.type === "run.completed") {
        next.runState = "completed";
        next.stopReason = String(s.stopReason ?? "");
      }
      break;
    case "context.compiled":
      next.contextCompilations = [
        ...state.contextCompilations,
        {
          seq: event.seq,
          included: Number(s.included ?? 0),
          excluded: Number(s.excluded ?? 0),
          estimatedTokens: Number(s.estimatedInputTokens ?? 0),
          compiledContextId: String(s.compiledContextId ?? ""),
        },
      ];
      break;
    case "model.request_prepared":
      next.modelCalls = [
        ...state.modelCalls,
        {
          callId: `mc_${event.seq}`,
          seq: event.seq,
          modelId: String(s.modelId ?? ""),
          provider: String(s.provider ?? ""),
        },
      ];
      break;
    case "model.response_completed": {
      const calls = [...state.modelCalls];
      const last = calls.at(-1);
      if (last) {
        calls[calls.length - 1] = {
          ...last,
          finishReason: String(s.finishReason ?? ""),
          usageInputTokens: toNum(s.usage, "inputTokens"),
          usageOutputTokens: toNum(s.usage, "outputTokens"),
        };
      }
      next.modelCalls = calls;
      if (s.messageChars != null && event.payloadRef) {
        next.messages = [
          ...state.messages,
          { seq: event.seq, role: "assistant", text: `«payload:${event.payloadRef.id}»` },
        ];
      }
      break;
    }
    case "model.response_truncated": {
      const calls = [...state.modelCalls];
      const last = calls.at(-1);
      if (last) calls[calls.length - 1] = { ...last, truncated: true };
      next.modelCalls = calls;
      break;
    }
    case "tool.proposed":
      next.toolCalls = [
        ...state.toolCalls,
        {
          callId: String(s.callId ?? ""),
          toolId: String(s.toolId ?? ""),
          status: "proposed",
          argsPreview: String(s.argumentsText ?? "").slice(0, 200),
          proposedSeq: event.seq,
        },
      ];
      break;
    case "tool.validated":
    case "tool.denied":
      next.toolCalls = state.toolCalls.map((tc) =>
        tc.callId === String(s.callId ?? "")
          ? { ...tc, status: event.type === "tool.validated" ? ("validated" as const) : ("denied" as const) }
          : tc,
      );
      break;
    case "tool.call_completed":
      next.toolCalls = state.toolCalls.map((tc) =>
        tc.callId === String(s.callId ?? "")
          ? {
              ...tc,
              status: String(s.status) === "succeeded" ? ("executed" as const) : ("failed" as const),
              resultPreview: `«payload:${event.payloadRef?.id ?? ""}»`,
            }
          : tc,
      );
      next.messages = [
        ...state.messages,
        {
          seq: event.seq,
          role: "tool",
          toolCallId: String(s.callId ?? ""),
          toolName: String(s.toolId ?? ""),
          text: `«payload:${event.payloadRef?.id ?? ""}»`,
          truncated: Boolean(s.truncatedIntoContext),
        },
      ];
      break;
    case "policy.stop_decision":
      next.stopDecisions = [
        ...state.stopDecisions,
        {
          seq: event.seq,
          decision: String(s.decision ?? ""),
          source: String(s.source ?? ""),
          completedTurns: Number(s.completedTurns ?? 0),
        },
      ];
      break;
    case "checkpoint.committed":
      next.checkpoints = [
        ...state.checkpoints,
        { seq: event.seq, completedTurns: Number(s.completedTurns ?? 0) },
      ];
      break;
    default:
      break;
  }
  return next;
}

/** 规范化序列化摘要（排除非确定性 UI 局部状态） */
export function projectionDigest(state: ProjectionState): string {
  const canonical = {
    reducerVersion: state.reducerVersion,
    runId: state.runId,
    lastSeq: state.lastSeq,
    runState: state.runState,
    stopReason: state.stopReason ?? null,
    eventCount: state.eventCount,
    messages: state.messages,
    toolCalls: state.toolCalls,
    modelCalls: state.modelCalls,
    contextCompilations: state.contextCompilations,
    stopDecisions: state.stopDecisions,
    checkpoints: state.checkpoints,
  };
  return createHash("sha256").update(stable(canonical)).digest("hex");
}

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stable(val)}`).join(",")}}`;
}

function toNum(obj: unknown, key: string): number | undefined {
  if (obj && typeof obj === "object" && key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    return typeof v === "number" ? v : undefined;
  }
  return undefined;
}
