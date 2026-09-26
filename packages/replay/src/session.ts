/**
 * 回放会话（T10）。回放不执行：只读取已有事件与工件，经同一 reducer 重建状态。
 * 支持播放/暂停、逐事件、跳转到最终状态。拖动只改变选中事件。
 * 依据设计文档 v1.1 第 18.1/18.2/18.3 节。
 */
import type { TraceEvent } from "@agentglass/contracts";
import {
  initialProjection,
  reduceTrace,
  type ProjectionState,
} from "@agentglass/projections";

export class ReplaySession {
  private events: TraceEvent[];
  private snapshots: ProjectionState[] = [];

  constructor(
    events: TraceEvent[],
    private readonly mode: "replay" = "replay",
  ) {
    // 按 seq 升序重放（快照加速跳转；原始账本仍是权威来源）
    this.events = [...events].sort((a, b) => a.seq - b.seq);
    let state = initialProjection(this.events[0]?.runId ?? "");
    this.snapshots.push(state);
    for (const e of this.events) {
      state = reduceTrace(state, e);
      this.snapshots.push(state);
    }
    void this.mode;
  }

  get totalEvents(): number {
    return this.events.length;
  }

  stateAt(seq: number): { state: ProjectionState; event?: TraceEvent } {
    const idx = Math.max(0, Math.min(seq, this.events.length));
    return { state: this.snapshots[idx]!, event: this.events[idx - 1] };
  }

  finalState(): ProjectionState {
    return this.snapshots.at(-1) ?? initialProjection();
  }

  eventAt(seq: number): TraceEvent | undefined {
    return this.events[seq - 1];
  }

  /** 按类型跳转目标（跳到错误/上下文变化） */
  findNext(pred: (e: TraceEvent) => boolean, afterSeq: number): TraceEvent | undefined {
    return this.events.find((e) => e.seq > afterSeq && pred(e));
  }

  get manifest(): { schemaVersion: 1; replayOnly: true; eventCount: number } {
    return { schemaVersion: 1, replayOnly: true, eventCount: this.events.length };
  }
}
