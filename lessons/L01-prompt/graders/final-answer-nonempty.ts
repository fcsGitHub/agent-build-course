/** 确定性 grader：最终回答非空即通过（L00 不匹配固定任务时标 not_applicable）。 */
export interface GraderInput {
  finalAnswer: string;
  taskText: string;
}
export interface GraderResult {
  applicable: boolean;
  passed: boolean;
  reason: string;
}
export function grade(input: GraderInput): GraderResult {
  if (input.finalAnswer.trim().length === 0) {
    return { applicable: true, passed: false, reason: "最终回答为空" };
  }
  return { applicable: true, passed: true, reason: "最终回答非空" };
}
