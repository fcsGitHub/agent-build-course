/**
 * MCP stdio Client（T21 Host 侧）。
 * - spawn 固定命令启动课程 server（不允许任意 shell 字符串）；
 * - newline-delimited JSON-RPC；initialize 能力协商（版本不符显式失败）；
 * - 每次请求/响应产生脱敏协议事件（凭据与大数据不进事件）；
 * - 请求超时；进程崩溃/提前退出显式报错。
 * 依据设计文档 v1.1 §14.1—§14.3、验收 A12。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { JsonValue } from "@agentglass/contracts";
import {
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_VERSIONS,
  MCP_REQUEST_TIMEOUT_MS,
  McpProtocolError,
  type McpInitializeResult,
  type McpToolDef,
  type McpResourceDef,
  type McpPromptDef,
  type McpPromptMessage,
  type McpProtocolEvent,
} from "@agentglass/contracts";

export type ProtocolEventSink = (event: McpProtocolEvent) => void;

interface Pending {
  resolve: (v: JsonValue) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export interface McpClientOptions {
  serverName: string;
  serverVersion?: string;
  onProtocolEvent?: ProtocolEventSink;
  requestTimeoutMs?: number;
}

export class McpClient {
  private child: ChildProcess | null = null;
  private pending = new Map<string, Pending>();
  private buffer = "";
  private connected = false;
  private capabilities: McpInitializeResult["capabilities"] | null = null;
  private capabilitiesVersion: string | null = null;
  private capabilitiesServerInfo: McpInitializeResult["serverInfo"] | null = null;
  private closedByUs = false;

  constructor(private readonly options: McpClientOptions) {}

  private emitProtocol(e: McpProtocolEvent): void {
    this.options.onProtocolEvent?.(e);
  }

  private emit(direction: "out" | "in", kind: McpProtocolEvent["kind"], method: string | undefined, bytes: number): void {
    this.emitProtocol({
      direction,
      kind,
      method,
      summary: { server: this.options.serverName, bytes },
      at: new Date().toISOString(),
    });
  }

  /** 固定命令启动：execPath + server 脚本 + 参数；环境仅保留 PATH（无秘密）。 */
  async connect(serverScriptPath: string, args: string[] = []): Promise<McpInitializeResult> {
    if (this.child) throw new Error("MCP_ALREADY_CONNECTED");
    // 直接以 node 运行纯 .mjs server；env 仅含 PATH（无秘密、无继承的 loader 参数）
    const child = spawn(process.execPath, [serverScriptPath, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "" },
    });
    this.child = child;
    let stderrTail = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-500);
    });
    child.on("exit", (code) => {
      const pending = [...this.pending.values()];
      this.pending.clear();
      for (const p of pending) {
        clearTimeout(p.timer);
        p.reject(new McpProtocolError("MCP_CRASHED", `server 退出（code=${code}）${stderrTail}`));
      }
      if (!this.closedByUs) {
        this.connected = false;
      }
    });

    // 行解析
    child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line.length === 0) continue;
        this.handleLine(line);
      }
    });

    const init = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      clientInfo: { name: "agentglass-host", version: "0.1.0" },
    });
    const result = init as unknown as McpInitializeResult;
    if (!MCP_SUPPORTED_VERSIONS.includes(result.protocolVersion)) {
      throw new McpProtocolError(
        "MCP_VERSION_UNSUPPORTED",
        `server 协议版本 ${result.protocolVersion} 不在支持列表 ${MCP_SUPPORTED_VERSIONS.join("/")}`,
      );
    }
    this.capabilities = result.capabilities;
    this.capabilitiesVersion = result.protocolVersion;
    this.capabilitiesServerInfo = result.serverInfo;
    this.connected = true;
    // initialized 通知
    this.notify("notifications/initialized", {});
    this.emit("in", "response", "initialize", JSON.stringify(result).length);
    return result;
  }

  private handleLine(line: string): void {
    let msg: {
      id?: string | number;
      method?: string;
      result?: JsonValue;
      error?: { code?: number; message?: string };
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 非 JSON 行忽略（server 日志混入时容忍）
    }
    const bytes = line.length;
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(String(msg.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(String(msg.id));
      if (msg.error) {
        this.emit("in", "error", pending.method, bytes);
        pending.reject(new McpProtocolError("MCP_PROTOCOL_VIOLATION", `${pending.method} 失败: ${msg.error.message ?? ""}`));
      } else {
        this.emit("in", "response", pending.method, bytes);
        pending.resolve(msg.result ?? null);
      }
      return;
    }
    if (msg.method) {
      // server → client 请求/通知：教学子集不实现 sampling/roots；仅记录
      this.emit("in", msg.id != null ? "request" : "notification", msg.method, bytes);
    }
  }

  private sendRaw(obj: unknown): void {
    if (!this.child?.stdin?.writable) throw new McpProtocolError("MCP_CRASHED", "server stdin 已关闭");
    const line = JSON.stringify(obj);
    this.emit("out", "request", (obj as { method?: string }).method, line.length);
    this.child.stdin.write(line + "\n");
  }

  request(method: string, params?: JsonValue): Promise<JsonValue> {
    if (!this.child) throw new McpProtocolError("MCP_CRASHED", "尚未连接");
    const id = `req_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const timeoutMs = this.options.requestTimeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpProtocolError("MCP_TIMEOUT", `${method} 超过 ${timeoutMs}ms 无响应`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.sendRaw({ jsonrpc: "2.0", id, method, params: params ?? {} });
    });
  }

  notify(method: string, params?: JsonValue): void {
    this.sendRaw({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  requireCapability<T>(cap: T | undefined, name: string): T {
    if (cap == null) throw new McpProtocolError("MCP_CAPABILITY_UNAVAILABLE", `server 未声明能力: ${name}`);
    return cap;
  }

  async listTools(): Promise<McpToolDef[]> {
    if (!this.capabilities?.tools) throw new McpProtocolError("MCP_CAPABILITY_UNAVAILABLE", "tools");
    const r = (await this.request("tools/list", {})) as { tools?: McpToolDef[] };
    return r.tools ?? [];
  }

  async callTool(name: string, args: Record<string, JsonValue>): Promise<unknown> {
    this.requireCapability(this.capabilities?.tools, "tools");
    const r = (await this.request("tools/call", { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    if (r.isError) {
      throw new McpProtocolError("MCP_PROTOCOL_VIOLATION", r.content?.map((c) => c.text ?? "").join("; ") || "tool error");
    }
    const text = (r.content ?? []).map((c) => c.text ?? "").join("\n");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async listResources(): Promise<McpResourceDef[]> {
    this.requireCapability(this.capabilities?.resources, "resources");
    const r = (await this.request("resources/list", {})) as { resources?: McpResourceDef[] };
    return r.resources ?? [];
  }

  async readResource(uri: string): Promise<{ uri: string; text: string; mimeType?: string }> {
    this.requireCapability(this.capabilities?.resources, "resources");
    const r = (await this.request("resources/read", { uri })) as {
      contents?: Array<{ uri: string; text?: string; mimeType?: string }>;
    };
    const c = r.contents?.[0];
    if (!c) throw new McpProtocolError("MCP_PROTOCOL_VIOLATION", "resources/read 无内容");
    return { uri: c.uri, text: c.text ?? "", mimeType: c.mimeType };
  }

  async listPrompts(): Promise<McpPromptDef[]> {
    this.requireCapability(this.capabilities?.prompts, "prompts");
    const r = (await this.request("prompts/list", {})) as { prompts?: McpPromptDef[] };
    return r.prompts ?? [];
  }

  async getPrompt(name: string, args: Record<string, string> = {}): Promise<McpPromptMessage[]> {
    this.requireCapability(this.capabilities?.prompts, "prompts");
    const r = (await this.request("prompts/get", { name, arguments: args })) as {
      messages?: McpPromptMessage[];
    };
    return r.messages ?? [];
  }

  /** 读取协议事件快照（由测试/宿主记录） */
  get connectedServer(): { protocolVersion: string; serverInfo: { name: string; version: string }; capabilities: McpInitializeResult["capabilities"] } | null {
    return this.capabilities
      ? {
          protocolVersion: (this.capabilitiesVersion ?? MCP_PROTOCOL_VERSION),
          serverInfo: this.capabilitiesServerInfo ?? { name: "unknown", version: "" },
          capabilities: this.capabilities,
        }
      : null;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode == null) {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 1000);
      child.once("exit", () => clearTimeout(force));
    }
  }
}
