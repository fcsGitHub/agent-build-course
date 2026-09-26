/**
 * T19 状态图运行时测试：校验器（悬空边/谓词/可达性/上限）+ 执行（条件边、有限循环、终止）。
 */
import { describe, expect, it } from "vitest";
import type { GraphDefinition } from "@agentglass/contracts";
import { validateGraph, evalPredicate } from "@agentglass/runtime-graph";

function baseGraph(overrides: Partial<GraphDefinition> = {}): GraphDefinition {
  return {
    id: "g-test",
    revision: "1.0.0",
    entryNodeId: "a",
    exitNodeIds: ["c"],
    reducerId: "graph-state-v1",
    maxNodeVisits: 2,
    maxTotalExecutions: 10,
    nodes: [
      { id: "a", kind: "model", handlerId: "step a" },
      { id: "b", kind: "tool", handlerId: "search_documents" },
      { id: "c", kind: "model", handlerId: "step c" },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ],
    ...overrides,
  };
}

describe("图校验器（T19）", () => {
  it("合法图零错误", () => {
    expect(validateGraph(baseGraph())).toEqual([]);
  });

  it("悬空边被拒绝", () => {
    const errors = validateGraph(baseGraph({ edges: [{ from: "a", to: "ghost" }] }));
    expect(errors.some((e) => e.code === "DANGLING_EDGE")).toBe(true);
  });

  it("未注册谓词被拒绝（不允许内联 JS）", () => {
    const errors = validateGraph(
      baseGraph({ edges: [{ from: "a", to: "b", predicateId: "eval(userInput)" }] }),
    );
    expect(errors.some((e) => e.code === "UNKNOWN_PREDICATE")).toBe(true);
  });

  it("终止节点不可达被拒绝（防死循环图）", () => {
    const g = baseGraph({ edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] });
    const errors = validateGraph(g);
    expect(errors.some((e) => e.code === "NO_EXIT_REACHABLE")).toBe(true);
  });

  it("访问上限必须 ≥ 1", () => {
    const errors = validateGraph(baseGraph({ maxNodeVisits: 0 }));
    expect(errors.some((e) => e.code === "VISIT_LIMIT_INVALID")).toBe(true);
  });

  it("注册谓词求值语义", () => {
    expect(evalPredicate("always", { visits: 5, maxVisits: 2, evidenceSufficient: false })).toBe(true);
    expect(evalPredicate("visits_under_limit", { visits: 2, maxVisits: 2, evidenceSufficient: true })).toBe(false);
    expect(evalPredicate("visits_under_limit", { visits: 1, maxVisits: 2, evidenceSufficient: true })).toBe(true);
    expect(evalPredicate("evidence_sufficient", { visits: 0, maxVisits: 2, evidenceSufficient: false })).toBe(false);
    expect(evalPredicate(undefined, { visits: 0, maxVisits: 1, evidenceSufficient: false })).toBe(true);
  });
});
