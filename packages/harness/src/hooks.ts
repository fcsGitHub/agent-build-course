/**
 * Harness hook 与长期任务状态（T23）。
 * 固定阶段：before_context/after_context/before_model/after_model/before_tool/after_tool/before_checkpoint/after_run；
 * hook 声明：是否允许修改、最大耗时、失败策略（continue/fail）；
 * 修改上下文的 hook 必须产出 diff 摘要（由调用方落事件 hook.diff）；
 * 安全类核心（授权/预算）不经过 hook，不可被插件关闭。
 * 依据设计文档 v1.1 §15.2。
 */
export type HookStage =
  | "before_context"
  | "after_context"
  | "before_model"
  | "after_model"
  | "before_tool"
  | "after_tool"
  | "before_checkpoint"
  | "after_run";

export interface HookDecl {
  id: string;
  stages: HookStage[];
  /** 是否允许修改数据（false = 只读观察） */
  mutating: boolean;
  timeoutMs: number;
  /** fail：抛错终止运行；continue：记录后跳过 */
  failurePolicy: "continue" | "fail";
}

export interface HookContext {
  runId: string;
  stage: HookStage;
  /** 阶段载荷（按阶段语义由调用方构造；可序列化） */
  data: Record<string, unknown>;
}

export interface HookResult {
  /** mutating hook 的修改结果（新数据 + diff 摘要） */
  modified?: Record<string, unknown>;
  diff?: string;
  note?: string;
}

export type HookImpl = (ctx: HookContext) => HookResult | Promise<HookResult>;

export interface RegisteredHook {
  decl: HookDecl;
  impl: HookImpl;
}

export class HookRegistry {
  private hooks: RegisteredHook[] = [];

  register(decl: HookDecl, impl: HookImpl): void {
    if (this.hooks.some((h) => h.decl.id === decl.id)) {
      throw new Error(`HOOK_ALREADY_REGISTERED: ${decl.id}`);
    }
    this.hooks.push({ decl, impl });
  }

  list(): HookDecl[] {
    return this.hooks.map((h) => h.decl);
  }

  hooksFor(stage: HookStage): RegisteredHook[] {
    return this.hooks.filter((h) => h.decl.stages.includes(stage));
  }

  /**
   * 执行某阶段全部 hook：按注册顺序、带超时；失败按声明策略处理。
   * 返回（可能被修改的）数据 + diff 摘要列表；安全关键调用方（授权/预算）不在此管道内。
   */
  async runStage(
    stage: HookStage,
    base: HookContext,
  ): Promise<{ data: Record<string, unknown>; diffs: Array<{ hookId: string; diff: string }>; failures: Array<{ hookId: string; error: string }> }> {
    let data = base.data;
    const diffs: Array<{ hookId: string; diff: string }> = [];
    const failures: Array<{ hookId: string; error: string }> = [];
    for (const hook of this.hooksFor(stage)) {
      const started = Date.now();
      try {
        const result = await Promise.race([
          hook.impl({ ...base, stage, data }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`HOOK_TIMEOUT: ${hook.decl.timeoutMs}ms`)), hook.decl.timeoutMs),
          ),
        ]);
        if (hook.decl.mutating && result?.modified) {
          diffs.push({
            hookId: hook.decl.id,
            diff: result.diff ?? describeDiff(data, result.modified),
          });
          data = result.modified;
        }
      } catch (err) {
        const message = String(err).slice(0, 200);
        failures.push({ hookId: hook.decl.id, error: message });
        if (hook.decl.failurePolicy === "fail") {
          throw new Error(`HOOK_FAILED: ${hook.decl.id}: ${message}（耗时 ${Date.now() - started}ms）`);
        }
      }
    }
    return { data, diffs, failures };
  }
}

function describeDiff(before: Record<string, unknown>, after: Record<string, unknown>): string {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const k of keys) {
    const a = JSON.stringify(before[k]);
    const b = JSON.stringify(after[k]);
    if (a !== b) changed.push(`${k}: ${truncate(a ?? "undefined", 40)} → ${truncate(b ?? "undefined", 60)}`);
  }
  return changed.join("; ") || "no-op";
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ---- 内置教学 hooks（声明式注册；平台拥有，非任意用户代码） ----

/** before_tool：为每次工具调用附加审计标记（只读观察） */
export const toolAuditHook: { decl: HookDecl; impl: HookImpl } = {
  decl: {
    id: "builtin.tool-audit",
    stages: ["before_tool"],
    mutating: false,
    timeoutMs: 500,
    failurePolicy: "continue",
  },
  impl: (ctx) => {
    void ctx;
    return { note: "tool call audited" };
  },
};

/** after_model：教学标注 hook——在模型输出后附加提示行（mutating，产生 diff） */
export const teachingAnnotationHook: { decl: HookDecl; impl: HookImpl } = {
  decl: {
    id: "builtin.teaching-annotation",
    stages: ["after_model"],
    mutating: true,
    timeoutMs: 500,
    failurePolicy: "continue",
  },
  impl: (ctx) => {
    const text = String(ctx.data.messageText ?? "");
    return {
      modified: {
        ...ctx.data,
        messageText: text + "\n\n[教学标注：以上内容来自模型输出，事件账本中的证据为准]",
      },
      diff: "messageText: 追加教学标注行（+1 行）",
    };
  },
};
