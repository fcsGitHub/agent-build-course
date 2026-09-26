/**
 * 控制门（T06）。运行在任何安全边界（before_model/before_tool/turn_end）响应控制命令。
 * 语义（§18.3）：暂停 = 在下一个安全边界驻留等待恢复（不发 pause 给网络调用中的模型）；
 * 取消 = 尽快终止；崩溃/超时由外部 watchdog 通过 AbortSignal 处理。
 * 断点扩展：命令状态携带断点目标集合；目标为边界名（before_model 等）或
 * `node:<graphNodeId>`（状态图课程按节点断点）。命中即驻留，语义与手动暂停一致。
 * 放行判定：resumeEpoch 推进（每次 resume 命令递增）且无新的手动暂停 —— 驻留期间
 * run 状态已被置为 paused（不再是 pause_requested），不能依赖 pauseRequested 回落放行。
 * 断点在一次命中放行后保持 armed：下一次到达同一目标会再次命中（调试器语义）。
 */
export interface ControlCommandState {
  pauseRequested: boolean;
  cancelRequested: boolean;
  /** 断点目标：边界名（before_model/before_tool/after_tool/turn_end）或 node:<id> */
  breakpoints?: readonly string[];
  /** 恢复读数：每次 resume 命令递增（未提供时退化为 pauseRequested 回落放行） */
  resumeEpoch?: number;
}

export type BoundaryName = "before_model" | "before_tool" | "after_tool" | "turn_end";

export type PauseReason = "pause" | "breakpoint";

export class CancelledError extends Error {
  constructor() {
    super("CANCELLED");
    this.name = "CancelledError";
  }
}

export interface ControlGateEvents {
  onPaused?: (boundary: BoundaryName, reason: PauseReason, at?: string) => void;
  onResumed?: (boundary: BoundaryName, at?: string) => void;
}

export class ControlGate {
  constructor(
    private readonly poll: () => ControlCommandState,
    private readonly hooks: ControlGateEvents = {},
    private readonly pollIntervalMs = 200,
  ) {}

  /**
   * 在边界处检查控制命令（异步：暂停/断点命中时驻留等待）。
   * cancel 优先于 pause 与断点。`at` 为可选的图节点定位（node:<id> 断点用）。
   * 驻留只发射一次 onPaused；resumeEpoch 推进（或非 epoch 模式下暂停解除）后放行。
   * `ignoreBreakpoints`：该边界只响应手动暂停/取消（用于循环顶安全边界——
   * turn_end 断点的语义是「每轮结束后」，循环顶部同名边界不应命中断点，否则
   * 第 0 轮（尚未执行任何回合）与每轮结束后都会重复驻留）。
   */
  async reach(boundary: BoundaryName, at?: string, opts?: { ignoreBreakpoints?: boolean }): Promise<void> {
    let dwelled = false;
    let dwellEpoch: number | null = null;
    for (;;) {
      const cmd = this.poll();
      if (cmd.cancelRequested) throw new CancelledError();
      if (!dwelled) {
        const hit = opts?.ignoreBreakpoints ? null : breakpointHit(cmd, boundary, at);
        if (cmd.pauseRequested || hit != null) {
          dwelled = true;
          dwellEpoch = cmd.resumeEpoch ?? null;
          this.hooks.onPaused?.(boundary, cmd.pauseRequested ? "pause" : hit!, at);
        } else {
          return;
        }
      } else {
        const epochAdvanced = dwellEpoch == null ? true : (cmd.resumeEpoch ?? 0) > dwellEpoch;
        if (epochAdvanced && !cmd.pauseRequested) {
          this.hooks.onResumed?.(boundary, at);
          return;
        }
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  static fromSignal(
    signal: AbortSignal,
    poll: () => ControlCommandState,
    hooks: ControlGateEvents = {},
  ): ControlGate {
    return new ControlGate(() => {
      if (signal.aborted) return { pauseRequested: false, cancelRequested: true };
      return poll();
    }, hooks);
  }
}

function breakpointHit(
  cmd: ControlCommandState,
  boundary: BoundaryName,
  at?: string,
): PauseReason | null {
  if (cmd.breakpoints == null || cmd.breakpoints.length === 0) return null;
  if (at != null && cmd.breakpoints.includes(`node:${at}`)) return "breakpoint";
  if (cmd.breakpoints.includes(boundary)) return "breakpoint";
  return null;
}
