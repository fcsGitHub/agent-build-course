/**
 * Anthropic-protocol 适配器（真实提供方）。Messages API（/v1/messages）；
 * 服务端：BigModel Anthropic 兼容路由、Anthropic 官方等。流式 SSE 解析；
 * OpenAI 编译格式（CompiledMessage）→ Anthropic 消息翻译：
 *   system → 顶层 system；assistant.tool_calls → tool_use 块；tool → tool_result（连续合并为一条 user）。
 * 能力诚实声明：无原生 JSON schema 强制（structuredOutput=text_only）；
 * 默认关闭思考（thinking=disabled，可通过 parameters.thinking="enabled" 开启）。
 */
import { randomUUID } from "node:crypto";
import type {
  InvokeOptions,
  ModelCapabilities,
  ModelProfileSnapshot,
  ModelProvider,
  ModelRequestEvidence,
  ModelResponse,
  ModelStreamHandle,
  ModelToolRequest,
  ModelUsage,
  StreamDelta,
  JsonValue,
} from "@agentglass/contracts";
import { captureWireBody } from "./wire-capture";
import { ProviderHttpError, safeParseJson, snapshotSecret, truncate } from "./openai-compat";
import type { BlobStore } from "@agentglass/events";

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

interface WireBody {
  model: string;
  max_tokens: number;
  stream: boolean;
  system?: string;
  messages: AnthropicMessage[];
  tools?: Array<{ name: string; description: string; input_schema: unknown }>;
  tool_choice?: { type: "auto" };
  temperature?: number;
  thinking?: { type: "disabled" | "enabled"; budget_tokens?: number };
}

export class AnthropicCompatProvider implements ModelProvider {
  readonly providerId = "anthropic";
  readonly protocol = "anthropic/v1";

  constructor(private readonly blobs?: BlobStore) {}

  declaredCapabilities(): ModelCapabilities {
    return {
      streaming: true,
      nativeTools: true,
      parallelToolCalls: true,
      structuredOutput: "text_only",
      imageInput: false,
      audioInput: false,
      outputModalities: ["text"],
      usageReporting: "stream_and_final",
      testedAt: "static-declaration",
      probeSuiteVersion: "anthropic-compat-1",
    };
  }

  async invoke(
    snapshot: ModelProfileSnapshot,
    messages: unknown,
    options: InvokeOptions,
  ): Promise<{
    stream?: ModelStreamHandle;
    response?: ModelResponse;
    evidence: ModelRequestEvidence;
  }> {
    const endpoint = snapshotEndpoint(snapshot);
    const secret = snapshotSecret(snapshot);
    const { system, messages: translated } = translateMessages(
      Array.isArray(messages) ? messages : [],
    );
    const params = (snapshot.parameters ?? {}) as Record<string, JsonValue>;
    const body: WireBody = {
      model: snapshot.modelId,
      max_tokens: options.maxOutputTokens ?? 2048,
      stream: options.stream,
      messages: translated,
    };
    if (system) body.system = system;
    if (options.temperature != null) body.temperature = options.temperature;
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
      body.tool_choice = { type: "auto" };
    }
    // 思考默认关闭（教学运行要快速可见的正文；也避免思考块消耗输出预算）
    if (params.thinking === "enabled") {
      body.thinking = { type: "enabled", budget_tokens: Number(params.thinkingBudgetTokens ?? 2048) };
    } else {
      body.thinking = { type: "disabled" };
    }
    const bodyText = JSON.stringify(body);
    const wire = this.blobs ? captureWireBody(this.blobs, body, { capture: true }) : { capture: "partial" as const };
    const evidence: ModelRequestEvidence = {
      wireBodyRef: wire.ref,
      capture: wire.capture,
      endpoint,
      modelId: snapshot.modelId,
    };

    if (!options.stream) {
      const response = await this.postJson(endpoint, secret, bodyText, options.signal);
      return { response, evidence };
    }
    return { stream: this.openStream(endpoint, secret, bodyText, options.signal), evidence };
  }

  private async postJson(
    endpoint: string,
    secret: string | undefined,
    bodyText: string,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: anthropicHeaders(secret),
      body: bodyText,
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderHttpError(res.status, `HTTP_${res.status}`, truncate(text, 500));
    }
    const json = (await res.json()) as {
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
      stop_reason?: string | null;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (json.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    const toolRequests: ModelToolRequest[] = (json.content ?? [])
      .filter((b) => b.type === "tool_use")
      .map((b) => {
        const argsText = JSON.stringify(b.input ?? {});
        const parsed = safeParseJson(argsText);
        return {
          id: b.id ?? `toolu_${randomUUID().slice(0, 8)}`,
          name: b.name ?? "unknown",
          argumentsText: argsText,
          arguments: parsed.value,
          parseError: parsed.error,
        };
      });
    const usage: ModelUsage = {
      inputTokens: json.usage?.input_tokens,
      outputTokens: json.usage?.output_tokens,
    };
    return {
      callId: randomUUID(),
      finishReason: mapFinish(json.stop_reason),
      messageText: text,
      toolRequests,
      usage,
      rawText: text,
    };
  }

  private openStream(
    endpoint: string,
    secret: string | undefined,
    bodyText: string,
    signal?: AbortSignal,
  ): ModelStreamHandle {
    const callId = randomUUID();
    let controller: AbortController | null = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller?.abort(), { once: true });
    }
    const blockTypes = new Map<number, string>();
    const toolAccumulators = new Map<number, { id: string; name: string; argumentsText: string }>();
    let textParts: string[] = [];
    let finishReason: string | undefined;
    let usage: ModelUsage = {};

    async function* generate(): AsyncGenerator<StreamDelta[]> {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: anthropicHeaders(secret),
        body: bodyText,
        signal: controller!.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        throw new ProviderHttpError(res.status, `HTTP_${res.status}`, truncate(text, 500));
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data.length === 0) continue;
          let evt: {
            type?: string;
            message?: { usage?: { input_tokens?: number } };
            index?: number;
            content_block?: { type?: string; id?: string; name?: string };
            delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string | null };
            usage?: { output_tokens?: number };
            error?: { message?: string };
          };
          try {
            evt = JSON.parse(data);
          } catch {
            continue;
          }
          const batch: StreamDelta[] = [];
          if (evt.type === "message_start") {
            usage = { ...usage, inputTokens: evt.message?.usage?.input_tokens ?? usage.inputTokens };
          } else if (evt.type === "content_block_start") {
            const idx = evt.index ?? 0;
            blockTypes.set(idx, evt.content_block?.type ?? "text");
            if (evt.content_block?.type === "tool_use") {
              toolAccumulators.set(idx, {
                id: evt.content_block.id ?? `toolu_${idx}`,
                name: evt.content_block.name ?? "unknown",
                argumentsText: "",
              });
            }
          } else if (evt.type === "content_block_delta") {
            const idx = evt.index ?? 0;
            const kind = blockTypes.get(idx) ?? "text";
            if (evt.delta?.type === "text_delta" && kind === "text" && evt.delta.text) {
              textParts.push(evt.delta.text);
              batch.push({ kind: "text", text: evt.delta.text });
            } else if (evt.delta?.type === "input_json_delta") {
              const acc = toolAccumulators.get(idx);
              if (acc) acc.argumentsText += evt.delta.partial_json ?? "";
              batch.push({
                kind: "tool_call_delta",
                index: idx,
                id: acc?.id,
                name: acc?.name,
                argumentsDelta: evt.delta?.partial_json ?? "",
              });
            }
            // thinking_delta：不进入正文/账本（思考不是回答的证据面）
          } else if (evt.type === "message_delta") {
            if (evt.delta?.stop_reason) finishReason = evt.delta.stop_reason;
            if (evt.usage?.output_tokens != null) {
              usage = { ...usage, outputTokens: evt.usage.output_tokens };
            }
          } else if (evt.type === "message_stop") {
            return;
          } else if (evt.type === "error") {
            throw new ProviderHttpError(502, "PROVIDER_STREAM_ERROR", truncate(evt.error?.message ?? "unknown", 500));
          }
          if (batch.length > 0) yield batch;
        }
      }
    }

    // 单一生成器实例 + 泵：deltas 是唯一消费者；final 从泵的终态组装（绝不二次迭代同一生成器，
    // 否则两个消费者的单槽唤醒互相覆盖会造成挂起）
    const gen = generate();
    const queue: StreamDelta[][] = [];
    let done = false;
    let failure: unknown = undefined;
    let wakeup: null | (() => void) = null;
    const notify = (): void => {
      const w = wakeup;
      wakeup = null;
      w?.();
    };
    const pump = (async () => {
      try {
        for await (const batch of gen) {
          queue.push(batch);
          notify();
        }
      } catch (err) {
        failure = err;
      } finally {
        done = true;
        notify();
      }
    })();

    async function* consume(): AsyncGenerator<StreamDelta[]> {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) {
          if (failure != null) throw failure;
          return;
        }
        await new Promise<void>((r) => {
          wakeup = r;
        });
      }
    }

    const final = pump.then((): ModelResponse => {
      if (failure != null) throw failure;
      const toolRequests: ModelToolRequest[] = [...toolAccumulators.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, acc]) => {
          const argsText = acc.argumentsText || "{}";
          const parsed = safeParseJson(argsText);
          return {
            id: acc.id,
            name: acc.name,
            argumentsText: argsText,
            arguments: parsed.value,
            parseError: parsed.error,
          };
        });
      const text = textParts.join("");
      return {
        callId,
        finishReason: mapFinish(finishReason ?? (toolRequests.length > 0 ? "tool_use" : "end_turn")),
        messageText: text,
        toolRequests,
        usage,
        rawText: text,
      };
    });

    return {
      deltas: consume(),
      final,
      cancel: async () => {
        controller?.abort();
        controller = null;
        await pump.catch(() => undefined);
      },
    };
  }
}

function snapshotEndpoint(snapshot: ModelProfileSnapshot): string {
  const params = (snapshot.parameters ?? {}) as Record<string, JsonValue>;
  const base = String(params.endpoint ?? snapshot.endpointId ?? "");
  if (!base) throw new Error("MODEL_ENDPOINT_MISSING");
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith("/v1/messages") ? trimmed : `${trimmed}/v1/messages`;
}

function anthropicHeaders(secret: string | undefined): Record<string, string> {
  return {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    ...(secret ? { "x-api-key": secret } : {}),
  };
}

/** OpenAI 编译格式 → Anthropic messages（system 提取为顶层；连续 tool_result 合并为一条 user） */
export function translateMessages(messages: readonly unknown[]): {
  system: string | undefined;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  const push = (role: "user" | "assistant", blocks: AnthropicBlock[]): void => {
    const last = out.at(-1);
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    const msg = m as {
      role?: string;
      content?: unknown;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      tool_call_id?: string;
    };
    if (msg.role === "system") {
      if (typeof msg.content === "string" && msg.content.length > 0) systemParts.push(msg.content);
      continue;
    }
    if (msg.role === "assistant") {
      const blocks: AnthropicBlock[] = [];
      if (typeof msg.content === "string" && msg.content.length > 0) {
        blocks.push({ type: "text", text: msg.content });
      }
      for (const tc of msg.tool_calls ?? []) {
        let input: Record<string, unknown>;
        try {
          const v = JSON.parse(tc.function.arguments || "{}") as unknown;
          input = v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
        } catch {
          input = {};
        }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      if (blocks.length === 0) blocks.push({ type: "text", text: "（空）" });
      push("assistant", blocks);
      continue;
    }
    if (msg.role === "tool") {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
      push("user", [{ type: "tool_result", tool_use_id: msg.tool_call_id ?? "unknown", content: text }]);
      continue;
    }
    const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
    if (text.length > 0) push("user", [{ type: "text", text }]);
  }
  return { system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined, messages: out };
}

function mapFinish(reason: string | undefined | null): ModelResponse["finishReason"] {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return reason ? "error" : "stop";
  }
}
