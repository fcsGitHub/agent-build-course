/**
 * Anthropic-protocol 适配器合同测试（本地 stub 服务器；不消耗外部模型）。
 * 覆盖：消息翻译（system 顶层化 / tool_calls→tool_use / tool→tool_result 连续合并）、
 * 非流式响应块解析、SSE 流式（text_delta/input_json_delta/usage/stop_reason）、
 * 探测套件在 Anthropic 协议上可完整通过。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { AnthropicCompatProvider, probeProfile } from "@agentglass/provider-gateway";
import type { ModelProfileSnapshot } from "@agentglass/contracts";

let server: Server;
let port = 0;
let lastBody: Record<string, unknown> | undefined;

function snapshotOf(): ModelProfileSnapshot {
  const provider = new AnthropicCompatProvider();
  return {
    id: "snap_anthropic_test",
    provider: "anthropic",
    protocol: "anthropic/v1",
    endpointId: `http://127.0.0.1:${port}`,
    modelId: "stub-model",
    secretRef: undefined,
    parameters: { endpoint: `http://127.0.0.1:${port}` },
    capabilities: provider.declaredCapabilities(),
  };
}

function sse(res: ServerResponse, events: Array<Record<string, unknown>>): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) {
    res.write(`event: ${String(e["type"])}\ndata: ${JSON.stringify(e)}\n\n`);
  }
  res.end();
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      lastBody = JSON.parse(raw) as Record<string, unknown>;
      if (req.url?.endsWith("/v1/messages") !== true) {
        res.writeHead(404).end();
        return;
      }
      // stub 按请求语义应答：stream → SSE；带 tools → tool_use；否则返回 JSON 文本（结构化输出步）
      if (lastBody?.stream === true) {
        sse(res, [
          { type: "message_start", message: { usage: { input_tokens: 12 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
          { type: "message_stop" },
        ]);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      const tools = lastBody?.tools as Array<{ name: string; input_schema?: { required?: string[] } }> | undefined;
      if (Array.isArray(tools) && tools.length > 0) {
        // 按请求的第一个工具回显：required 属性填占位值（path → data/a.csv，其余 → ping）
        const t = tools[0]!;
        const input: Record<string, unknown> = {};
        for (const key of t.input_schema?.required ?? []) {
          input[key] = key === "path" ? "data/a.csv" : "ping";
        }
        res.end(
          JSON.stringify({
            id: "msg_stub",
            type: "message",
            role: "assistant",
            model: "stub-model",
            content: [
              { type: "text", text: "先读文件。" },
              { type: "tool_use", id: "toolu_1", name: t.name, input },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 42, output_tokens: 9 },
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          id: "msg_stub2",
          type: "message",
          role: "assistant",
          model: "stub-model",
          content: [{ type: "text", text: '{"ok": true}' }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 4 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("Anthropic 适配器（本地 stub）", () => {
  it("消息翻译正确且非流式响应块映射为 toolRequests", async () => {
    const provider = new AnthropicCompatProvider();
    const res = await provider.invoke(snapshotOf(), [
      { role: "system", content: "宿主规则A" },
      { role: "system", content: "宿主规则B" },
      { role: "user", content: "读一下文件" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", function: { name: "read_text", arguments: '{"path":"x"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "文件内容1" },
      { role: "tool", tool_call_id: "call_1b", content: "文件内容2" },
    ], {
      stream: false,
      maxOutputTokens: 256,
      tools: [{ name: "read_text", description: "读文件", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
    });

    expect(lastBody).toBeDefined();
    expect(lastBody?.system).toBe("宿主规则A\n\n宿主规则B");
    expect(lastBody?.max_tokens).toBe(256);
    expect(lastBody?.thinking).toEqual({ type: "disabled" });
    const msgs = lastBody?.messages as Array<{ role: string; content: Array<{ type: string; text?: string; tool_use_id?: string }> }>;
    // user → assistant(tool_use) → user(两条 tool_result 合并)
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[1]!.role).toBe("assistant");
    expect(msgs[1]!.content.some((b) => b.type === "tool_use")).toBe(true);
    expect(msgs[2]!.role).toBe("user");
    const results = msgs[2]!.content.filter((b) => b.type === "tool_result");
    expect(results).toHaveLength(2);
    expect(results[0]?.tool_use_id).toBe("call_1");

    const response = res.response!;
    expect(response.finishReason).toBe("tool_calls");
    expect(response.messageText).toBe("先读文件。");
    expect(response.toolRequests).toHaveLength(1);
    expect(response.toolRequests[0]?.name).toBe("read_text");
    expect(response.toolRequests[0]?.arguments).toEqual({ path: "data/a.csv" });
    expect(response.usage.inputTokens).toBe(42);
    expect(response.usage.outputTokens).toBe(9);
  });

  it("流式：text_delta 逐片到达，final 聚合正文与用量", async () => {
    const provider = new AnthropicCompatProvider();
    const res = await provider.invoke(snapshotOf(), [{ role: "user", content: "打个招呼" }], {
      stream: true,
      maxOutputTokens: 64,
    });
    expect(res.stream).toBeDefined();
    const seen: string[] = [];
    for await (const batch of res.stream!.deltas) {
      for (const d of batch) if (d.kind === "text") seen.push(d.text);
    }
    expect(seen.join("")).toBe("你好");
    const fin = await res.stream!.final;
    expect(fin.messageText).toBe("你好");
    expect(fin.finishReason).toBe("stop");
    expect(fin.usage.inputTokens).toBe(12);
    expect(fin.usage.outputTokens).toBe(3);
  });

  it("探测套件在 Anthropic 协议上全部通过（连通/流式/工具/JSON/用量）", async () => {
    const provider = new AnthropicCompatProvider();
    const report = await probeProfile(snapshotOf(), provider);
    const byStep = Object.fromEntries(report.steps.map((s) => [s.step, s.passed]));
    expect(byStep.connectivity).toBe(true);
    expect(byStep.streaming).toBe(true);
    expect(byStep.tool_call).toBe(true);
    expect(byStep.structured_output).toBe(true);
    expect(byStep.usage).toBe(true);
    expect(report.capabilities.nativeTools).toBe(true);
    expect(report.capabilities.structuredOutput).toBe("text_only");
  });
});
