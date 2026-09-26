/**
 * MCP → AgentGlass 工具映射（T21）。
 * server 发现的工具映射为 ToolHandler（toolId = mcp_<server>_<tool>）；
 * 权限仍由 ToolBroker 白名单决定——工具描述（含注入文本）不改变宿主策略。
 */
import type { JsonValue, ToolExecutionContext, ToolExecutionResult, ToolHandler } from "@agentglass/contracts";
import type { McpClient } from "@agentglass/mcp";
import type { McpToolDef } from "@agentglass/contracts";

export function mcpToolHandlers(
  client: McpClient,
  tools: McpToolDef[],
  serverId: string,
): ToolHandler[] {
  return tools.map((t) => ({
    revision: {
      toolId: `mcp_${serverId}_${t.name}`,
      revision: "1.0.0",
      title: `[MCP:${serverId}] ${t.name}`,
      /** 描述原样展示（教学：注入文本可见），但绝不因此改变权限 */
      description: t.description ?? "",
      riskLevel: "readonly_pure",
      parametersSchema: t.inputSchema as JsonValue,
      idempotent: true,
      supportsStatusQuery: false,
    },
    async execute(args, _ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
      void _ctx;
      try {
        const out = await client.callTool(t.name, args as Record<string, JsonValue>);
        return { status: "succeeded", outputSummary: out as JsonValue };
      } catch (err) {
        return { status: "failed", reasonCode: "MCP_TOOL_FAILED", errorMessage: String(err).slice(0, 200) };
      }
    },
  }));
}

/** 协议事件 → 事件账本摘要（脱敏：只记方向/方法/字节数） */
export function protocolEventSummary(e: {
  direction: string;
  kind: string;
  method?: string;
  summary: Record<string, unknown>;
}): import("@agentglass/contracts").JsonValue {
  return {
    dir: e.direction,
    kind: e.kind,
    method: e.method ?? null,
    server: (e.summary.server ?? null) as import("@agentglass/contracts").JsonValue,
    bytes: (e.summary.bytes ?? null) as import("@agentglass/contracts").JsonValue,
  };
}
