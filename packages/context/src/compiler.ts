/**
 * 上下文编译器（T13）。
 * 四层证据中的第二层：候选信息池 → 编译后的标准上下文（含选入/排除原因）。
 * 每个候选有确定性 id、priority、信任级别、原子组；预算不足按优先级排除。
 * 依据设计文档 v1.1 第 10.1/10.2/10.4 节。
 */
import { randomUUID } from "node:crypto";
import type {
  BlobRef,
  CompiledContext,
  ContextItem,
  TokenBudget,
  ToolSpecForModel,
} from "@agentglass/contracts";
import { estimateTokens, selectWithinBudget } from "./token-budget";

/** OpenAI 兼容消息（编译后的标准格式；出站载荷即此格式的序列化） */
export interface CompiledMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** 候选消息（会话前缀 + 本次运行已发生消息） */
export interface ContextCandidate {
  /** 稳定 id；同一次运行内不变 */
  id: string;
  role: "user" | "assistant" | "tool";
  content: string | null;
  toolCalls?: Array<{ id: string; name: string; argsText: string }>;
  toolCallId?: string;
  trust?: "host" | "user" | "external";
}

export interface CompileInput {
  runId: string;
  /** 宿主安全规则（不可被低信任内容覆盖） */
  systemPrompt: string;
  toolSchemas: ToolSpecForModel[];
  candidates: ContextCandidate[];
  budget: TokenBudget;
}

export interface CompileOutput {
  compiled: CompiledContext;
  messages: CompiledMessage[];
}

export const COMPILER_VERSION = "context-compiler-2";

function stableHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function compileContext(
  input: CompileInput,
  putBlob: (value: unknown) => BlobRef,
): CompileOutput {
  const items: ContextItem[] = [];
  const renderers = new Map<string, () => CompiledMessage | null>();
  const callId = `cc_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

  // 1) 宿主规则：priority 最高，始终保留
  pushItem(items, renderers, {
    id: "policy:system",
    kind: "policy",
    text: input.systemPrompt,
    trust: "host",
    priority: 1000,
    alwaysSelected: true,
    reason: "宿主安全规则，始终保留",
    render: () => ({ role: "system", content: input.systemPrompt }),
  });

  // 2) 工具 schema：host，始终保留
  for (const tool of input.toolSchemas) {
    const text = JSON.stringify(tool);
    pushItem(items, renderers, {
      id: `tool_schema:${tool.name}`,
      kind: "tool_schema",
      text,
      trust: "host",
      priority: 900,
      alwaysSelected: true,
      reason: "工具定义，本运行可用",
      render: null,
    });
  }

  // 3) 会话候选：越新优先级越高；tool_calls 与其 result 为原子组
  const n = input.candidates.length;
  input.candidates.forEach((cand, index) => {
    const recency = n - index; // 越新越大
    const priority = Math.min(799, 200 + recency * 5);
    if (cand.role === "user") {
      const text = cand.content ?? "";
      pushItem(items, renderers, {
        id: cand.id,
        kind: "message",
        text,
        trust: cand.trust ?? "user",
        priority,
        alwaysSelected: false,
        render: () => ({ role: "user", content: text }),
      });
    } else if (cand.role === "assistant") {
      if (cand.toolCalls && cand.toolCalls.length > 0) {
        const id = cand.id;
        const groupId = `atomic:${cand.toolCalls[0]!.id}`;
        pushItem(items, renderers, {
          id,
          kind: "message",
          text: JSON.stringify({ tool_calls: cand.toolCalls }),
          trust: cand.trust ?? "user",
          priority,
          alwaysSelected: false,
          atomicGroupId: groupId,
          render: () => ({
            role: "assistant",
            content: cand.content ?? null,
            tool_calls: cand.toolCalls!.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.argsText },
            })),
          }),
        });
      } else {
        const text = cand.content ?? "";
        pushItem(items, renderers, {
          id: cand.id,
          kind: "message",
          text,
          trust: cand.trust ?? "user",
          priority,
          alwaysSelected: false,
          render: () => ({ role: "assistant", content: text }),
        });
      }
    } else {
      const text = cand.content ?? "";
      pushItem(items, renderers, {
        id: cand.id,
        kind: "tool_result",
        text,
        trust: cand.trust ?? "user",
        priority,
        alwaysSelected: false,
        atomicGroupId: `atomic:${cand.toolCallId ?? cand.id}`,
        render: () => ({ role: "tool", content: text, tool_call_id: cand.toolCallId }),
      });
    }
  });

  // 4) 预算内选择（原子组保护；未闭合工具事务不可拆开）
  const selection = selectWithinBudget(items, input.budget);
  if (!selection.constructible) {
    throw new Error(`CONTEXT_NOT_CONSTRUCTIBLE: ${selection.failureReason}`);
  }
  const selectedIds = new Set(selection.selected.map((i) => i.id));

  // 5) 按候选顺序重建消息
  const messages: CompiledMessage[] = [];
  for (const [id, render] of renderers) {
    if (id === "policy:system" && selectedIds.has(id)) {
      const m = render();
      if (m) messages.push(m);
    }
  }
  for (const cand of input.candidates) {
    if (!selectedIds.has(cand.id)) continue;
    const render = renderers.get(cand.id);
    if (!render) continue;
    const m = render();
    if (m) messages.push(m);
  }

  const body = {
    messages,
    ...(input.toolSchemas.length > 0 ? { tools: input.toolSchemas } : {}),
  };
  const messageBodyRef = putBlob(body);
  const compiled: CompiledContext = {
    id: callId,
    runId: input.runId,
    callId,
    items: selection.all,
    messageBodyRef,
    estimatedInputTokens: selection.estimatedInputTokens,
    outputReserveTokens: input.budget.outputReserveTokens,
    safetyReserveTokens: input.budget.safetyReserveTokens,
    compilerVersion: COMPILER_VERSION,
  };
  return { compiled, messages };
}

interface PushArgs {
  id: string;
  kind: ContextItem["kind"];
  text: string;
  trust: ContextItem["trust"];
  priority: number;
  alwaysSelected: boolean;
  reason?: string;
  atomicGroupId?: string;
  render: (() => CompiledMessage) | null;
}

function pushItem(
  items: ContextItem[],
  renderers: Map<string, () => CompiledMessage | null>,
  a: PushArgs,
): void {
  if (items.some((i) => i.id === a.id)) return;
  items.push({
    id: a.id,
    kind: a.kind,
    sourceRef: {
      id: `inline:${stableHash(a.text)}`,
      sha256: stableHash(a.text),
      mediaType: "text/plain",
      bytes: a.text.length,
    },
    originId: a.id,
    originVersion: "1",
    trust: a.trust,
    priority: a.priority,
    atomicGroupId: a.atomicGroupId,
    estimatedTokens: estimateTokens(a.text),
    selected: a.alwaysSelected,
    decision: a.alwaysSelected ? "included" : "budget_excluded",
    transformedFromIds: [],
    decisionReason: a.reason ?? (a.alwaysSelected ? "host 规则，默认保留" : undefined),
  });
  if (a.render) renderers.set(a.id, a.render);
}
