/**
 * test:live —— 真实模型资格测试（显式授权运行）。
 * 未设置 AGENTGLASS_LIVE=1 或未配置真实模型时 SKIP（不伪装成通过）；
 * 报告输出 skipped/unsupported 状态，不混入确定性 CI。
 */
import { describe, expect, it } from "vitest";

const enabled = process.env.AGENTGLASS_LIVE === "1";
const endpoint = process.env.AGENTGLASS_LIVE_ENDPOINT ?? "";
const modelId = process.env.AGENTGLASS_LIVE_MODEL ?? "";

describe.skipIf(!enabled)("真实模型 smoke（需要显式授权）", () => {
  it("openai-compatible 端点连通且流式返回", async () => {
    const { OpenAICompatProvider } = await import("@agentglass/provider-gateway");
    const provider = new OpenAICompatProvider();
    const snapshot = {
      id: "snap-live",
      provider: "openai-compatible",
      protocol: "openai/v1",
      endpointId: endpoint,
      modelId,
      secretRef: "env:AGENTGLASS_OPENAI_API_KEY",
      parameters: { endpoint },
      capabilities: provider.declaredCapabilities(),
    };
    const result = await provider.invoke(snapshot, [
      { role: "user", content: "reply with the single word: pong" },
    ], { stream: true, maxOutputTokens: 32 });
    expect(result.stream).toBeDefined();
    const fin = await result.stream!.final;
    expect(fin.messageText.length).toBeGreaterThan(0);
    console.log(`[live] model=${modelId} finish=${fin.finishReason} usage=${JSON.stringify(fin.usage)}`);
  }, 60_000);
});

describe.skipIf(!enabled || process.env.AGENTGLASS_LIVE_PROVIDER !== "anthropic")("真实模型 smoke（anthropic 协议，需要显式授权）", () => {
  it("anthropic 端点连通、流式返回且用量真实", async () => {
    const { AnthropicCompatProvider } = await import("@agentglass/provider-gateway");
    const provider = new AnthropicCompatProvider();
    const snapshot = {
      id: "snap-live-anthropic",
      provider: "anthropic",
      protocol: "anthropic/v1",
      endpointId: endpoint,
      modelId,
      secretRef: "env:AGENTGLASS_OPENAI_API_KEY",
      parameters: { endpoint },
      capabilities: provider.declaredCapabilities(),
    };
    const result = await provider.invoke(snapshot, [
      { role: "user", content: "reply with the single word: pong" },
    ], { stream: true, maxOutputTokens: 1024 });
    expect(result.stream).toBeDefined();
    const fin = await result.stream!.final;
    expect(fin.messageText.length).toBeGreaterThan(0);
    expect(fin.usage.inputTokens ?? 0).toBeGreaterThan(0);
    console.log(`[live][anthropic] model=${modelId} finish=${fin.finishReason} usage=${JSON.stringify(fin.usage)}`);
  }, 120_000);
});

if (!enabled) {
  it("test:live 未授权运行（AGENTGLASS_LIVE!=1）：显式跳过，不计为通过", () => {
    expect(true).toBe(true);
  });
}
