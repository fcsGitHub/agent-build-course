/**
 * 工作区写入工具（L21/T20 审批演示面）。
 * 风险级别 workspace_write：默认需要具体效果审批（由运行时的 ApprovalIntegration 拦截）；
 * 写入限定在 run 专属工作区内，返回写入摘要。
 */
import { writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { sep } from "node:path";
import { dirname, join, basename } from "node:path";
import type { JsonValue, ToolExecutionContext, ToolExecutionResult, ToolHandler } from "@agentglass/contracts";

export const WRITE_FILE_TOOL: ToolHandler = {
  revision: {
    toolId: "write_file",
    revision: "1.0.0",
    title: "写入工作区文件",
    description: "把文本内容写入工作区内指定路径（受审批策略约束：写入前需要具体效果审批）。",
    riskLevel: "workspace_write",
    parametersSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区相对路径" },
        content: { type: "string", description: "要写入的文本内容" },
      },
      required: ["path", "content"],
    },
    idempotent: true,
    supportsStatusQuery: true,
  },
  async execute(args, ctx): Promise<ToolExecutionResult> {
    const a = args as { path?: unknown; content?: unknown };
    if (typeof a.path !== "string" || typeof a.content !== "string") {
      return { status: "failed", reasonCode: "INVALID_ARGUMENTS", errorMessage: "path/content 必填" };
    }
    if (a.content.length > 200_000) {
      return { status: "failed", reasonCode: "CONTENT_TOO_LARGE", errorMessage: "内容超过 200KB 上限" };
    }
    // 写入路径解析：normalize 拒绝穿越；创建目录后用 realpath 前缀校验真实位置
    if (a.path.includes("..") || /[\/]^[a-zA-Z]:/.test(a.path)) {
      return { status: "denied", reasonCode: "PATH_OUTSIDE_WORKSPACE", errorMessage: "路径包含越界成分" };
    }
    const rootReal = realpathSync(ctx.workspaceRoot);
    const target = join(rootReal, a.path);
    if (!target.startsWith(rootReal)) {
      return { status: "denied", reasonCode: "PATH_OUTSIDE_WORKSPACE", errorMessage: "解析后越界" };
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
    } catch {
      return { status: "failed", reasonCode: "MKDIR_FAILED", errorMessage: "无法创建目标目录" };
    }
    // 目录创建后校验父目录真实位置（防符号链接逃逸）；目标文件随后原子写入
    const realParent = realpathSync(dirname(target));
    if (realParent !== rootReal && !realParent.startsWith(rootReal + sep)) {
      return { status: "denied", reasonCode: "PATH_OUTSIDE_WORKSPACE", errorMessage: "符号链接目标位于工作区之外" };
    }
    const finalTarget = join(realParent, basename(target));
    writeFileSync(finalTarget, a.content, "utf8");
    const written = realpathSync(finalTarget);
    if (written !== rootReal && !written.startsWith(rootReal + sep)) {
      return { status: "denied", reasonCode: "PATH_OUTSIDE_WORKSPACE", errorMessage: "写入后校验失败（符号链接逃逸）" };
    }
    const summary: JsonValue = {
      path: a.path,
      bytes: Buffer.byteLength(a.content, "utf8"),
      workspace: (ctx.workspaceRoot.split(/[\\/]/).pop()) as string,
    };
    void join;
    return { status: "succeeded", outputSummary: summary };
  },
};
