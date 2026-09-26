/**
 * T28：A2A 远程协议客户端（JSON-RPC over HTTP 子集）。
 * - Agent Card 发现：GET {base}/.well-known/agent.json（SSRF 校验）；
 * - message/send（发起任务）、tasks/get（状态）、tasks/cancel（取消）；
 * - 返回 artifact 校验（类型/大小）；授权 token 可选（env 引用）。
 * 依据设计文档 v1.1 §14.1/§14.4。
 */
import type { JsonValue } from "@agentglass/contracts";
import { assertPublicUrl, SSRFError } from "@agentglass/mcp";

export interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  skills: Array<{ id: string; name: string; description?: string }>;
  provider?: { organization: string };
}

export interface A2aTask {
  id: string;
  status: { state: "submitted" | "working" | "completed" | "failed" | "canceled"; message?: string };
  artifacts?: Array<{ name?: string; parts: Array<{ type: string; text?: string }> }>;
}

export class A2aProtocolError extends Error {
  constructor(public readonly code: "A2A_HTTP" | "A2A_PROTOCOL" | "SSRF_HOSTNAME" | "A2A_TIMEOUT" | "A2A_ARTIFACT_INVALID", message: string) {
    super(message);
    this.name = "A2aProtocolError";
  }
}

export interface A2aClientOptions {
  baseUrl: string;
  bearerEnvVar?: string;
  timeoutMs?: number;
  /** 受控教学环境显式放开私网地址（本地实验 agent）；默认拒绝 */
  allowPrivateNetwork?: boolean;
}

export class A2aClient {
  constructor(private readonly options: A2aClientOptions) {}

  private base(): URL {
    const raw = this.options.baseUrl.endsWith("/") ? this.options.baseUrl.slice(0, -1) : this.options.baseUrl;
    if (this.options.allowPrivateNetwork === true) {
      const url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new A2aProtocolError("SSRF_HOSTNAME", `仅允许 http(s): ${url.protocol}`);
      }
      return url;
    }
    return assertPublicUrl(raw);
  }

  private async http(url: string, init: { method: "GET" | "POST"; body?: string }): Promise<{ status: number; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);
    try {
      const bearer = this.options.bearerEnvVar ? process.env[this.options.bearerEnvVar] : undefined;
      const res = await fetch(url, {
        method: init.method,
        headers: {
          "content-type": "application/json",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: init.body,
        signal: controller.signal,
      });
      const text = await res.text();
      return { status: res.status, text };
    } catch (err) {
      if (controller.signal.aborted) throw new A2aProtocolError("A2A_TIMEOUT", "A2A 请求超时");
      throw new A2aProtocolError("A2A_HTTP", String(err).slice(0, 200));
    } finally {
      clearTimeout(timer);
    }
  }

  /** Agent Card 发现（能力/技能自述——待验证信息，不是授权） */
  async fetchAgentCard(): Promise<AgentCard> {
    const base = this.base();
    const { status, text } = await this.http(`${base}/.well-known/agent.json`, { method: "GET" });
    if (status !== 200) throw new A2aProtocolError("A2A_HTTP", `agent card 获取失败 HTTP ${status}`);
    let card: AgentCard;
    try {
      card = JSON.parse(text) as AgentCard;
    } catch {
      throw new A2aProtocolError("A2A_PROTOCOL", "agent card 不是合法 JSON");
    }
    if (!card.name || !Array.isArray(card.skills)) {
      throw new A2aProtocolError("A2A_PROTOCOL", "agent card 缺少 name/skills");
    }
    return card;
  }

  /** message/send：发起任务并等待终态（教学子集：同步返回） */
  async sendMessage(text: string, taskId?: string): Promise<A2aTask> {
    const base = this.base();
    const params: Record<string, unknown> = {
      message: {
        role: "user",
        parts: [{ type: "text", text: text.slice(0, 4000) }],
      },
    };
    if (taskId) params.task = { id: taskId };
    const { status, text: body } = await this.http(`${base}/`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "message/send", params }),
    });
    if (status !== 200) throw new A2aProtocolError("A2A_HTTP", `message/send HTTP ${status}`);
    let msg: { result?: { task?: A2aTask }; error?: { message?: string } };
    try {
      msg = JSON.parse(body);
    } catch {
      throw new A2aProtocolError("A2A_PROTOCOL", "message/send 响应不是合法 JSON");
    }
    if (msg.error) throw new A2aProtocolError("A2A_HTTP", msg.error.message ?? "message/send 失败");
    const task = msg.result?.task;
    if (!task) throw new A2aProtocolError("A2A_PROTOCOL", "响应缺少 task");
    return task;
  }

  async getTask(taskId: string): Promise<A2aTask> {
    const base = this.base();
    const { status, text } = await this.http(`${base}/`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tasks/get", params: { id: taskId } }),
    });
    if (status !== 200) throw new A2aProtocolError("A2A_HTTP", `tasks/get HTTP ${status}`);
    const msg = JSON.parse(text) as { result?: { task?: A2aTask }; error?: { message?: string } };
    if (msg.error) throw new A2aProtocolError("A2A_HTTP", msg.error.message ?? "tasks/get 失败");
    if (!msg.result?.task) throw new A2aProtocolError("A2A_PROTOCOL", "响应缺少 task");
    return msg.result.task;
  }

  async cancelTask(taskId: string): Promise<A2aTask> {
    const base = this.base();
    const { status, text } = await this.http(`${base}/`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tasks/cancel", params: { id: taskId } }),
    });
    if (status !== 200) throw new A2aProtocolError("A2A_HTTP", `tasks/cancel HTTP ${status}`);
    return (JSON.parse(text) as { result?: { task?: A2aTask } }).result?.task ?? { id: taskId, status: { state: "canceled" } };
  }

  /** artifact 文本校验（类型/大小） */
  static artifactText(task: A2aTask, maxBytes = 64 * 1024): string {
    const texts: string[] = [];
    for (const a of task.artifacts ?? []) {
      for (const p of a.parts) {
        if (p.type === "text" && typeof p.text === "string") {
          if (Buffer.byteLength(p.text, "utf8") > maxBytes) {
            throw new A2aProtocolError("A2A_ARTIFACT_INVALID", `artifact 文本超限 ${maxBytes} 字节`);
          }
          texts.push(p.text);
        } else {
          throw new A2aProtocolError("A2A_ARTIFACT_INVALID", "A2A_ARTIFACT_INVALID: 仅接受 text 类型 artifact");
        }
      }
    }
    return texts.join("\n");
  }
}
