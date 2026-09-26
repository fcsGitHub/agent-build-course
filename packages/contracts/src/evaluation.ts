/**
 * 评测合同（T26）。依据设计文档 v1.1 §21。
 * 数据切分冻结、确定性优先评分器、逐用例结果 + 汇总统计；模型 judge 为后置扩展。
 */
export type EvalSplit = "train" | "dev" | "test";

export interface EvalCase {
  id: string;
  split: EvalSplit;
  input: string;
  /** 确定性评分规则（平台持有，候选不可改） */
  grader: { kind: "contains_all" | "contains_any" | "regex"; patterns: string[]; caseInsensitive?: boolean };
  /** 任务合同说明：不匹配的输入由 grader 标 not_applicable 而非硬判失败（A25） */
  taskContract?: string;
}

export interface EvalCaseResult {
  caseId: string;
  split: EvalSplit;
  applicable: boolean;
  passed: boolean;
  reason: string;
  outputChars: number;
  durationMs: number;
}

export interface EvalSuiteResult {
  suiteId: string;
  datasetVersion: string;
  results: EvalCaseResult[];
  summary: {
    total: number;
    applicable: number;
    passed: number;
    successRate: number;
    /** 成功率基于可适用用例 */
    notApplicable: number;
  };
  frozenAt: string;
}
