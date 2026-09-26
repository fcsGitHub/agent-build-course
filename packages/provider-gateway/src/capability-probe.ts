/**
 * 能力探测（T04）。探测会真实消耗模型资源；仅由用户显式触发。
 * 至少覆盖：连通性、流式、可校验工具调用、结构化输出、用量统计。
 * 依据设计文档 v1.1 第 11.1 节。
 */
import type {
  ModelCapabilities,
  ModelProfileSnapshot,
  ModelProvider,
} from "@agentglass/contracts";

export const PROBE_SUITE_VERSION = "agentglass-probe-1";

export interface ProbeStepResult {
  step: "connectivity" | "streaming" | "tool_call" | "structured_output" | "usage";
  passed: boolean;
  detail: string;
}

export interface ProbeReport {
  ok: boolean;
  capabilities: ModelCapabilities;
  steps: ProbeStepResult[];
  testedAt: string;
}

const ECHO_TOOL: import("@agentglass/contracts").ToolSpecForModel = {
  name: "probe_echo",
  description: "原样返回输入文本（探测专用）",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
};

export async function probeProfile(
  snapshot: ModelProfileSnapshot,
  provider: ModelProvider,
): Promise<ProbeReport> {
  const steps: ProbeStepResult[] = [];
  const caps = provider.declaredCapabilities();
  const base: ModelProfileSnapshot = { ...snapshot, capabilities: caps };
  const common = { stream: false, maxOutputTokens: 256, tools: undefined } as const;

  // 1. 连通性
  try {
    const r = await provider.invoke(base, [
      { role: "user", content: "reply with the single word: pong" },
    ], { ...common, stream: false });
    const r2 = await provider.invoke(base, [
      { role: "user", content: "reply with the single word: pong" },
    ], { ...common, stream: false });
    const ok = !!r.response && r2.response !== undefined;
    steps.push({ step: "connectivity", passed: ok, detail: ok ? "非流式调用成功" : "无响应" });
  } catch (err) {
    steps.push({ step: "connectivity", passed: false, detail: String(err).slice(0, 300) });
    return { ok: false, capabilities: caps, steps, testedAt: new Date().toISOString() };
  }

  // 2. 流式
  if (caps.streaming) {
    try {
      const r = await provider.invoke(base, [{ role: "user", content: "count: one two three" }], {
        ...common,
        stream: true,
      });
      if (r.stream) {
        let sawDelta = false;
        for await (const batch of r.stream.deltas) {
          if (batch.length > 0) sawDelta = true;
        }
        const fin = await r.stream.final;
        steps.push({
          step: "streaming",
          passed: sawDelta && fin.messageText.length > 0,
          detail: sawDelta ? "流式片段与最终响应均到达" : "未收到流式片段",
        });
      } else {
        steps.push({ step: "streaming", passed: false, detail: "提供方未返回流句柄" });
      }
    } catch (err) {
      steps.push({ step: "streaming", passed: false, detail: String(err).slice(0, 300) });
    }
  } else {
    steps.push({ step: "streaming", passed: false, detail: "声明不支持流式" });
  }

  // 3. 工具调用
  if (caps.nativeTools) {
    try {
      const r = await provider.invoke(
        base,
        [
          { role: "system", content: "必须调用 probe_echo 工具，参数 text 填 'ping'。" },
          { role: "user", content: "call the tool" },
        ],
        { ...common, stream: false, tools: [ECHO_TOOL] },
      );
      const tr = r.response?.toolRequests?.[0];
      const valid =
        tr != null &&
        tr.parseError == null &&
        typeof tr.arguments === "object" &&
        tr.arguments !== null &&
        !Array.isArray(tr.arguments) &&
        typeof (tr.arguments as { text?: unknown }).text === "string";
      steps.push({
        step: "tool_call",
        passed: valid,
        detail: valid ? "工具请求 schema 校验通过" : `工具请求无效: ${tr?.parseError ?? tr?.argumentsText?.slice(0, 100) ?? "none"}`,
      });
    } catch (err) {
      steps.push({ step: "tool_call", passed: false, detail: String(err).slice(0, 300) });
    }
  } else {
    steps.push({ step: "tool_call", passed: false, detail: "声明不支持原生工具" });
  }

  // 4. 结构化输出
  try {
    const r = await provider.invoke(
      base,
      [{ role: "user", content: 'Return JSON: {"ok": true}' }],
      { ...common, stream: false, structuredOutputSchemaId: "probe-json" },
    );
    const text = r.response?.rawText ?? "";
    let parsed: unknown = undefined;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    steps.push({
      step: "structured_output",
      passed: parsed != null && typeof parsed === "object",
      detail: parsed != null ? "JSON 可解析" : "输出不是合法 JSON",
    });
  } catch (err) {
    steps.push({ step: "structured_output", passed: false, detail: String(err).slice(0, 300) });
  }

  // 5. 用量统计
  try {
    const r = await provider.invoke(base, [{ role: "user", content: "hi" }], {
      ...common,
      stream: false,
    });
    const u = r.response?.usage;
    steps.push({
      step: "usage",
      passed: u != null && (u.inputTokens != null || u.outputTokens != null),
      detail: u ? `input=${u.inputTokens ?? "?"} output=${u.outputTokens ?? "?"}` : "未报告用量",
    });
  } catch (err) {
    steps.push({ step: "usage", passed: false, detail: String(err).slice(0, 300) });
  }

  const testedAt = new Date().toISOString();
  const capabilities: ModelCapabilities = {
    ...caps,
    streaming: steps.find((s) => s.step === "streaming")?.passed ?? false,
    nativeTools: steps.find((s) => s.step === "tool_call")?.passed ?? false,
    structuredOutput: steps.find((s) => s.step === "structured_output")?.passed
      ? caps.structuredOutput
      : "text_only",
    usageReporting:
      steps.find((s) => s.step === "usage")?.passed && caps.streaming
        ? "stream_and_final"
        : steps.find((s) => s.step === "usage")?.passed
          ? "final"
          : "none",
    testedAt,
    probeSuiteVersion: PROBE_SUITE_VERSION,
  };
  return {
    ok: steps.every((s) => s.passed),
    capabilities,
    steps,
    testedAt,
  };
}
