/**
 * read_text：只读工具，限定在 run 专属工作区内。
 * 防护：绝对路径/穿越/符号链接逃逸/大小上限；证据记录真实读取。
 */
import { createHash } from "node:crypto";
import { realpathSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { JsonValue, ToolExecutionContext, ToolHandler, ToolExecutionResult } from "@agentglass/contracts";

export const READ_TEXT_TOOL: ToolHandler = {
  revision: {
    toolId: "read_text",
    revision: "1.0.0",
    title: "读取工作区文本文件",
    description: "读取实验工作区内指定的文本文件（Markdown/CSV/TXT/JSON），返回内容与摘要。不能读取工作区之外的任何文件。",
    riskLevel: "readonly_pure",
    parametersSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区相对路径" },
      },
      required: ["path"],
    },
    idempotent: true,
    supportsStatusQuery: false,
  },
  async execute(args, ctx): Promise<ToolExecutionResult> {
    const parsed = args as { path?: unknown };
    if (typeof parsed.path !== "string" || parsed.path.length === 0) {
      return { status: "failed", reasonCode: "INVALID_ARGUMENTS", errorMessage: "path 必须是非空字符串" };
    }
    const check = resolveInsideWorkspace(ctx.workspaceRoot, parsed.path);
    if (!check.ok) {
      return { status: "denied", reasonCode: "PATH_OUTSIDE_WORKSPACE", errorMessage: check.reason };
    }
    let content: Buffer;
    try {
      const realPath = check.realPath;
      if (!realPath) {
        return { status: "failed", reasonCode: "READ_FAILED", errorMessage: "路径解析失败" };
      }
      statSync(realPath);
      content = readFileSync(realPath);
    } catch (err) {
      return {
        status: "failed",
        reasonCode: "READ_FAILED",
        errorMessage: `读取失败: ${String(err).slice(0, 200)}`,
      };
    }
    if (content.byteLength > ctx.maxOutputBytes) {
      return {
        status: "failed",
        reasonCode: "OUTPUT_TOO_LARGE",
        errorMessage: `文件 ${content.byteLength} 字节超过输出上限 ${ctx.maxOutputBytes}`,
      };
    }
    const text = content.toString("utf8");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const summary: JsonValue = {
      path: parsed.path,
      bytes: content.byteLength,
      lines: text.split(/\r?\n/).length,
      sha256,
      content: text.length > 20_000 ? text.slice(0, 20_000) + "…[TRUNCATED]" : text,
    };
    return { status: "succeeded", outputSummary: summary };
  },
};

export interface WorkspacePathCheck {
  ok: boolean;
  realPath?: string;
  reason?: string;
}

/**
 * 解析工作区相对路径并防止：绝对路径、.. 穿越、符号链接逃逸。
 * 不用字符串前缀判断：先 realpath 工作区，再 realpath 目标后比较前缀。
 */
export function resolveInsideWorkspace(
  workspaceRoot: string,
  requestedPath: string,
): WorkspacePathCheck {
  const rootReal = realpathSync(workspaceRoot);
  if (isAbsolute(requestedPath) && !requestedPath.startsWith(workspaceRoot)) {
    return { ok: false, reason: "绝对路径不允许；请使用工作区相对路径" };
  }
  const joined = resolve(rootReal, requestedPath);
  const rel = relative(rootReal, joined);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, reason: `路径越界: ${requestedPath}` };
  }
  let realPath: string;
  try {
    realPath = realpathSync(joined);
  } catch {
    // 目标不存在：校验其父目录（防止符号链接目录逃逸）
    const parent = resolve(joined, "..");
    try {
      const parentReal = realpathSync(parent);
      if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) {
        return { ok: false, reason: "父目录位于工作区之外（符号链接？）" };
      }
      return { ok: true, realPath: join(parentReal, joined.slice(parent.length + 1)) };
    } catch {
      return { ok: false, reason: "路径不存在" };
    }
  }
  if (realPath !== rootReal && !realPath.startsWith(rootReal + sep)) {
    return { ok: false, reason: "符号链接目标位于工作区之外" };
  }
  return { ok: true, realPath };
}
