/**
 * 单元测试：控制门断点与驻留放行语义（§18.3/§18.4）。
 * - 命中即在边界驻留，onPaused 只发射一次（reason=breakpoint）
 * - 驻留期间 pauseRequested 已回落（协调器把 run 置为 paused）：只有 resumeEpoch
 *   推进才放行；断点保持 armed，下一次到达再次命中（调试器语义）
 * - node:<id> 断点只匹配对应图节点；手动暂停优先；cancel 最优先
 * - 未提供 resumeEpoch 的旧式 poll：退化为 pauseRequested 回落放行（向后兼容）
 */
import { describe, expect, it } from "vitest";
import { CancelledError, ControlGate, type ControlCommandState } from "@agentglass/runtime-reference";

interface Harness {
  state: ControlCommandState;
  paused: Array<{ boundary: string; reason: string; at?: string }>;
  resumed: number;
  gate: ControlGate;
}

function harness(initial: Partial<ControlCommandState> = {}): Harness {
  const h = {
    state: { pauseRequested: false, cancelRequested: false, breakpoints: [], ...initial },
    paused: [] as Array<{ boundary: string; reason: string; at?: string }>,
    resumed: 0,
  } as unknown as Harness;
  h.gate = new ControlGate(
    () => h.state,
    {
      onPaused: (boundary, reason, at) => h.paused.push({ boundary, reason, at }),
      onResumed: () => {
        h.resumed += 1;
      },
    },
    4,
  );
  return h;
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 模拟协调器行为：驻留后 run 状态置 paused（pauseRequested 回落） */
function mimicCoordinatorPauseState(h: Harness): void {
  h.state.pauseRequested = false;
}

function isPending(p: Promise<void>): boolean {
  let done = false;
  void p.then(() => {
    done = true;
  });
  return !done;
}

describe("ControlGate 断点与驻留", () => {
  it("边界断点命中：驻留且 onPaused 只发射一次；pauseRequested 回落不放行，epoch 推进才放行", async () => {
    const h = harness({ breakpoints: ["before_model"], resumeEpoch: 3 });
    const p = h.gate.reach("before_model");
    await tick(20); // 若重复发射，20ms/4ms 会产生多条
    expect(h.paused).toEqual([{ boundary: "before_model", reason: "breakpoint", at: undefined }]);
    mimicCoordinatorPauseState(h);
    await tick(16);
    expect(isPending(p)).toBe(true); // 未 resume：继续驻留
    h.state.resumeEpoch = 4; // resume 命令
    await p;
    expect(h.resumed).toBe(1);
  });

  it("未命中断点不驻留：其他边界直接通过", async () => {
    const h = harness({ breakpoints: ["before_tool"], resumeEpoch: 0 });
    await h.gate.reach("before_model");
    expect(h.paused).toEqual([]);
  });

  it("断点保持 armed：epoch 推进放行后，下一次到达再次命中", async () => {
    const h = harness({ breakpoints: ["turn_end"], resumeEpoch: 0 });
    const first = h.gate.reach("turn_end");
    await tick(8);
    expect(h.paused.length).toBe(1);
    h.state.resumeEpoch = 1;
    await first;
    // 断点未清除：下一次 reach（下一轮循环）再次驻留
    const second = h.gate.reach("turn_end");
    await tick(8);
    expect(h.paused.length).toBe(2);
    h.state.breakpoints = [];
    h.state.resumeEpoch = 2; // 第二次 resume
    await second;
  });

  it("清除断点 ≠ 自动继续：仍需 resume（调试器语义），随后不再命中", async () => {
    const h = harness({ breakpoints: ["before_tool"], resumeEpoch: 0 });
    const p = h.gate.reach("before_tool");
    await tick(8);
    h.state.breakpoints = [];
    await tick(12);
    expect(isPending(p)).toBe(true); // 断点移除不自动放行
    h.state.resumeEpoch = 1;
    await p;
    await h.gate.reach("before_tool"); // 断点已清除：直接通过
    expect(h.paused.length).toBe(1);
  });

  it("node:<id> 断点只匹配对应图节点", async () => {
    const h = harness({ breakpoints: ["node:search"], resumeEpoch: 0 });
    await h.gate.reach("before_model", "plan");
    expect(h.paused).toEqual([]);
    const p = h.gate.reach("before_model", "search");
    await tick(8);
    expect(h.paused).toEqual([{ boundary: "before_model", reason: "breakpoint", at: "search" }]);
    h.state.resumeEpoch = 1;
    await p;
  });

  it("手动暂停驻留同样需要 epoch 推进；驻留期间再次 pause 会阻止放行", async () => {
    const h = harness({ resumeEpoch: 0 });
    h.state.pauseRequested = true;
    const p = h.gate.reach("before_tool");
    await tick(8);
    expect(h.paused).toEqual([{ boundary: "before_tool", reason: "pause", at: undefined }]);
    mimicCoordinatorPauseState(h);
    h.state.resumeEpoch = 1;
    h.state.pauseRequested = true; // 新的手动暂停在场：epoch 推进也不放行
    await tick(12);
    expect(isPending(p)).toBe(true);
    h.state.pauseRequested = false;
    await p;
    expect(h.resumed).toBe(1);
  });

  it("驻留期间 cancel 最优先：抛出 CancelledError", async () => {
    const h = harness({ breakpoints: ["before_model"], resumeEpoch: 0 });
    const p = h.gate.reach("before_model");
    await tick(8);
    expect(h.paused.length).toBe(1);
    h.state.cancelRequested = true;
    await expect(p).rejects.toBeInstanceOf(CancelledError);
  });

  it("旧式 poll（无 resumeEpoch）：退化为 pauseRequested 回落放行", async () => {
    const h = harness({ breakpoints: ["before_model"] }); // resumeEpoch 未提供
    const p = h.gate.reach("before_model");
    await tick(8);
    expect(h.paused.length).toBe(1);
    mimicCoordinatorPauseState(h); // pauseRequested 回落 → 放行（原始语义）
    await p;
    expect(h.resumed).toBe(1);
  });

  it("ignoreBreakpoints：循环顶安全边界不命中断点，但仍响应手动暂停与 cancel", async () => {
    // reference-loop 循环顶部的 turn_end 安全边界：断点语义属于「每轮结束后」，
    // 顶部边界只响应手动暂停/取消（否则第 0 轮与每轮结束后重复驻留）
    const h = harness({ breakpoints: ["turn_end"], resumeEpoch: 0 });
    await h.gate.reach("turn_end", undefined, { ignoreBreakpoints: true });
    expect(h.paused).toEqual([]);
    // 同一边界在手动暂停请求下正常驻留
    h.state.pauseRequested = true;
    const p = h.gate.reach("turn_end", undefined, { ignoreBreakpoints: true });
    await tick(8);
    expect(h.paused).toEqual([{ boundary: "turn_end", reason: "pause", at: undefined }]);
    h.state.resumeEpoch = 1;
    h.state.pauseRequested = false;
    await p;
    // cancel 仍然最优先
    h.state.cancelRequested = true;
    await expect(h.gate.reach("turn_end", undefined, { ignoreBreakpoints: true })).rejects.toBeInstanceOf(CancelledError);
  });
});
