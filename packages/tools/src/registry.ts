/**
 * 工具注册表（T05）。工具能力注册、版本与 schema 由平台拥有；
 * 模型/学生代码不能通过描述自授权限。
 */
import type { ToolHandler, ToolRevision } from "@agentglass/contracts";

export class ToolRegistry {
  private handlers = new Map<string, ToolHandler>();

  register(handler: ToolHandler): void {
    if (this.handlers.has(handler.revision.toolId)) {
      throw new Error(`TOOL_ALREADY_REGISTERED: ${handler.revision.toolId}`);
    }
    this.handlers.set(handler.revision.toolId, handler);
  }

  get(toolId: string): ToolHandler | undefined {
    return this.handlers.get(toolId);
  }

  getRevision(toolId: string): ToolRevision | undefined {
    return this.handlers.get(toolId)?.revision;
  }

  list(): ToolRevision[] {
    return [...this.handlers.values()].map((h) => h.revision);
  }
}
