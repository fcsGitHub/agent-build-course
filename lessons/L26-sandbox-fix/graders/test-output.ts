/** 确定性 grader：run_test 输出包含 ALL TESTS PASSED 即通过。 */
export interface GraderInput {
  toolResults: Array<{ toolId: string; value: string }>;
}
export interface GraderResult {
  applicable: boolean;
  passed: boolean;
  reason: string;
}
export function grade(input: GraderInput): GraderResult {
  const runTest = input.toolResults.filter((t) => t.toolId === "run_test").at(-1);
  if (!runTest) {
    return { applicable: false, passed: false, reason: "not_applicable：本次任务未运行测试" };
  }
  const passed = runTest.value.includes("ALL TESTS PASSED");
  return passed
    ? { applicable: true, passed: true, reason: "测试全部通过（真实退出码 0）" }
    : { applicable: true, passed: false, reason: "测试未全部通过" };
}
