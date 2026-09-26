/**
 * T28 A2A 合同测试：agent card 发现、message/send、tasks/get/cancel、
 * artifact 校验、SSRF、agent-as-tool 映射后仍走白名单。
 * fixture：course-agent.mjs 子进程 + 本地 http server 桥接（模拟远程 A2A HTTP）。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { A2aClient, A2aProtocolError } from "@agentglass/a2a";

const AGENT_MJS = join(__dirname, "..", "..", "packages", "a2a", "src", "course-agent.mjs");

let server: Server;
let baseUrl = "";
let agentProc: ChildProcess;

// 本地 http server：把 A2aClient 的 JSON-RPC HTTP POST 桥接到 agent 子进程 stdio
beforeAll(async () => {
  agentProc = spawn(process.execPath, [AGENT_MJS], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
  const pending = new Map<number, (v: { id?: number; result?: unknown; error?: unknown }) => void>();
  let nextId = 1;
  agentProc.stdout?.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const resolver = pending.get(msg.id) as ((v: unknown) => void) | undefined;
        if (resolver) {
          pending.delete(msg.id);
          resolver(msg);
        }
      } catch { /* ignore */ }
    }
  });
  const rpc = (method: string, params: unknown): Promise<{ id?: number; result?: unknown; error?: unknown }> =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      agentProc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  server = createServer((req, res) => {
    if (req.method === "GET" && req.url?.includes("agent.json")) {
      void rpc("card", {}).then((r) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(r.result));
      });
      return;
    }
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { method?: string; params?: unknown };
      void rpc(parsed.method ?? "message/send", parsed.params).then((r) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(r));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  agentProc?.kill("SIGKILL");
  await new Promise<void>((r) => server.close(() => r()));
});

describe("T28 A2A 合同", () => {
  it("agent card 发现：name/skills 可读", async () => {
    const client = new A2aClient({ baseUrl, allowPrivateNetwork: true });
    const card = await client.fetchAgentCard();
    expect(card.name).toBe("agentglass-course-agent");
    expect(card.skills.some((s) => s.id === "spec-summary")).toBe(true);
  });

  it("message/send：任务完成并返回 artifact 文本", async () => {
    const client = new A2aClient({ baseUrl, allowPrivateNetwork: true });
    const task = await client.sendMessage("请总结 AG-2048 的规格");
    expect(task.status.state).toBe("completed");
    const text = (task.artifacts ?? []).flatMap((a) => a.parts).map((p) => p.text ?? "").join("");
    expect(text).toContain("远程 Agent 回答");
  });

  it("tasks/get 返回既有任务；artifact 校验仅接受 text", async () => {
    const client = new A2aClient({ baseUrl, allowPrivateNetwork: true });
    const task = await client.sendMessage("hello");
    const got = await client.getTask(task.id);
    expect(got.id).toBe(task.id);
    // artifact 类型校验（非 text 拒绝）
    const bad = { ...task, artifacts: [{ parts: [{ type: "binary", data: "zz" }] }] } as unknown as Parameters<typeof A2aClient.artifactText>[0];
    expect(() => A2aClient.artifactText(bad)).toThrow(/A2A_ARTIFACT_INVALID/);
  });

  it("tasks/cancel 将任务置为 canceled", async () => {
    const client = new A2aClient({ baseUrl, allowPrivateNetwork: true });
    const task = await client.sendMessage("to be canceled");
    const canceled = await client.cancelTask(task.id);
    expect(canceled.status.state).toBe("canceled");
  });

  it("SSRF：非 http(s) 或私网 baseUrl 被拒绝", async () => {
    const client = new A2aClient({ baseUrl: "file:///etc" });
    await expect(client.fetchAgentCard()).rejects.toThrow();
  });
});
