/**
 * 评估服务（T26）。冻结数据切分、确定性评分器、逐用例结果与汇总统计；
 * 评分规则平台持有——被评候选不可修改 grader 或隐藏切分。
 * 依据设计文档 v1.1 §21.1—§21.3。
 */
import { createHash } from "node:crypto";
import type {
  EvalCase,
  EvalCaseResult,
  EvalSuiteResult,
} from "@agentglass/contracts";

export const EVAL_SERVICE_VERSION = "evaluation-1";

export type CaseRunner = (input: string) => Promise<string>;

export class EvaluationService {
  private frozen: { hash: string; frozenAt: string } | null = null;
  private frozenCases: EvalCase[] = [];

  /**
   * 冻结切分：对用例集计算内容摘要；冻结后同一哈希复用，
   * 不同哈希生成新冻结（保证评估期间数据集不可变）。
   */
  freeze(cases: EvalCase[]): { suiteId: string; frozenAt: string; hash: string } {
    const hash = createHash("sha256")
      .update(JSON.stringify(cases))
      .digest("hex");
    if (this.frozen?.hash === hash) {
      return { suiteId: this.frozen.hash.slice(0, 12), frozenAt: this.frozen.frozenAt, hash };
    }
    this.frozenCases = cases.map((c) => ({ ...c }));
    this.frozen = { hash, frozenAt: new Date().toISOString() };
    return { suiteId: hash.slice(0, 12), frozenAt: this.frozen.frozenAt, hash };
  }

  /** 确定性评分器（环境终态/schema 类；模型 judge 不在此层） */
  grade(grader: EvalCase["grader"], output: string): { applicable: boolean; passed: boolean; reason: string } {
    const hay = grader.caseInsensitive ? output.toLowerCase() : output;
    const patterns = grader.caseInsensitive
      ? grader.patterns.map((p) => p.toLowerCase())
      : grader.patterns;
    if (grader.kind === "contains_all") {
      const missing = patterns.filter((p) => !hay.includes(p));
      return missing.length === 0
        ? { applicable: true, passed: true, reason: "全部关键词命中" }
        : { applicable: true, passed: false, reason: `缺少: ${missing.join(", ").slice(0, 120)}` };
    }
    if (grader.kind === "contains_any") {
      const hit = patterns.find((p) => hay.includes(p));
      return hit != null
        ? { applicable: true, passed: true, reason: `命中: ${hit.slice(0, 60)}` }
        : { applicable: true, passed: false, reason: "未命中任何关键词" };
    }
    if (grader.kind === "regex") {
      for (const p of patterns) {
        try {
          if (new RegExp(p, grader.caseInsensitive ? "i" : "").test(output)) {
            return { applicable: true, passed: true, reason: `正则命中: ${p.slice(0, 60)}` };
          }
        } catch {
          return { applicable: true, passed: false, reason: `无效正则: ${p.slice(0, 60)}` };
        }
      }
      return { applicable: true, passed: false, reason: "正则未命中" };
    }
    return { applicable: false, passed: false, reason: "not_applicable：未知评分器类型" };
  }

  /** 运行冻结套件：runner 为受控执行器（真实模型或显式标记的确定性 runner）。 */
  async runSuite(runner: CaseRunner, filterSplit?: "train" | "dev" | "test"): Promise<EvalSuiteResult> {
    if (!this.frozen) throw new Error("EVAL_NOT_FROZEN: 先调用 freeze()");
    const cases = this.frozenCases.filter((c) => filterSplit == null || c.split === filterSplit);
    const results: EvalCaseResult[] = [];
    for (const c of cases) {
      const started = Date.now();
      let output = "";
      let runError: string | null = null;
      try {
        output = await runner(c.input);
      } catch (err) {
        runError = String(err).slice(0, 200);
      }
      const graded = runError
        ? { applicable: true, passed: false, reason: `执行失败: ${runError}` }
        : this.grade(c.grader, output);
      results.push({
        caseId: c.id,
        split: c.split,
        applicable: graded.applicable,
        passed: graded.passed,
        reason: graded.reason,
        outputChars: output.length,
        durationMs: Date.now() - started,
      });
    }
    const applicableResults = results.filter((r) => r.applicable);
    const passed = applicableResults.filter((r) => r.passed).length;
    return {
      suiteId: this.frozen.hash.slice(0, 12),
      datasetVersion: this.frozen.hash,
      results,
      summary: {
        total: results.length,
        applicable: applicableResults.length,
        passed,
        successRate: applicableResults.length > 0 ? passed / applicableResults.length : 0,
        notApplicable: results.length - applicableResults.length,
      },
      frozenAt: this.frozen.frozenAt,
    };
  }

  /**
   * 配对对照（同输入两配置）：逐用例比较通过情况。
   * 注意：样本量小时不给显著性承诺，只报告方向性差异（设计 §21.4）。
   */
  comparePairwise(a: EvalSuiteResult, b: EvalSuiteResult): {
    bothPassed: number;
    onlyA: number;
    onlyB: number;
    bothFailed: number;
    direction: "a-better" | "b-better" | "tie" | "insufficient-sample";
  } {
    const byId = new Map(b.results.map((r) => [r.caseId, r]));
    let bothPassed = 0;
    let onlyA = 0;
    let onlyB = 0;
    let bothFailed = 0;
    for (const ra of a.results) {
      const rb = byId.get(ra.caseId);
      if (!rb) continue;
      if (ra.passed && rb.passed) bothPassed += 1;
      else if (ra.passed) onlyA += 1;
      else if (rb.passed) onlyB += 1;
      else bothFailed += 1;
    }
    const n = bothPassed + onlyA + onlyB + bothFailed;
    const direction =
      n < 5
        ? "insufficient-sample"
        : onlyA > onlyB
          ? "a-better"
          : onlyB > onlyA
            ? "b-better"
            : "tie";
    return { bothPassed, onlyA, onlyB, bothFailed, direction };
  }
}
