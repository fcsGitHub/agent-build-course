/** 确定性 grader：最终回答必须引用 read_text 读取到的数值或 calculator 计算值。 */
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
  const calc = input.toolResults.find((t) => t.toolId === "calculator");
  if (!calc) {
    return { applicable: false, passed: false, reason: "not_applicable：本次运行未使用计算器" };
  }
  const value = calc.value.replace(/[^0-9.-]/g, "");
  if (value.length > 0 && input.finalAnswer.includes(value)) {
    return { applicable: true, passed: true, reason: "最终回答引用了计算器真实结果" };
  }
  return { applicable: true, passed: false, reason: "回答未引用计算器结果（可能的编造）" };
}
