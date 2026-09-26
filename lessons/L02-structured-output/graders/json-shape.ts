/** 确定性 grader：输出可解析为 JSON 即通过结构层；语义层交给人工/judge。 */
export interface GraderInput {
  finalAnswer: string;
}
export interface GraderResult {
  applicable: boolean;
  passed: boolean;
  reason: string;
}
export function grade(input: GraderInput): GraderResult {
  try {
    JSON.parse(input.finalAnswer);
    return { applicable: true, passed: true, reason: "输出可解析为 JSON（仅结构层通过）" };
  } catch {
    return { applicable: false, passed: false, reason: "not_applicable：本次任务未要求 JSON 输出" };
  }
}
