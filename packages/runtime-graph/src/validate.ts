/**
 * 图定义校验器（T19）。依据设计文档 v1.1 §13.2。
 * 悬空边、入口可达性、终止可达、谓词/节点类型合法性、访问上限。
 */
import type {
  GraphDefinition,
  GraphValidationError,
} from "@agentglass/contracts";

export const REGISTERED_PREDICATES = [
  "always",
  "never",
  "evidence_sufficient",
  "visits_under_limit",
] as const;

export const REGISTERED_REDUCERS = ["graph-state-v1"] as const;

export function validateGraph(def: GraphDefinition): GraphValidationError[] {
  const errors: GraphValidationError[] = [];
  const nodeIds = new Set(def.nodes.map((n) => n.id));

  // 节点类型合法
  for (const node of def.nodes) {
    if (!["model", "tool", "transform", "gate"].includes(node.kind)) {
      errors.push({
        code: "UNKNOWN_NODE_KIND",
        message: `未知节点类型: ${node.kind}`,
        nodeId: node.id,
      });
    }
  }

  // 边引用的节点存在
  for (const edge of def.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      errors.push({
        code: "DANGLING_EDGE",
        message: `边引用不存在的节点: ${edge.from} → ${edge.to}`,
      });
    }
    if (edge.predicateId && !REGISTERED_PREDICATES.includes(edge.predicateId as never)) {
      errors.push({
        code: "UNKNOWN_PREDICATE",
        message: `未注册谓词: ${edge.predicateId}（只允许注册谓词，不允许内联 JS）`,
      });
    }
  }

  // 入口存在
  if (!nodeIds.has(def.entryNodeId)) {
    errors.push({ code: "NO_ENTRY", message: `入口节点不存在: ${def.entryNodeId}` });
    return errors;
  }

  // reducer 注册
  if (!REGISTERED_REDUCERS.includes(def.reducerId as never)) {
    errors.push({ code: "UNKNOWN_PREDICATE", message: `未注册 reducer: ${def.reducerId}` });
  }

  // 访问上限
  if (def.maxNodeVisits < 1 || def.maxTotalExecutions < 1) {
    errors.push({
      code: "VISIT_LIMIT_INVALID",
      message: "访问上限必须 ≥ 1（自动循环必须有边界）",
    });
  }

  // 从入口可达的节点集合
  const reachable = new Set<string>();
  const stack = [def.entryNodeId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const e of def.edges) {
      if (e.from === cur && nodeIds.has(e.to)) stack.push(e.to);
    }
  }
  for (const id of nodeIds) {
    if (!reachable.has(id) && def.exitNodeIds.includes(id)) {
      errors.push({
        code: "ENTRY_UNREACHABLE",
        message: `终止节点从入口不可达: ${id}`,
        nodeId: id,
      });
    }
  }
  // 至少一个终止节点可达
  if (!def.exitNodeIds.some((id) => reachable.has(id))) {
    errors.push({ code: "NO_EXIT_REACHABLE", message: "没有任何终止节点从入口可达（图可能死循环）" });
  }

  return errors;
}

/** 谓词求值（注册谓词；不执行图外代码） */
export function evalPredicate(
  predicateId: string | undefined,
  ctx: { visits: number; maxVisits: number; evidenceSufficient: boolean },
): boolean {
  switch (predicateId ?? "always") {
    case "always":
      return true;
    case "never":
      return false;
    case "evidence_sufficient":
      return ctx.evidenceSufficient;
    case "visits_under_limit":
      return ctx.visits < ctx.maxVisits;
    default:
      return false;
  }
}
