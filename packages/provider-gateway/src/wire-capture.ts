/**
 * 出站载荷证据（T04）。请求证据在序列化完成、网络发送前捕获；
 * Authorization、密钥等凭据不得进入证据。
 * 依据设计文档 v1.1 第 10.1/11.2 节。
 */
import type { BlobRef } from "@agentglass/contracts";
import type { BlobStore } from "@agentglass/events";
import { redactSensitive } from "@agentglass/policy";

export interface WireCaptureResult {
  ref?: BlobRef;
  capture: "wire_and_compiled" | "compiled_only" | "partial";
}

export function captureWireBody(
  blobs: BlobStore,
  body: unknown,
  opts: { capture: boolean },
): WireCaptureResult {
  if (!opts.capture) return { capture: "partial" };
  const redacted = redactSensitive(body);
  const ref = blobs.putJson(redacted);
  return { ref, capture: "wire_and_compiled" };
}
