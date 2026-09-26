/**
 * 课程 A2A agent 的本地 HTTP 桥（教学夹具）。
 * course-agent.mjs 是 stdio JSON-RPC 进程；本桥把它暴露为 http://127.0.0.1:<port>
 * 供 A2aClient（课程运行与测试）访问。仅绑定回环地址，agent 输出视为待验证信息。
 */
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export const COURSE_AGENT_MJS = fileURLToPath(new URL("./course-agent.mjs", import.meta.url));

export interface CourseAgentBridge {
  baseUrl: string;
  card: unknown;
  close(): Promise<void>;
}

interface PendingMsg {
  id?: number;
  result?: unknown;
  error?: unknown;
}

export function startCourseAgentBridge(agentScript: string = COURSE_AGENT_MJS): Promise<CourseAgentBridge> {
  return new Promise((resolve, reject) => {
    const agentProc: ChildProcess = spawn(process.execPath, [agentScript], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "" },
    });
    let stderr = "";
    agentProc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    agentProc.on("exit", (code) => {
      if (code !== 0 && code !== null) reject(new Error(`course-agent exited: ${code} ${stderr.slice(0, 200)}`));
    });

    const pending = new Map<number, (v: PendingMsg) => void>();
    let nextId = 1;
    agentProc.stdout?.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as PendingMsg;
          const resolver = pending.get(msg.id as number);
          if (resolver) {
            pending.delete(msg.id as number);
            resolver(msg);
          }
        } catch { /* 非 JSON 行忽略 */ }
      }
    });
    const rpc = (method: string, params: unknown): Promise<PendingMsg> =>
      new Promise((res) => {
        const id = nextId++;
        pending.set(id, res);
        agentProc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });

    const server: Server = createServer((req, res) => {
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
    server.on("error", reject);
    void (async () => {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as { port: number }).port;
      const cardRpc = await rpc("card", {});
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        card: cardRpc.result,
        close: async () => {
          agentProc.kill("SIGKILL");
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    })();
  });
}
