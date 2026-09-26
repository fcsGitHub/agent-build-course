/**
 * 密钥引用存在但环境变量未设置时，提供方必须快速失败并给出可操作错误（不发无效请求）。
 * 背景：曾静默省略 Authorization 头，云端返回 401 "Authentication Fails"，
 * 用户误以为密钥错误，实际是服务进程读不到环境变量。
 */
import { describe, expect, it } from "vitest";
import { AnthropicCompatProvider, OpenAICompatProvider } from "@agentglass/provider-gateway";
import type { ModelProfileSnapshot } from "@agentglass/contracts";

const UNSET_NAME = "AGENTGLASS_DEFinitely_UNSET_VAR_8153";
// 防御：若环境中恰好存在同名变量，改用更冷门的名字
const name = process.env[UNSET_NAME] == null ? UNSET_NAME : `${UNSET_NAME}_X`;

function snapshot(provider: OpenAICompatProvider | AnthropicCompatProvider): ModelProfileSnapshot {
  return {
    id: "snap_secret_missing",
    provider: provider.providerId,
    protocol: provider.providerId === "anthropic" ? "anthropic/v1" : "openai/v1",
    endpointId: "https://example.invalid",
    modelId: "stub-model",
    secretRef: `env:${name}`,
    parameters: { endpoint: "https://example.invalid" },
    capabilities: provider.declaredCapabilities(),
  };
}

describe("密钥缺失快速失败（SECRET_MISSING）", () => {
  it("openai-compatible：env 引用未设置时报可操作错误，且不发起 HTTP 请求", async () => {
    const provider = new OpenAICompatProvider();
    await expect(
      provider.invoke(snapshot(provider), [{ role: "user", content: "hi" }], { stream: false, maxOutputTokens: 16 }),
    ).rejects.toThrow(/SECRET_MISSING/);
    await expect(
      provider.invoke(snapshot(provider), [{ role: "user", content: "hi" }], { stream: true, maxOutputTokens: 16 }),
    ).rejects.toThrow(new RegExp(name));
  });

  it("anthropic：env 引用未设置时同样快速失败", async () => {
    const provider = new AnthropicCompatProvider();
    await expect(
      provider.invoke(snapshot(provider), [{ role: "user", content: "hi" }], { stream: false, maxOutputTokens: 16 }),
    ).rejects.toThrow(/SECRET_MISSING/);
  });

  it("错误信息包含变量名与重启指引（可操作性）", async () => {
    const provider = new OpenAICompatProvider();
    try {
      await provider.invoke(snapshot(provider), [{ role: "user", content: "hi" }], {
        stream: false,
        maxOutputTokens: 16,
      });
      expect.unreachable("应当抛出 SECRET_MISSING");
    } catch (err) {
      const msg = String(err);
      expect(msg).toContain(`env:${name}`);
      expect(msg).toContain("重启");
    }
  });
});
