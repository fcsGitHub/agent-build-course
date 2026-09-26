/**
 * 课程扩展点合同（T40 基础）。
 * 学习者修改的函数（如 shouldContinue）通过 LessonExtensionHost 调用；
 * 生产环境为隔离 guest 进程实现（workers/learner-runtime），测试可为进程内实现。
 * 依据设计文档 v1.1 第 9.6/9.8 节：扩展面由 manifest 映射到文件与符号；
 * 适配器能力矩阵中不存在的扩展面拒绝使用。
 */
export interface LoopObservation {
  readonly completedTurns: number;
  readonly hasNewObservation: boolean;
  readonly finalAnswerReady: boolean;
}

export type ExtensionSlotName = "loop_continue";

export interface ExtensionInvocation {
  slot: ExtensionSlotName;
  arg: unknown;
}

export interface ExtensionResult {
  ok: boolean;
  /** 返回值必须可序列化且类型正确；不合法将记录策略错误并终止客体 */
  value?: unknown;
  error?: string;
  /** 客体自述诊断：不可信，仅进入标记为不可信的事件摘要 */
  guestDiagnostic?: string;
}

export interface LessonExtensionHost {
  /** 调用已冻结构建中的具名扩展函数；宿主核验入参出参 */
  call(invocation: ExtensionInvocation): Promise<ExtensionResult>;
  dispose(): Promise<void>;
}

/** 进程内实现：用于单元/集成测试与课程基线（作者=course 的可信构建） */
export class InProcessExtensionHost implements LessonExtensionHost {
  constructor(
    private readonly fns: Partial<Record<ExtensionSlotName, (arg: unknown) => unknown>>,
  ) {}

  async call(invocation: ExtensionInvocation): Promise<ExtensionResult> {
    const fn = this.fns[invocation.slot];
    if (!fn) {
      return { ok: false, error: `EXTENSION_SLOT_NOT_BOUND: ${invocation.slot}` };
    }
    try {
      const value = fn(invocation.arg);
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: String(err).slice(0, 300) };
    }
  }

  async dispose(): Promise<void> {
    /* 进程内无资源 */
  }
}

export const DEFAULT_LOOP_CONTINUE = (obs: unknown): boolean => {
  const o = obs as LoopObservation;
  return o.hasNewObservation && !o.finalAnswerReady && o.completedTurns < 3;
};
