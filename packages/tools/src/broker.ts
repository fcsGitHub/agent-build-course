/**
 * 工具代理（T05）。模型工具请求 → 参数校验 → 权限/白名单 → 受控执行。
 * 依据设计文档 v1.1 第 5.1/8.1/18.5 节：模型"调用工具"只是请求；
 * 只有代理执行后才产生副作用与结果工件。
 */
import type {
  JsonValue,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolHandler,
  ToolInvocation,
} from "@agentglass/contracts";
import type { EffectLedger } from "./effect-ledger";
import { validateAgainstSchema } from "./schema-validate";

export class ToolBroker {
  constructor(
    private readonly handlers: Map<string, ToolHandler>,
    private readonly effects: EffectLedger,
  ) {}

  static fromRegistry(
    handlers: ToolHandler[],
    effects: EffectLedger,
  ): ToolBroker {
    return new ToolBroker(new Map(handlers.map((h) => [h.revision.toolId, h])), effects);
  }

  /** 允许集合 = 远端发现 ∩ 课程白名单 ∩ 用户权限（由 ctx.allowedToolIds 传入） */
  async execute(
    invocation: Omit<ToolInvocation, "idempotencyKey"> & { idempotencyKey?: string },
  ): Promise<ToolExecutionResult> {
    const { toolId, args, ctx } = invocation;
    const idempotencyKey = invocation.idempotencyKey ?? `${ctx.runId}:${toolId}:${stableKey(args)}`;

    // 1) 已注册？
    const handler = this.handlers.get(toolId);
    if (!handler) {
      return { status: "denied", reasonCode: "TOOL_NOT_REGISTERED", errorMessage: `工具未注册: ${toolId}` };
    }
    // 2) 本次运行允许？
    if (!ctx.allowedToolIds.includes(toolId)) {
      return {
        status: "denied",
        reasonCode: "TOOL_NOT_ALLOWED",
        errorMessage: `当前运行未授权工具: ${toolId}（工具描述不能自授权限）`,
      };
    }
    // 3) 参数 schema 校验
    const schemaCheck = validateAgainstSchema(args, handler.revision.parametersSchema);
    if (!schemaCheck.valid) {
      return {
        status: "failed",
        reasonCode: "INVALID_TOOL_ARGUMENTS",
        errorMessage: schemaCheck.errors.join("; "),
      };
    }
    // 4) 副作用账本：prepared → dispatched → 终态
    const intentId = this.effects.prepare({
      runId: ctx.runId,
      idempotencyKey,
      toolRevision: `${toolId}@${handler.revision.revision}`,
      argsDigest: stableKey(args),
    });
    const deadline = new Date(ctx.deadlineAt).getTime();
    if (Date.now() > deadline) {
      this.effects.mark(intentId, "failed", "WALL_TIME_EXCEEDED");
      return { status: "failed", reasonCode: "WALL_TIME_EXCEEDED", errorMessage: "运行已超时，未派发工具" };
    }
    this.effects.dispatch(intentId);
    try {
      const result = await withTimeout(
        handler.execute(args as JsonValue, ctx),
        Math.max(1, deadline - Date.now()),
        `${toolId} 执行超时`,
      );
      if (result.status === "succeeded") {
        this.effects.mark(intentId, "succeeded");
      } else {
        this.effects.mark(intentId, "failed", result.reasonCode ?? "TOOL_FAILED");
      }
      return result;
    } catch (err) {
      const message = String(err).slice(0, 300);
      // 超时被取消时外部可能已执行：保守标记 unknown，进入核对路径
      if (message.includes("TIMEOUT")) {
        this.effects.markUnknown(intentId, "工具执行超时，外部结果未知");
        return { status: "failed", reasonCode: "EFFECT_UNKNOWN", errorMessage: message };
      }
      this.effects.mark(intentId, "failed", "TOOL_EXCEPTION", message);
      return { status: "failed", reasonCode: "TOOL_EXCEPTION", errorMessage: message };
    }
  }
}

function stableKey(args: unknown): string {
  return JSON.stringify(args, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return v;
  });
}

async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT: ${message}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
