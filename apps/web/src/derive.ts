/**
 * 事件账本 → 对话/回合视图模型（纯函数，UI 无关）。
 * 一个「回合」= 一次模型调用：context.compiled（组装）→ 流式 delta → response_completed
 * → 若干工具调用。多轮 agent 循环即回合序列。工具结果/流式片段的全文经 payloadRef
 * 指向 blob，由调用方异步取回后放入 blobCache 再渲染。
 */
import type { TraceEvent } from "./api";

export interface ToolCallView {
  callId: string;
  toolId: string;
  argsText: string;
  status: "pending" | "succeeded" | "failed" | "denied";
  resultRef?: string;
  startedAt?: string;
  durationMs?: number;
}

export interface TurnView {
  index: number;
  contextCallId?: string;
  compiledSeq?: number;
  estimatedInputTokens?: number;
  included?: number;
  excluded?: number;
  /** 流式片段 blob（按序拼接即增量文本） */
  deltaBlobIds: string[];
  /** response_completed 的全文 blob；取回后替代增量拼接 */
  fullTextRef?: string;
  streaming: boolean;
  requestedAt?: string;
  usage?: { inputTokens: number | null; outputTokens: number | null };
  finishReason?: string;
  truncated: boolean;
  failed: boolean;
  tools: ToolCallView[];
}

export interface RunDerived {
  turns: TurnView[];
  /** 当前正在生成（或等待工具）的回合索引（1-based）；无则为 null */
  activeTurnIndex: number | null;
  /** 累计用量（各回合 response_completed 求和） */
  usage: { input: number; output: number };
}

export function deriveRun(events: TraceEvent[]): RunDerived {
  const turns: TurnView[] = [];
  const usage = { input: 0, output: 0 };
  /** 最近一次模型调用所在回合（工具调用归属它） */
  let lastModelTurn: TurnView | null = null;
  /** 尚未完成模型响应的回合 */
  let openTurn: TurnView | null = null;

  const ensureTurn = (): TurnView => {
    const t: TurnView = {
      index: turns.length + 1,
      deltaBlobIds: [],
      streaming: false,
      truncated: false,
      failed: false,
      tools: [],
    };
    turns.push(t);
    return t;
  };

  const findTool = (callId: string): ToolCallView | undefined => {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const hit = turns[i]!.tools.find((t) => t.callId === callId);
      if (hit) return hit;
    }
    return undefined;
  };

  for (const e of events) {
    const s = e.summary as Record<string, unknown>;
    switch (e.type) {
      case "context.compiled": {
        const t = ensureTurn();
        t.contextCallId = String(s.compiledContextId ?? "");
        t.compiledSeq = e.seq;
        t.estimatedInputTokens = Number(s.estimatedInputTokens ?? 0) || undefined;
        t.included = Number(s.included ?? 0);
        t.excluded = Number(s.excluded ?? 0);
        openTurn = t;
        break;
      }
      case "model.request_dispatched": {
        const t: TurnView = openTurn ?? ensureTurn();
        t.streaming = true;
        t.requestedAt = e.emittedAt;
        openTurn = t;
        lastModelTurn = t;
        break;
      }
      case "model.delta_batch": {
        const t: TurnView = openTurn ?? lastModelTurn ?? ensureTurn();
        if (e.payloadRef) t.deltaBlobIds.push(e.payloadRef.id);
        t.streaming = true;
        openTurn = t;
        lastModelTurn = t;
        break;
      }
      case "model.response_truncated": {
        const t = openTurn ?? lastModelTurn;
        if (t) t.truncated = true;
        break;
      }
      case "model.response_completed": {
        const t: TurnView = openTurn ?? lastModelTurn ?? ensureTurn();
        t.streaming = false;
        if (e.payloadRef) t.fullTextRef = e.payloadRef.id;
        const u = (s.usage ?? {}) as { inputTokens?: number | null; outputTokens?: number | null };
        t.usage = {
          inputTokens: typeof u.inputTokens === "number" ? u.inputTokens : null,
          outputTokens: typeof u.outputTokens === "number" ? u.outputTokens : null,
        };
        usage.input += t.usage.inputTokens ?? 0;
        usage.output += t.usage.outputTokens ?? 0;
        t.finishReason = String(s.finishReason ?? "");
        lastModelTurn = t;
        openTurn = null;
        break;
      }
      case "model.request_failed":
      case "model.request_cancelled": {
        const t = openTurn ?? lastModelTurn;
        if (t) {
          t.streaming = false;
          t.failed = true;
        }
        openTurn = null;
        break;
      }
      case "tool.proposed": {
        const host = lastModelTurn ?? ensureTurn();
        if (!host.tools.some((t) => t.callId === String(s.callId))) {
          host.tools.push({
            callId: String(s.callId),
            toolId: String(s.toolId ?? ""),
            argsText: String(s.argumentsText ?? "").slice(0, 2000),
            status: "pending",
            startedAt: e.emittedAt,
          });
        }
        break;
      }
      case "tool.denied": {
        const row = findTool(String(s.callId));
        if (row) {
          row.status = "denied";
          row.durationMs = durationMs(row.startedAt, e.emittedAt);
        }
        break;
      }
      case "tool.call_completed": {
        const row = findTool(String(s.callId));
        if (row) {
          row.status = String(s.status) === "succeeded" ? "succeeded" : "failed";
          if (e.payloadRef) row.resultRef = e.payloadRef.id;
          row.durationMs = durationMs(row.startedAt, e.emittedAt);
        }
        break;
      }
      default:
        break;
    }
  }
  const activeTurnIndex =
    openTurn?.index ??
    (lastModelTurn && lastModelTurn.tools.some((t) => t.status === "pending") ? lastModelTurn.index : null);
  return { turns, activeTurnIndex, usage };
}

function durationMs(startIso: string | undefined, endIso: string): number | undefined {
  if (!startIso) return undefined;
  const a = Date.parse(startIso);
  const b = Date.parse(endIso);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return undefined;
  return b - a;
}

/** 回合可见文本：优先全文 blob，否则按序拼接已取回的流式片段。 */
export function resolveTurnText(turn: TurnView, blobCache: ReadonlyMap<string, string>): string {
  if (turn.fullTextRef) {
    const full = blobCache.get(turn.fullTextRef);
    if (full != null) return full;
  }
  let text = "";
  for (const id of turn.deltaBlobIds) {
    const chunk = blobCache.get(id);
    if (chunk == null) break; // 片段按序到达；缺中间片段时停在已连续的前缀
    text += chunk;
  }
  return text;
}

/** 收集本轮运行渲染所需、尚未取回的 blob id（流式片段 + 回合全文）。 */
export function missingBlobs(derived: RunDerived, blobCache: ReadonlyMap<string, string>): string[] {
  const ids: string[] = [];
  for (const t of derived.turns) {
    for (const id of t.deltaBlobIds) if (!blobCache.has(id)) ids.push(id);
    if (t.fullTextRef && !blobCache.has(t.fullTextRef)) ids.push(t.fullTextRef);
  }
  return ids;
}
