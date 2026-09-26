/**
 * T38 子集：提示候选评测与晋级（DSPy/GEPA 类优化器的教学骨架）。
 * - 数据切分冻结一次：所有候选共用同一冻结验证集与评分器（平台持有，候选不可改）；
 * - 逐候选评测：真实 runner（模型调用或确定性 runner）产出逐用例结果；
 * - 选优：成功率最高者胜；平分取提示更短者（成本取向）；全部低于门槛 → 全部拒绝，不晋级；
 * - 诚实记录：每个候选写 candidate.evaluated；胜者 candidate.promoted，败者 candidate.rejected（保留原因）。
 * 依据设计文档 v1.1 §4.8 L38、§17.5（优化目标与隐藏测试不能由候选随意修改）。
 */
import type { BlobStore, EventStore } from "@agentglass/events";
import type { EvalCase, EvalSuiteResult } from "@agentglass/contracts";
import type { EvaluationService, CaseRunner } from "@agentglass/evaluation";

export const PROMPT_CANDIDATE_VERSION = "prompt-candidate-1";

/** 候选提示的安全回归：不允许操纵评分器/隐藏测试/注入平台指令 */
const PROMPT_FORBIDDEN = /grader|hidden[-_]?test|评分器|隐藏测试|ignore (all )?(previous|prior)|忽略(之前|以上).*指令/i;

export interface PromptVariant {
  candidateId: string;
  prompt: string;
  proposedBy: string;
}

export interface PromptCandidateDecision {
  promotedVariantId: string | null;
  reason: string;
  results: Array<{
    candidateId: string;
    suite: EvalSuiteResult;
    promptChars: number;
    promoted: boolean;
    detail: string;
  }>;
}

export class PromptCandidateService {
  constructor(
    private readonly blobs: BlobStore,
    private readonly events: EventStore,
    private readonly evaluation: EvaluationService,
  ) {}

  /**
   * 评测全部候选并晋级最优。evalCases/runner 由平台提供；
   * 候选提交者无权指定 grader 或隐藏用例（与 T31 同一纪律）。
   */
  async evaluateAndPromote(input: {
    taskName: string;
    variants: PromptVariant[];
    evalCases: EvalCase[];
    /** runner 工厂：给定候选提示，返回对该提示的受控执行器 */
    runnerFor: (prompt: string) => CaseRunner;
    minSuccessRate: number;
  }): Promise<PromptCandidateDecision> {
    if (input.variants.length === 0) throw new Error("PROMPT_NO_VARIANTS: 至少一个候选");
    // 冻结一次：所有候选共享同一验证集快照
    const frozen = this.evaluation.freeze(input.evalCases);

    const results: PromptCandidateDecision["results"] = [];
    for (const variant of input.variants) {
      // 安全回归：提示不得操纵评分/隐藏测试
      if (PROMPT_FORBIDDEN.test(variant.prompt)) {
        const detail = "safety: 候选提示包含评分器操纵/指令注入构造";
        results.push({ candidateId: variant.candidateId, suite: { suiteId: frozen.suiteId, datasetVersion: frozen.hash, results: [], summary: { total: 0, applicable: 0, passed: 0, successRate: 0, notApplicable: 0 }, frozenAt: frozen.frozenAt }, promptChars: variant.prompt.length, promoted: false, detail });
        this.record(variant, input.taskName, false, detail, frozen.suiteId);
        continue;
      }
      const suite = await this.evaluation.runSuite(input.runnerFor(variant.prompt));
      const promoted = suite.summary.successRate >= input.minSuccessRate && suite.summary.applicable > 0;
      const detail = promoted
        ? `冻结集成功率 ${suite.summary.successRate.toFixed(2)}（门槛 ${input.minSuccessRate}）`
        : `未达门槛：${suite.summary.successRate.toFixed(2)} < ${input.minSuccessRate}`;
      results.push({ candidateId: variant.candidateId, suite, promptChars: variant.prompt.length, promoted, detail });
      this.record(variant, input.taskName, promoted, detail, frozen.suiteId);
    }

    // 选优：成功率最高；平分取提示更短（token 成本取向）
    const eligible = results.filter((r) => r.promoted);
    if (eligible.length === 0) {
      return { promotedVariantId: null, reason: "全部候选未达门槛，不晋级（保留评测记录）", results };
    }
    eligible.sort((a, b) =>
      b.suite.summary.successRate - a.suite.summary.successRate || a.promptChars - b.promptChars || a.candidateId.localeCompare(b.candidateId),
    );
    const winner = eligible[0]!;
    // 落选者补记 rejected（保留原因，不静默丢弃）
    for (const r of results) {
      if (r.candidateId !== winner.candidateId && r.promoted) {
        this.events.transact(() => {
          this.events.append(r.candidateId, [
            { type: "candidate.rejected", summary: { candidateId: r.candidateId, gate: "selection", detail: `成功率低于胜者（${r.suite.summary.successRate.toFixed(2)} < ${winner.suite.summary.successRate.toFixed(2)}）` } },
          ]);
        });
        r.promoted = false;
        r.detail = `落选：成功率 ${r.suite.summary.successRate.toFixed(2)} 低于胜者`;
      }
    }
    this.events.transact(() => {
      this.events.append(winner.candidateId, [
        { type: "candidate.promoted", summary: { candidateId: winner.candidateId, taskName: input.taskName, successRate: winner.suite.summary.successRate, promptChars: winner.promptChars, suiteId: winner.suite.suiteId } },
      ]);
    });
    return { promotedVariantId: winner.candidateId, reason: `胜出：成功率 ${winner.suite.summary.successRate.toFixed(2)}，提示 ${winner.promptChars} 字符`, results };
  }

  private record(variant: PromptVariant, taskName: string, promoted: boolean, detail: string, suiteId: string): void {
    const ref = this.blobs.putJson({ variant, taskName, promoted, detail, suiteId, evaluatedAt: new Date().toISOString(), gateVersion: PROMPT_CANDIDATE_VERSION });
    this.events.transact(() => {
      this.events.append(variant.candidateId, [
        {
          type: "candidate.evaluated",
          summary: { candidateId: variant.candidateId, taskName, promoted, detail: detail.slice(0, 160), recordRef: ref.id, gateVersion: PROMPT_CANDIDATE_VERSION },
          conceptIds: ["evolution"],
        },
      ]);
    });
  }
}
