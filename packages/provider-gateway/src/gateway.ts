/**
 * 模型网关（T04）。冻结配置 → 能力校验 → 提供方适配。
 * 预算预留与事件记录由运行时调用方完成；网关只负责真实调用与证据。
 * 依据设计文档 v1.1 第 11 节。
 */
import { randomUUID } from "node:crypto";
import type {
  InvokeOptions,
  ModelCapabilities,
  ModelProfileSnapshot,
  ModelProvider,
  ModelResponse,
  InvokeResult,
} from "@agentglass/contracts";
import { FakeProvider } from "./fake-provider";
import { OpenAICompatProvider } from "./openai-compat";
import { AnthropicCompatProvider } from "./anthropic-compat";
import type { BlobStore } from "@agentglass/events";

export class ModelNotConfiguredError extends Error {
  constructor(message = "未配置可用模型：不能发起标为实时的运行") {
    super(message);
    this.name = "ModelNotConfiguredError";
  }
}

export class CapabilityMismatchError extends Error {
  constructor(public readonly required: string, message: string) {
    super(message);
    this.name = "CapabilityMismatchError";
  }
}

export class ModelGateway {
  private providers: Map<string, ModelProvider> = new Map();

  constructor(blobs?: BlobStore) {
    this.register(new FakeProvider());
    this.register(new OpenAICompatProvider(blobs));
    this.register(new AnthropicCompatProvider(blobs));
  }

  register(provider: ModelProvider): void {
    this.providers.set(provider.providerId, provider);
  }

  providerFor(snapshot: ModelProfileSnapshot): ModelProvider {
    const p = this.providers.get(snapshot.provider);
    if (!p) throw new CapabilityMismatchError(snapshot.provider, `未知提供方类型: ${snapshot.provider}`);
    return p;
  }

  /** 每次调用使用冻结快照；不隐藏模型切换 */
  async invoke(
    snapshot: ModelProfileSnapshot,
    messages: unknown,
    options: InvokeOptions,
  ): Promise<InvokeResult & { snapshot: ModelProfileSnapshot }> {
    const provider = this.providerFor(snapshot);
    const caps = effectiveCapabilities(snapshot, provider);
    this.checkCapabilities(caps, options);
    const result = await provider.invoke(snapshot, messages as import("@agentglass/contracts").JsonValue, options);
    return { ...result, snapshot };
  }

  /** 流式统一适配：无流式能力时直接调用 final */
  async invokeComplete(
    snapshot: ModelProfileSnapshot,
    messages: unknown,
    options: InvokeOptions,
    onDelta?: (textDelta: string) => void,
  ): Promise<ModelResponse> {
    const result = await this.invoke(snapshot, messages, options);
    if (result.stream) {
      for await (const batch of result.stream.deltas) {
        for (const d of batch) {
          if (d.kind === "text") onDelta?.(d.text);
        }
      }
      return result.stream.final;
    }
    if (!result.response) throw new Error("PROVIDER_RETURNED_NEITHER_STREAM_NOR_RESPONSE");
    return result.response;
  }

  private checkCapabilities(caps: ModelCapabilities, options: InvokeOptions): void {
    if (options.stream && !caps.streaming) {
      throw new CapabilityMismatchError("streaming", "模型不支持流式输出");
    }
    if (options.tools && options.tools.length > 0 && !caps.nativeTools) {
      throw new CapabilityMismatchError("native_tools", "模型不支持原生工具调用");
    }
  }
}

/** 已探测能力优先；未探测时使用声明能力的保守子集 */
export function effectiveCapabilities(
  snapshot: ModelProfileSnapshot,
  provider: ModelProvider,
): ModelCapabilities {
  const declared = provider.declaredCapabilities();
  const snapshotted = snapshot.capabilities;
  if (!snapshotted || snapshotted.testedAt === "static-declaration") return declared;
  return snapshotted;
}

export function newModelCallId(): string {
  return `call_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
