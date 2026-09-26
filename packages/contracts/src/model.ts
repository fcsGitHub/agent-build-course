/**
 * 模型网关合同。依据设计文档 v1.1 第 11.1 节。
 */
import type { BlobRef, JsonValue } from "./runtime";

export interface ModelCapabilities {
  streaming: boolean;
  nativeTools: boolean;
  parallelToolCalls: boolean;
  structuredOutput: "native_schema" | "json_only" | "text_only";
  imageInput: boolean;
  audioInput: boolean;
  outputModalities: ("text" | "image" | "audio")[];
  usageReporting: "final" | "stream_and_final" | "none";
  contextWindow?: number;
  testedAt: string;
  probeSuiteVersion: string;
}

export interface ModelProfileSnapshot {
  id: string;
  provider: string;
  protocol: string;
  endpointId: string;
  modelId: string;
  /** 无认证的本地服务可不设置；绝不保存密钥本体 */
  secretRef?: string;
  parameters: { [key: string]: JsonValue };
  capabilities: ModelCapabilities;
  priceTableVersion?: string;
}

export type ModelCallPurpose =
  | "agent"
  | "summary"
  | "embedding"
  | "rerank"
  | "judge"
  | "tutor";

export interface ModelCall {
  callId: string;
  runId: string;
  purpose: ModelCallPurpose;
  modelSnapshotId: string;
  /** 对话类调用必填；embedding 等直接引用输入工件 */
  compiledContextId?: string;
  inputRef: BlobRef;
  maxOutputTokens: number;
}

export interface ToolSpecForModel {
  name: string;
  description: string;
  parameters: JsonValue; // JSON Schema
}

export interface ModelToolRequest {
  id: string;
  name: string;
  /** 原始参数文本；分片归并完成后再解析，绝不 eval */
  argumentsText: string;
  arguments?: JsonValue;
  parseError?: string;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** 提供方未报告时为 undefined，不得伪造 */
  costMicros?: number;
}

export type FinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter"
  | "cancelled"
  | "error";

export interface ModelResponse {
  callId: string;
  finishReason: FinishReason;
  messageText: string;
  toolRequests: ModelToolRequest[];
  usage: ModelUsage;
  /** 提供方原生结构化输出时 JSON 的原始文本 */
  rawText: string;
}

export interface ModelRequestEvidence {
  /** 序列化完成、网络发送前捕获的出站应用层载荷（已脱敏） */
  wireBodyRef?: BlobRef;
  capture: "wire_and_compiled" | "compiled_only" | "partial";
  endpoint: string;
  modelId: string;
}

export type StreamDelta =
  | { kind: "text"; text: string }
  | { kind: "tool_call_delta"; index: number; id?: string; name?: string; argumentsDelta: string };

export interface ModelStreamHandle {
  deltas: AsyncIterable<StreamDelta[]>;
  final: Promise<ModelResponse>;
  cancel(): Promise<void>;
}

export interface InvokeOptions {
  stream: boolean;
  tools?: ToolSpecForModel[];
  structuredOutputSchemaId?: string;
  signal?: AbortSignal;
  maxOutputTokens: number;
  temperature?: number;
}

export interface InvokeResult {
  stream?: ModelStreamHandle;
  /** 流式调用时可省略；使用 stream.final 获取最终响应 */
  response?: ModelResponse;
  evidence: ModelRequestEvidence;
}

export interface ModelProvider {
  readonly providerId: string;
  readonly protocol: string;
  /** 明确声明的能力，未经探测前按保守值处理 */
  declaredCapabilities(): ModelCapabilities;
  invoke(
    snapshot: ModelProfileSnapshot,
    messages: JsonValue,
    options: InvokeOptions,
  ): Promise<InvokeResult>;
}
