/** 确定性 grader：最终回答必须包含 calculator 的求和值。 */
export interface GraderInput {
  finalAnswer: string;
  toolResults: Array<{ toolId: string; value: string }>;
}
export interface GraderResult {
  applicable: boolean;
  passed: boolean;
  reason: string;
}
export function grade(input: GraderInput): GraderResult {
  const calc = input.toolResults.filter((t) => t.toolId === "calculator").at(-1);
  if (!calc) {
    return { applicable: false, passed: false, reason: "not_applicable：未使用计算器" };
  }
  const value = calc.value.replace(/[^0-9.-]/g, "");
  if (value.length > 0 && input.finalAnswer.includes(value)) {
    return { applicable: true, passed: true, reason: "回答引用了真实求和值" };
  }
  return { applicable: true, passed: false, reason: "回答未引用计算器求和值" };
}
