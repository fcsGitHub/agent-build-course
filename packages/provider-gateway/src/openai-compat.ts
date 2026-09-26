/**
 * OpenAI-compatible 适配器（T04）。真实网络请求；流式 SSE 解析；
 * 工具参数分片归并完成后才解析 JSON（绝不 eval 半个 JSON）。
 * 依据设计文档 v1.1 第 11.2/11.3 节。
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
import type { BlobStore } from "@agentglass/events";

export class ProviderHttpError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

interface WireBody {
  model: string;
  messages: unknown[];
  tools?: unknown[];
  tool_choice?: string;
  stream: boolean;
  max_tokens?: number;
  temperature?: number;
  response_format?: unknown;
}

export class OpenAICompatProvider implements ModelProvider {
  readonly providerId = "openai-compatible";
  readonly protocol = "openai/v1";

  constructor(private readonly blobs?: BlobStore) {}

  declaredCapabilities(): ModelCapabilities {
    return {
      streaming: true,
      nativeTools: true,
      parallelToolCalls: true,
      structuredOutput: "native_schema",
      imageInput: false,
      audioInput: false,
      outputModalities: ["text"],
      usageReporting: "stream_and_final",
      testedAt: "static-declaration",
      probeSuiteVersion: "openai-compat-1",
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
    const body: WireBody = {
      model: snapshot.modelId,
      messages: (Array.isArray(messages) ? messages : []) as unknown[],
      stream: options.stream,
      max_tokens: options.maxOutputTokens,
    };
    if (options.temperature != null) body.temperature = options.temperature;
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = "auto";
    }
    if (options.structuredOutputSchemaId) {
      body.response_format = { type: "json_object" };
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
      headers: {
        "content-type": "application/json",
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      },
      body: bodyText,
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderHttpError(res.status, `HTTP_${res.status}`, truncate(text, 500));
    }
    const json = (await res.json()) as {
      choices?: Array<{
        finish_reason?: string;
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = json.choices?.[0];
    const toolRequests: ModelToolRequest[] = (choice?.message?.tool_calls ?? []).map((tc) => {
      const parsed = safeParseJson(tc.function.arguments);
      return {
        id: tc.id,
        name: tc.function.name,
        argumentsText: tc.function.arguments,
        arguments: parsed.value,
        parseError: parsed.error,
      };
    });
    const usage: ModelUsage = {
      inputTokens: json.usage?.prompt_tokens,
      outputTokens: json.usage?.completion_tokens,
    };
    return {
      callId: randomUUID(),
      finishReason: mapFinish(choice?.finish_reason),
      messageText: choice?.message?.content ?? "",
      toolRequests,
      usage,
      rawText: choice?.message?.content ?? "",
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
    const toolAccumulators = new Map<
      number,
      { id: string; name: string; argumentsText: string }
    >();
    let textParts: string[] = [];
    let finishReason: string | undefined;
    let usage: ModelUsage = {};

    async function* generate(): AsyncGenerator<StreamDelta[]> {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        },
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
          if (data === "[DONE]") return;
          let chunk: {
            choices?: Array<{
              delta?: {
                content?: string | null;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          const choice = chunk.choices?.[0];
          const batch: StreamDelta[] = [];
          if (choice?.delta?.content) {
            textParts.push(choice.delta.content);
            batch.push({ kind: "text", text: choice.delta.content });
          }
          if (choice?.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const acc = toolAccumulators.get(tc.index) ?? {
                id: tc.id ?? `call_${tc.index}`,
                name: "",
                argumentsText: "",
              };
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments) acc.argumentsText += tc.function.arguments;
              toolAccumulators.set(tc.index, acc);
              batch.push({
                kind: "tool_call_delta",
                index: tc.index,
                id: tc.id,
                name: tc.function?.name,
                argumentsDelta: tc.function?.arguments ?? "",
              });
            }
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (chunk.usage) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
            };
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
          const parsed = safeParseJson(acc.argumentsText || "{}");
          return {
            id: acc.id,
            name: acc.name,
            argumentsText: acc.argumentsText,
            arguments: parsed.value,
            parseError: parsed.error,
          };
        });
      const text = textParts.join("");
      return {
        callId,
        finishReason: mapFinish(finishReason ?? (toolRequests.length > 0 ? "tool_calls" : "stop")),
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

export function snapshotEndpoint(snapshot: ModelProfileSnapshot): string {
  const raw = (snapshot.parameters ?? {}) as Record<string, JsonValue>;
  const base = String(raw.endpoint ?? "");
  if (!base) throw new Error("MODEL_ENDPOINT_MISSING");
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

/** 密钥本体不进入快照；调用前通过 secretRef 解析。引用存在但解析不到时快速失败，避免发出必然 401 的请求误导排障。 */
export function snapshotSecret(snapshot: ModelProfileSnapshot): string | undefined {
  const ref = snapshot.secretRef;
  if (!ref) return undefined;
  if (ref.startsWith("env:")) {
    const name = ref.slice(4);
    const v = process.env[name];
    if (!v || v.length === 0) {
      throw new Error(
        `SECRET_MISSING: 密钥引用 ${ref} 在服务进程环境中未设置或为空。请先设置环境变量（如 export ${name}=你的密钥，或 PowerShell：$env:${name}="你的密钥"），再重启 API 与 worker 进程，然后重新探测。`,
      );
    }
    return v;
  }
  return undefined;
}

function mapFinish(reason: string | undefined | null): ModelResponse["finishReason"] {
  switch (reason) {
    case "stop":
      return "stop";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return reason ? "error" : "stop";
  }
}

export function safeParseJson(text: string): { value?: JsonValue; error?: string } {
  try {
    return { value: JSON.parse(text) as JsonValue };
  } catch (err) {
    return { error: `INVALID_TOOL_ARGUMENTS_JSON: ${String(err)}` };
  }
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
