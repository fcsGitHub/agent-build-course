/**
 * OpenAI-compatible 流式回归测试（本地 stub；不消耗外部模型）。
 * 背景：stream 句柄曾被 deltas 与 final 两个消费者共享同一生成器，
 * 单槽唤醒互相覆盖导致 final 挂起（anthropic 适配器同构修复时一并发现）。
 * 本测试固定该回归：deltas 消费完毕后 final 必须解析。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { OpenAICompatProvider } from "@agentglass/provider-gateway";
import type { ModelProfileSnapshot } from "@agentglass/contracts";

let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunks = [
        { choices: [{ delta: { content: "he" } }] },
        { choices: [{ delta: { content: "llo" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 2 } },
      ];
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("OpenAI-compatible 流式回归", () => {
  it("deltas 消费完毕后 final 解析（不挂起），文本与用量正确", async () => {
    const provider = new OpenAICompatProvider();
    const snapshot: ModelProfileSnapshot = {
      id: "snap_openai_test",
      provider: "openai-compatible",
      protocol: "openai/v1",
      endpointId: `http://127.0.0.1:${port}`,
      modelId: "stub-model",
      secretRef: undefined,
      parameters: { endpoint: `http://127.0.0.1:${port}` },
      capabilities: provider.declaredCapabilities(),
    };
    const res = await provider.invoke(snapshot, [{ role: "user", content: "hi" }], {
      stream: true,
      maxOutputTokens: 32,
    });
    expect(res.stream).toBeDefined();
    const finalPromise = res.stream!.final;
    const seen: string[] = [];
    for await (const batch of res.stream!.deltas) {
      for (const d of batch) if (d.kind === "text") seen.push(d.text);
    }
    expect(seen.join("")).toBe("hello");
    const fin = await Promise.race([
      finalPromise,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("FINAL_HANG: 流式 final 未解析")), 5000)),
    ]);
    expect(fin.messageText).toBe("hello");
    expect(fin.finishReason).toBe("stop");
    expect(fin.usage.inputTokens).toBe(7);
    expect(fin.usage.outputTokens).toBe(2);
  }, 20_000);
});
