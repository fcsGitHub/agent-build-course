/** 确定性 grader：最终回答包含【c:块ID】引用标注即通过结构层。 */
export interface GraderInput {
  finalAnswer: string;
}
export interface GraderResult {
  applicable: boolean;
  passed: boolean;
  reason: string;
}
export function grade(input: GraderInput): GraderResult {
  const ok = /【c:[\w-]+】/.test(input.finalAnswer);
  return ok
    ? { applicable: true, passed: true, reason: "回答包含块 ID 引用" }
    : { applicable: false, passed: false, reason: "not_applicable：本次任务未要求引用" };
}
