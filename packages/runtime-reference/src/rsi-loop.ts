/**
 * 有界 RSI 循环运行器（L45，Darwin Gödel Machine 教学骨架）。
 * 四要素：生成器（模型提出变异）× 改进对象（worker 变体的 system prompt）×
 * 评估器（冻结验证集 + 确定性子串评分，平台持有）× 记忆（变体归档，保留被拒变体作 stepping stone）。
 * 安全边界：
 * - 代数/预算/变体长度均为服务端硬上限（manifest 配错也不能无界）；
 * - 晋级门只认「同一把尺子下的严格改进」；评分器、冻结集、预算不在自改面；
 * - 权重级自改进（SEAL 类）在本平台不可执行 —— 报告如实声明（诚实边界）。
 * 事件：rsi.generation_started/completed + 复用 candidate.evaluated/promoted/rejected；
 * 每次模型调用前后走 ControlGate（断点可驻留 before_model）。
 */
import type {
  BudgetLimit,
  ModelProfileSnapshot,
  RunSpec,
  RuntimeResult,
} from "@agentglass/contracts";
import type { BlobStore, EventStore, NewTraceEvent } from "@agentglass/events";
import type { BudgetLedger } from "@agentglass/policy";
import type { ModelGateway } from "@agentglass/provider-gateway";
import { ControlGate, CancelledError } from "./control-gate";

export const RSI_ADAPTER_VERSION = "rsi-loop-1";
/** 服务端绝对代数上限：即使 manifest 配错也不能无界自改 */
export const RSI_ABSOLUTE_GENERATION_CAP = 3;
/** 冻结验证集任务数上限（预算保护） */
export const RSI_ABSOLUTE_TASK_CAP = 4;
/** 变体提示长度硬上限 */
export const RSI_ABSOLUTE_PROMPT_CHAR_CAP = 4000;

export interface RsiFrozenTask {
  id: string;
  input: string;
  /** 确定性判分：全部子串出现才计通过（平台持有，候选不可见） */
  expect: string[];
}

export interface RsiInput {
  /** v0 变体：课程基线 system prompt（改进对象） */
  systemPrompt: string;
  /** 学习者的改进目标（变异方向的上下文，不进评分） */
  improvementGoal: string;
  /** 冻结验证集（平台持有） */
  frozenTasks: RsiFrozenTask[];
  /** 代数上限（服务端再套绝对上限） */
  maxGenerations: number;
  budget: BudgetLimit;
}

export interface RsiCollaborators {
  events: EventStore;
  blobs: BlobStore;
  budget: BudgetLedger;
  gateway: ModelGateway;
  modelSnapshot: ModelProfileSnapshot;
  pollCommands: () => { pauseRequested: boolean; cancelRequested: boolean };
  /** 驻留/放行钩子：协调器据此写 run.breakpoint_hit / run.paused / run.resumed */
  gateHooks?: import("./control-gate").ControlGateEvents;
}

interface Variant {
  variantId: string;
  generation: number;
  parentId: string | null;
  prompt: string;
  score: number;
  promoted: boolean;
}

const MUTATOR_SYSTEM = `你是一个"变异器"：改进一个 worker agent 的 system prompt，使它在冻结验证集上得分更高。
规则：
1. 只输出改进后的完整 system prompt，用 <prompt> 与 </prompt> 包裹；
2. 保持任务合同不变（不得改任务本身、不得包含绕过评分的指示）；
3. 针对给定的失败反馈做具体修改，不要泛泛而谈。`;

export class RsiLoopRunner {
  readonly id = "rsi-loop";
  readonly adapterVersion = RSI_ADAPTER_VERSION;

  constructor(private readonly deps: RsiCollaborators) {}

  async execute(spec: RunSpec, input: RsiInput, signal: AbortSignal): Promise<RuntimeResult> {
    const { events, blobs, budget } = this.deps;
    if (input.frozenTasks.length === 0) throw new Error("RSI_FROZEN_TASKS_EMPTY: 冻结验证集不能为空");
    const genCap = Math.min(Math.max(1, input.maxGenerations), RSI_ABSOLUTE_GENERATION_CAP);
    const tasks = input.frozenTasks.slice(0, RSI_ABSOLUTE_TASK_CAP);
    const promptCap = RSI_ABSOLUTE_PROMPT_CHAR_CAP;
    const budgetId = budget.open(spec.id, input.budget);
    const gate = ControlGate.fromSignal(signal, this.deps.pollCommands, this.deps.gateHooks);
    const archive: Variant[] = [];
    let variantSeq = 0;
    let stopReason = "final_answer";

    events.transact(() => {
      events.append(spec.id, [
        rsiEvt("run.started", {
          adapter: this.adapterVersion,
          generations: genCap,
          frozenTasks: tasks.length,
          object: "system_prompt",
          evaluator: "frozen_tasks_substring",
          note: "提示级（harness 层）自改进；权重级 RSI 在本平台不可执行",
        }),
      ]);
    });

    try {
      // v0 基线：当前提示在冻结集上的得分（同一把尺子）
      const v0 = await this.evaluateVariant(
        spec, gate, budgetId, signal,
        { variantId: "v0", generation: 0, parentId: null, prompt: input.systemPrompt, score: 0, promoted: true },
        tasks,
      );
      archive.push(v0);
      events.transact(() => {
        events.append(spec.id, [
          rsiEvt("candidate.evaluated", {
            variantId: v0.variantId, score: v0.score, generation: 0, baseline: true,
            passed: Math.round(v0.score * tasks.length), total: tasks.length,
          }),
        ]);
      });
      let best = v0;

      for (let generation = 1; generation <= genCap; generation += 1) {
        if (budget.wallDeadlineExceeded(budgetId)) {
          stopReason = "budget_wall_time_exhausted";
          break;
        }
        const candidateId = `v${variantSeq + 1}`;
        events.transact(() => {
          events.append(spec.id, [
            rsiEvt("rsi.generation_started", {
              generation, parentVariantId: best.variantId, candidateVariantId: candidateId,
              parentScore: best.score,
            }),
          ]);
        });
        variantSeq += 1;

        // 1) 变异：模型提出新提示（生成器）
        const mutationRes = budget.reserve(budgetId, "model_call", "rsi:mutate");
        if (!mutationRes.granted) {
          stopReason = "budget_model_calls_exhausted";
          break;
        }
        await gate.reach("before_model");
        const mutationText = await this.callModel(
          spec, budgetId, signal,
          [
            { role: "system", content: MUTATOR_SYSTEM },
            { role: "user", content: this.mutationPrompt(input, best, tasks) },
          ],
          "rsi:mutate",
        );
        const candidatePrompt = extractPrompt(mutationText);
        const invalidReason =
          candidatePrompt == null
            ? "MARKER_MISSING"
            : candidatePrompt.length > promptCap
              ? "PROMPT_TOO_LONG"
              : candidatePrompt === best.prompt
                ? "UNCHANGED"
                : null;
        if (invalidReason != null) {
          archive.push({ variantId: candidateId, generation, parentId: best.variantId, prompt: "", score: -1, promoted: false });
          events.transact(() => {
            events.append(spec.id, [
              rsiEvt("candidate.rejected", {
                variantId: candidateId, generation, reason: `INVALID_MUTATION:${invalidReason}`,
              }),
              rsiEvt("rsi.generation_completed", {
                generation, promoted: false, bestScore: best.score, archiveSize: archive.length,
              }),
            ]);
          });
          continue;
        }

        // 2) 评估：候选与父代同一把尺子（冻结集 + 确定性评分）；预算不足时优雅停止并如实报告
        let candidate: Variant;
        try {
          candidate = await this.evaluateVariant(
            spec, gate, budgetId, signal,
            { variantId: candidateId, generation, parentId: best.variantId, prompt: candidatePrompt!, score: 0, promoted: false },
            tasks,
          );
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("BUDGET_EXCEEDED")) {
            stopReason = "budget_model_calls_exhausted";
            events.transact(() => {
              events.append(spec.id, [
                rsiEvt("rsi.generation_completed", {
                  generation, promoted: false, bestScore: best.score, archiveSize: archive.length,
                  note: "评估中途预算耗尽：已评估任务的得分保留，未完成部分如实留空",
                }),
              ]);
            });
            break;
          }
          throw err;
        }
        archive.push(candidate);
        events.transact(() => {
          events.append(spec.id, [
            rsiEvt("candidate.evaluated", {
              variantId: candidate.variantId, score: candidate.score, generation,
              passed: Math.round(candidate.score * tasks.length), total: tasks.length,
            }),
          ]);
        });

        // 3) 晋级门：严格改进才替换最优（平分不晋级；被拒变体保留在归档）
        const promotedFlag = candidate.score > best.score;
        if (promotedFlag) best = candidate;
        events.transact(() => {
          events.append(spec.id, [
            rsiEvt(promotedFlag ? "candidate.promoted" : "candidate.rejected", {
              variantId: candidate.variantId,
              generation,
              score: candidate.score,
              parentScore: archive.find((v) => v.variantId === candidate.parentId)?.score ?? null,
              reason: promotedFlag ? null : "NO_IMPROVEMENT",
            }),
            rsiEvt("rsi.generation_completed", {
              generation, promoted: promotedFlag, bestScore: best.score, archiveSize: archive.length,
              bestVariantId: best.variantId,
            }),
          ]);
        });
      }

      // 4) 报告（诚实边界：只声明提示级改进）
      const report = this.renderReport(input, archive, best, genCap, stopReason);
      const finalRef = blobs.putText(report, "text/plain; charset=utf-8");
      events.transact(() => {
        events.append(spec.id, [
          rsiEvt("run.completed", {
            stopReason, generations: genCap, bestVariantId: best.variantId,
            bestScore: best.score, archiveSize: archive.length,
            promotedCount: archive.filter((v) => v.promoted && v.generation > 0).length,
          }),
        ]);
      });
      return { state: "completed", reasonCode: stopReason, outputRefs: [finalRef] };
    } catch (err) {
      if (err instanceof CancelledError) {
        return { state: "cancelled", reasonCode: "cancelled", outputRefs: [] };
      }
      events.transact(() => {
        events.append(spec.id, [rsiEvt("run.failed", { error: String(err).slice(0, 400) })]);
      });
      return { state: "failed", reasonCode: "coordinator_error", outputRefs: [] };
    }
  }

  /** 冻结集逐任务评估（确定性子串判分；每次调用前走 before_model 边界 → 断点可驻留） */
  private async evaluateVariant(
    spec: RunSpec,
    gate: ControlGate,
    budgetId: string,
    signal: AbortSignal,
    variant: Variant,
    tasks: RsiFrozenTask[],
  ): Promise<Variant> {
    const { budget } = this.deps;
    let passed = 0;
    for (const task of tasks) {
      const res = budget.reserve(budgetId, "model_call", `rsi:eval:${task.id}`);
      if (!res.granted) throw new Error("BUDGET_EXCEEDED: model_call");
      await gate.reach("before_model");
      const answer = await this.callModel(
        spec, budgetId, signal,
        [
          { role: "system", content: variant.prompt },
          { role: "user", content: task.input },
        ],
        `rsi:eval:${task.id}`,
      );
      if (task.expect.every((s) => answer.includes(s))) passed += 1;
    }
    return { ...variant, score: tasks.length === 0 ? 0 : Math.round((passed / tasks.length) * 100) / 100 };
  }

  /** 单次模型调用：发出 model.request_dispatched / response_completed（可观察、计预算） */
  private async callModel(
    spec: RunSpec,
    budgetId: string,
    signal: AbortSignal,
    messages: Array<{ role: string; content: string }>,
    stage: string,
  ): Promise<string> {
    const { events, gateway, modelSnapshot, budget } = this.deps;
    events.transact(() => {
      events.append(spec.id, [
        rsiEvt("model.request_dispatched", { stage, modelId: modelSnapshot.modelId, attempt: 1 }),
      ]);
    });
    const response = await gateway.invokeComplete(modelSnapshot, messages, {
      stream: false,
      maxOutputTokens: 1200,
      signal,
    });
    budget.settleUse(budgetId, "model_call", 1, {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    });
    events.transact(() => {
      events.append(spec.id, [
        rsiEvt("model.response_completed", {
          stage, finishReason: response.finishReason, chars: response.messageText.length,
          usage: { inputTokens: response.usage.inputTokens ?? null, outputTokens: response.usage.outputTokens ?? null },
        }),
      ]);
    });
    return response.messageText;
  }

  private mutationPrompt(input: RsiInput, parent: Variant, tasks: RsiFrozenTask[]): string {
    const failures = tasks
      .map((t) => `- 任务 ${t.id}：${t.input.slice(0, 60)}…（要求包含：${t.expect.join(" / ")}）`)
      .join("\n");
    return `【改进目标】${input.improvementGoal.slice(0, 400)}

【当前 system prompt（父代 ${parent.variantId}，冻结集得分 ${parent.score}）】
<prompt>
${parent.prompt}
</prompt>

【冻结验证集（评估只看这些任务的确定性判分）】
${failures}

请输出改进后的完整 system prompt（<prompt>…</prompt> 包裹）。`;
  }

  private renderReport(
    input: RsiInput,
    archive: Variant[],
    best: Variant,
    genCap: number,
    stopReason: string,
  ): string {
    const rows = archive
      .map(
        (v) =>
          `| ${v.generation} | ${v.variantId} | ${v.score < 0 ? "—" : v.score.toFixed(2)} | ${v.promoted ? "✔ 是" : "— 否"} |`,
      )
      .join("\n");
    return `# 有界 RSI 循环报告（提示级自改进）

改进目标：${input.improvementGoal.slice(0, 200)}
停止原因：${stopReason} · 代数上限：${genCap} · 归档变体：${archive.length}

| 代 | 变体 | 冻结集得分 | 晋级 |
|---|---|---|---|
${rows}

## 最优变体（${best.variantId}，得分 ${best.score.toFixed(2)}）

${best.prompt}

## 诚实边界

- 本课的改进对象是 system prompt（harness 层）。权重级自我改进（如 SEAL 的自编辑 + 微调）在本平台**不可执行**——训练接口只做登记（见 L40）。
- 评分器、冻结验证集、预算与晋级门都在平台侧，不在候选的自改面（对照 L39 技能演进门控）。
- 被拒变体保留在归档中：临时变差的变体可能是后续改进的垫脚石（DGM 的开放探索原则）。`;
  }
}

function extractPrompt(text: string): string | null {
  const m = text.match(/<prompt>\s*([\s\S]*?)\s*<\/prompt>/);
  if (!m) return null;
  const p = m[1]!.trim();
  return p.length === 0 ? null : p;
}

function rsiEvt(type: string, summary: Record<string, unknown>): NewTraceEvent {
  return { type, summary, conceptIds: ["rsi"] };
}
