/**
 * run_test：受控测试执行器（T25 编码沙箱）。
 * 白名单：仅允许 `node <工作区内单文件>` 形式的执行；进程无秘密环境、
 * 工作目录=工作区、硬超时（SIGKILL）、输出上限、退出码忠实记录。
 * 模型/学生代码不能注入命令参数——只能选择已登记的脚本文件。
 * 依据设计文档 v1.1 §15.4（命令执行风险级别）、L26。
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import type { JsonValue, ToolExecutionContext, ToolExecutionResult, ToolHandler } from "@agentglass/contracts";
import { resolveInsideWorkspace } from "./read-text";

export const RUN_TEST_VERSION = "run-test-1";
const MAX_OUTPUT_BYTES = 64 * 1024;

export const RUN_TEST_TOOL: ToolHandler = {
  revision: {
    toolId: "run_test",
    revision: RUN_TEST_VERSION,
    title: "运行工作区测试",
    description:
      "在沙箱中执行工作区内的测试脚本（node <文件>）。硬超时与输出上限由宿主强制；退出码与输出忠实记录，模型声称的测试通过不改变真实退出码。",
    riskLevel: "command_browser",
    parametersSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "工作区内的测试脚本相对路径（.js/.mjs）" },
      },
      required: ["script"],
    },
    idempotent: true,
    supportsStatusQuery: true,
  },
  async execute(args, ctx): Promise<ToolExecutionResult> {
    const a = args as { script?: unknown };
    if (typeof a.script !== "string" || a.script.length === 0) {
      return { status: "failed", reasonCode: "INVALID_ARGUMENTS", errorMessage: "script 必填" };
    }
    if (!/\.m?js$/.test(a.script)) {
      return { status: "denied", reasonCode: "SCRIPT_NOT_ALLOWED", errorMessage: "只允许执行 .js/.mjs 脚本文件" };
    }
    const check = resolveInsideWorkspace(ctx.workspaceRoot, a.script);
    if (!check.ok || check.realPath == null) {
      return { status: "denied", reasonCode: "PATH_OUTSIDE_WORKSPACE", errorMessage: check.reason ?? "路径非法" };
    }
    const scriptPath = check.realPath;
    if (!existsSync(scriptPath) || !statSync(scriptPath).isFile()) {
      return { status: "failed", reasonCode: "SCRIPT_NOT_FOUND", errorMessage: `脚本不存在: ${a.script}` };
    }
    // 二次确认：realpath 后仍须位于工作区内（防符号链接提前指出的文件）
    const rel = relative(ctx.workspaceRoot, scriptPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return { status: "denied", reasonCode: "PATH_OUTSIDE_WORKSPACE", errorMessage: "解析后越界" };
    }

    const started = Date.now();
    return await new Promise<ToolExecutionResult>((resolve) => {
      const child = spawn(process.execPath, [scriptPath], {
        cwd: ctx.workspaceRoot,
        env: { PATH: process.env.PATH ?? "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let truncated = false;
      const collect = (d: Buffer): void => {
        if (out.length < MAX_OUTPUT_BYTES) out += d.toString("utf8");
        else truncated = true;
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, Math.max(1, new Date(ctx.deadlineAt).getTime() - Date.now()));

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          status: "failed",
          reasonCode: "SPAWN_FAILED",
          errorMessage: String(err).slice(0, 200),
        });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (out.length > MAX_OUTPUT_BYTES) truncated = true;
        const elapsed = Date.now() - started;
        if (timedOut) {
          resolve({
            status: "failed",
            reasonCode: "TEST_TIMEOUT",
            errorMessage: `测试超过宿主时限被终止`,
            outputSummary: { exitCode: null, timedOut: true, elapsedMs: elapsed, outputTail: out.slice(-600) } as JsonValue,
          });
          return;
        }
        const summary: JsonValue = {
          exitCode: code,
          timedOut: false,
          elapsedMs: elapsed,
          output: out.length > 4000 ? out.slice(0, 4000) + "…[TRUNCATED]" : out,
          truncated,
          passed: code === 0,
        };
        resolve({
          status: code === 0 ? "succeeded" : "failed",
          reasonCode: code === 0 ? undefined : "TEST_FAILED",
          outputSummary: summary,
          errorMessage: code === 0 ? undefined : `退出码 ${code}`,
        });
      });
    });
  },
};
