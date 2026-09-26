/**
 * 状态图合同（T19）。依据设计文档 v1.1 §13.2。
 * 运行中只允许已注册的转换器与谓词；不执行浏览器/模型传入的任意 JS。
 */

export type GraphNodeKind = "model" | "tool" | "transform" | "gate";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  /**
   * kind 分派的注册 ID：
   * model → 步骤指令（纯文本）；tool → 工具 ID；transform → 注册转换器 ID；gate → 审批目标模式
   */
  handlerId: string;
  /** model/tool 节点是否允许携带工具（model 节点默认无工具） */
  allowTools?: boolean;
  /** tool 节点的调用参数（注册模板；非任意代码） */
  argsTemplate?: Record<string, string>;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** 已注册谓词 ID：如 "always" | "evidence_sufficient" | "visits_under_limit"；缺省 always */
  predicateId?: string;
}

export interface GraphDefinition {
  id: string;
  revision: string;
  entryNodeId: string;
  /** 终止节点（模型汇合输出或 gate 通过）列表 */
  exitNodeIds: string[];
  reducerId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 每节点最大访问次数（有限循环） */
  maxNodeVisits: number;
  /** 全图最大节点执行数（硬上限） */
  maxTotalExecutions: number;
}

/** 图执行的可序列化状态（节点间传递） */
export interface GraphState {
  runId: string;
  taskText: string;
  /** 节点输出（nodeId → 文本摘要） */
  outputs: Record<string, string>;
  /** 计划/证据等结构化字段（注册 reducer 拥有 schema） */
  fields: Record<string, unknown>;
  visits: Record<string, number>;
  totalExecutions: number;
  finished: boolean;
  finishReason?: string;
}

export interface GraphValidationError {
  code:
    | "DANGLING_EDGE"
    | "NO_ENTRY"
    | "ENTRY_UNREACHABLE"
    | "NO_EXIT_REACHABLE"
    | "UNKNOWN_PREDICATE"
    | "UNKNOWN_NODE_KIND"
    | "VISIT_LIMIT_INVALID";
  message: string;
  nodeId?: string;
}
