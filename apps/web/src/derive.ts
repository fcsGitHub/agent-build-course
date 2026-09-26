/**
 * 事件账本 → 对话/回合视图模型（纯函数，UI 无关）。
 * 一个「回合」= 一次模型调用：context.compiled（组装）→ 流式 delta → response_completed
 * → 若干工具调用。多轮 agent 循环即回合序列。多 agent 运行中，worker 的模型事件
 * summary 携带 workerId，回合据此归属到子 agent（worker 回合）；委派/移交/结果回收、
 * MCP 协议、A2A 连接、技能加载投影为「通信活动」，与回合按事件顺序穿插成 entries。
 * 工具结果/流式片段的全文经 payloadRef 指向 blob，由调用方异步取回后放入 blobCache 再渲染。
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
  /** 多 agent 运行：本回合所属子 agent（事件 summary.workerId）；主循环回合为空 */
  workerId?: string;
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

/** agent 间通信 / 协议 / 能力加载活动（对话流中的窄卡） */
export interface AgentActivity {
  seq: number;
  kind:
    | "delegated"
    | "handed_off"
    | "result"
    | "mcp_connect"
    | "mcp_protocol"
    | "a2a_connect"
    | "skill";
  workerId?: string;
  from?: string;
  to?: string;
  goal?: string;
  taskId?: string;
  status?: string;
  reason?: string;
  outputChars?: number;
  blackboardKey?: string;
  conflict?: boolean;
  versions?: number;
  slug?: string;
  version?: string;
  server?: string;
  method?: string | null;
  dir?: string;
  agentName?: string;
}

export type TranscriptEntry =
  | { kind: "turn"; seq: number; turn: TurnView }
  | { kind: "activity"; activity: AgentActivity };

export interface RunDerived {
  turns: TurnView[];
  /** 回合与通信活动按事件顺序穿插的转写时间线 */
  entries: TranscriptEntry[];
  /** 当前正在生成（或等待工具）的回合索引（1-based）；无则为 null */
  activeTurnIndex: number | null;
  /** 累计用量（各回合 response_completed 求和） */
  usage: { input: number; output: number };
}

export function deriveRun(events: TraceEvent[]): RunDerived {
  const turns: TurnView[] = [];
  const entries: TranscriptEntry[] = [];
  const usage = { input: 0, output: 0 };
  /** 最近一次模型调用所在回合（工具调用归属它） */
  let lastModelTurn: TurnView | null = null;
  /** 尚未完成模型响应的回合——按归属分槽：主循环用 ""，每个 worker 用其 id
   *  （并行 worker 事件交错时，流式片段与完成事件必须落在各自回合上） */
  const openTurns = new Map<string, TurnView>();

  const ensureTurn = (seq: number, workerId?: string): TurnView => {
    const t: TurnView = {
      index: turns.length + 1,
      workerId,
      deltaBlobIds: [],
      streaming: false,
      truncated: false,
      failed: false,
      tools: [],
    };
    turns.push(t);
    entries.push({ kind: "turn", seq, turn: t });
    return t;
  };

  const pushActivity = (a: AgentActivity): void => {
    entries.push({ kind: "activity", activity: a });
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
    const workerId = typeof s.workerId === "string" ? s.workerId : undefined;
    const slot = workerId ?? "";
    switch (e.type) {
      case "context.compiled": {
        const t = ensureTurn(e.seq, workerId);
        t.contextCallId = String(s.compiledContextId ?? "");
        t.compiledSeq = e.seq;
        t.estimatedInputTokens = Number(s.estimatedInputTokens ?? 0) || undefined;
        t.included = Number(s.included ?? 0);
        t.excluded = Number(s.excluded ?? 0);
        openTurns.set(slot, t);
        break;
      }
      case "model.request_dispatched": {
        const t: TurnView = openTurns.get(slot) ?? ensureTurn(e.seq, workerId);
        t.streaming = true;
        t.requestedAt = e.emittedAt;
        openTurns.set(slot, t);
        lastModelTurn = t;
        break;
      }
      case "model.delta_batch": {
        const t: TurnView = openTurns.get(slot) ?? lastModelTurn ?? ensureTurn(e.seq, workerId);
        if (e.payloadRef) t.deltaBlobIds.push(e.payloadRef.id);
        t.streaming = true;
        openTurns.set(slot, t);
        lastModelTurn = t;
        break;
      }
      case "model.response_truncated": {
        const t = openTurns.get(slot) ?? lastModelTurn;
        if (t) t.truncated = true;
        break;
      }
      case "model.response_completed": {
        const t: TurnView = openTurns.get(slot) ?? lastModelTurn ?? ensureTurn(e.seq, workerId);
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
        openTurns.delete(slot);
        break;
      }
      case "model.request_failed":
      case "model.request_cancelled": {
        const t = openTurns.get(slot) ?? lastModelTurn;
        if (t) {
          t.streaming = false;
          t.failed = true;
        }
        openTurns.delete(slot);
        break;
      }
      case "tool.proposed": {
        const host = lastModelTurn ?? ensureTurn(e.seq, workerId);
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
      case "agent.delegated": {
        pushActivity({
          seq: e.seq,
          kind: "delegated",
          workerId: str(s.workerId),
          taskId: str(s.taskId),
          goal: str(s.goal),
        });
        break;
      }
      case "agent.handed_off": {
        pushActivity({
          seq: e.seq,
          kind: "handed_off",
          from: str(s.from),
          to: str(s.to),
        });
        break;
      }
      case "agent.result_received": {
        pushActivity({
          seq: e.seq,
          kind: "result",
          workerId: str(s.workerId),
          taskId: str(s.taskId),
          status: str(s.status),
          reason: str(s.reason),
          outputChars: num(s.outputChars),
          blackboardKey: str(s.blackboardKey),
          conflict: typeof s.conflict === "boolean" ? s.conflict : undefined,
          versions: num(s.versions) ?? undefined,
        });
        break;
      }
      case "mcp.server_connected": {
        pushActivity({
          seq: e.seq,
          kind: "mcp_connect",
          server: str(s.serverId),
          method: null,
        });
        break;
      }
      case "mcp.protocol_event": {
        pushActivity({
          seq: e.seq,
          kind: "mcp_protocol",
          server: str(s.server),
          method: typeof s.method === "string" ? s.method : null,
          dir: str(s.dir),
        });
        break;
      }
      case "a2a.agent_connected": {
        pushActivity({
          seq: e.seq,
          kind: "a2a_connect",
          agentName: str(s.agentName) || str(s.agentId),
        });
        break;
      }
      case "skill.loaded": {
        pushActivity({
          seq: e.seq,
          kind: "skill",
          slug: str(s.slug),
          version: str(s.version),
        });
        break;
      }
      default:
        break;
    }
  }
  const openList = [...openTurns.values()];
  const activeTurnIndex =
    (openList.length > 0 ? openList[openList.length - 1]!.index : null) ??
    (lastModelTurn && lastModelTurn.tools.some((t) => t.status === "pending") ? lastModelTurn.index : null);
  return { turns, entries, activeTurnIndex, usage };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
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
