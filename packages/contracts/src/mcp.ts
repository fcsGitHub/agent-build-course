/**
 * MCP 协议合同（T21）。教学子集：stdio transport、initialize 能力协商、
 * tools/resources/prompts 发现与调用。协议版本固定为本次核查的 2025-11-25；
 * 未知能力不声明；transport 教学子集差异见 docs/adr/006。
 */
export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const MCP_SUPPORTED_VERSIONS: readonly string[] = [MCP_PROTOCOL_VERSION];

export const MCP_REQUEST_TIMEOUT_MS = 10_000;

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: { listChanged?: boolean };
    resources?: { listChanged?: boolean };
    prompts?: { listChanged?: boolean };
  };
  serverInfo: McpServerInfo;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface McpResourceDef {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptDef {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpPromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

export interface McpProtocolEvent {
  direction: "out" | "in";
  method?: string;
  kind: "request" | "response" | "notification" | "error";
  /** 脱敏摘要：不携带完整参数/结果，只记方法、id 与字节数 */
  summary: Record<string, unknown>;
  at: string;
}

export class McpProtocolError extends Error {
  constructor(
    public readonly code:
      | "MCP_VERSION_UNSUPPORTED"
      | "MCP_CAPABILITY_UNAVAILABLE"
      | "MCP_TIMEOUT"
      | "MCP_CRASHED"
      | "MCP_PROTOCOL_VIOLATION"
      | "MCP_METHOD_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "McpProtocolError";
  }
}
