/**
 * T22：远程 MCP HTTP transport（streamable HTTP 子集）。
 * - POST JSON-RPC 到 endpoint；MCP-Protocol-Version 头固定 2025-11-25；
 * - 授权：Bearer（secretRef→env）；401 → AUTH_EXPIRED（显式，不静默重试）；
 * - endpoint 出站前过 SSRF 校验（公网/白名单）；
 * - 协议事件脱敏记录（同 stdio client）。
 * 依据设计文档 v1.1 §14.1—§14.3。
 */
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
import { assertPublicUrl, isPrivateIp, SSRFError } from "./ssrf";

type ProtocolEventSink = (e: McpProtocolEvent) => void;

export interface McpHttpOptions {
  endpoint: string;
  bearerEnvVar?: string;
  onProtocolEvent?: ProtocolEventSink;
  requestTimeoutMs?: number;
  /** 额外域名白名单（http_fetch 用；remote MCP 自身走 assertPublicUrl） */
  allowedHosts?: string[];
  /** 受控教学环境显式放开私网地址（本地实验 server）；默认拒绝。多人部署必须保持 false */
  allowPrivateNetwork?: boolean;
}

interface RemoteCapabilities {
  protocolVersion: string;
  capabilities: McpInitializeResult["capabilities"];
  serverInfo: McpInitializeResult["serverInfo"];
  authorizedAt: string;
  /** 授权会话 ID（server 返回 Mcp-Session-Id 时保存；过期后 401 → AUTH_EXPIRED） */
  sessionId: string | null;
}

export class McpHttpClient {
  private caps: RemoteCapabilities | null = null;
  private authFailedAt: string | null = null;
  private lastSessionId: string | null = null;

  constructor(private readonly options: McpHttpOptions) {}

  private endpointUrl(): URL {
    // allowPrivateNetwork=true（受控教学环境显式声明）仅放宽私网地址检查，仍要求 http(s)
    if (this.options.allowPrivateNetwork === true) {
      const url = new URL(this.options.endpoint);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new SSRFError("SSRF_SCHEME", `仅允许 http(s): ${url.protocol}`);
      }
      return url;
    }
    return assertPublicUrl(this.options.endpoint);
  }

  private bearer(): string | undefined {
    const v = this.options.bearerEnvVar ? process.env[this.options.bearerEnvVar] : undefined;
    return v && v.length > 0 ? v : undefined;
  }

  private emit(direction: "out" | "in", kind: McpProtocolEvent["kind"], method: string | undefined, bytes: number): void {
    this.options.onProtocolEvent?.({
      direction,
      kind,
      method,
      summary: { server: this.options.endpoint, bytes },
      at: new Date().toISOString(),
    });
  }

  private async post(method: string, params: JsonValue | undefined, notify = false): Promise<JsonValue | undefined> {
    const url = this.endpointUrl(); // SSRF 校验（每次出站）
    const id = `req_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const body: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (!notify) {
      body.id = id;
      if (params !== undefined) body.params = params;
    }
    const payload = JSON.stringify(notify ? { jsonrpc: "2.0", method, params: params ?? {} } : body);
    this.emit("out", notify ? "notification" : "request", method, payload.length);

    const bearer = this.bearer();
    const timeoutMs = this.options.requestTimeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
          ...(this.caps?.sessionId ? { "mcp-session-id": this.caps.sessionId } : {}),
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: payload,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted) throw new McpProtocolError("MCP_TIMEOUT", `${method} 超过 ${timeoutMs}ms`);
      throw new McpProtocolError("MCP_CRASHED", String(err).slice(0, 200));
    }
    clearTimeout(timer);

    if (res.status === 401 || res.status === 403) {
      this.authFailedAt = new Date().toISOString();
      throw new McpProtocolError(
        "MCP_PROTOCOL_VIOLATION",
        `授权失败（HTTP ${res.status}）：令牌缺失/过期/被撤销；需重新授权后重连`,
      );
    }
    if (!res.ok) {
      throw new McpProtocolError("MCP_PROTOCOL_VIOLATION", `HTTP_${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
    }
    const sessionId = res.headers.get("mcp-session-id");
    if (sessionId) {
      this.lastSessionId = sessionId;
      if (this.caps) this.caps.sessionId = sessionId;
    }

    if (notify) {
      this.emit("in", "response", method, 0);
      return undefined;
    }
    const text = await res.text();
    this.emit("in", "response", method, text.length);
    // streamable HTTP 可能返回 SSE 帧；教学子集取首个 data: 行或纯 JSON
    let jsonText = text;
    if (text.startsWith("event:") || text.startsWith("data:")) {
      const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
      jsonText = dataLine?.slice(5).trim() ?? "{}";
    }
    let msg: { id?: string; result?: JsonValue; error?: { message?: string } };
    try {
      msg = JSON.parse(jsonText);
    } catch {
      throw new McpProtocolError("MCP_PROTOCOL_VIOLATION", "响应不是合法 JSON");
    }
    if (msg.error) {
      throw new McpProtocolError("MCP_PROTOCOL_VIOLATION", `${method}: ${msg.error.message ?? ""}`);
    }
    return msg.result ?? null;
  }

  /** 连接 = initialize 协商（可选 Bearer 授权；401 → AUTH_EXPIRED 语义） */
  async connect(): Promise<RemoteCapabilities> {
    const result = (await this.post("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      clientInfo: { name: "agentglass-host", version: "0.1.0" },
    })) as unknown as McpInitializeResult;
    if (!MCP_SUPPORTED_VERSIONS.includes(result.protocolVersion)) {
      throw new McpProtocolError(
        "MCP_VERSION_UNSUPPORTED",
        `server 协议版本 ${result.protocolVersion} 不在支持列表`,
      );
    }
    this.caps = {
      protocolVersion: result.protocolVersion,
      capabilities: result.capabilities,
      serverInfo: result.serverInfo,
      authorizedAt: new Date().toISOString(),
      sessionId: this.lastSessionId,
    };
    await this.post("notifications/initialized", {}, true);
    return this.caps;
  }

  /** 授权过期语义：401 后 isAuthorized=false 且 authFailedAt 记录；需重新 connect */
  get isAuthorized(): boolean {
    return this.authFailedAt == null;
  }

  get authorizationFailedAt(): string | null {
    return this.authFailedAt;
  }

  get capabilities(): RemoteCapabilities | null {
    return this.caps;
  }

  async listTools(): Promise<McpToolDef[]> {
    if (!this.caps?.capabilities.tools) throw new McpProtocolError("MCP_CAPABILITY_UNAVAILABLE", "tools");
    const r = (await this.post("tools/list", {})) as { tools?: McpToolDef[] };
    return r.tools ?? [];
  }

  async callTool(name: string, args: Record<string, JsonValue>): Promise<unknown> {
    const r = (await this.post("tools/call", { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    if (r.isError) throw new McpProtocolError("MCP_PROTOCOL_VIOLATION", "tool error");
    const text = (r.content ?? []).map((c) => c.text ?? "").join("\n");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async listResources(): Promise<McpResourceDef[]> {
    if (!this.caps?.capabilities.resources) throw new McpProtocolError("MCP_CAPABILITY_UNAVAILABLE", "resources");
    const r = (await this.post("resources/list", {})) as { resources?: McpResourceDef[] };
    return r.resources ?? [];
  }

  async listPrompts(): Promise<McpPromptDef[]> {
    if (!this.caps?.capabilities.prompts) throw new McpProtocolError("MCP_CAPABILITY_UNAVAILABLE", "prompts");
    const r = (await this.post("prompts/list", {})) as { prompts?: McpPromptDef[] };
    return r.prompts ?? [];
  }

  async getPrompt(name: string, args: Record<string, string> = {}): Promise<McpPromptMessage[]> {
    const r = (await this.post("prompts/get", { name, arguments: args })) as { messages?: McpPromptMessage[] };
    return r.messages ?? [];
  }

  get capabilitiesSnapshot(): RemoteCapabilities | null {
    return this.caps;
  }
}
