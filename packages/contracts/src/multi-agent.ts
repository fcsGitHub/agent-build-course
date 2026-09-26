/**
 * 多 Agent 合同（T27）。依据设计文档 v1.1 §16。
 * TaskEnvelope：子任务不能自行扩大权限、延长截止时间或重新获取完整父预算；
 * AgentTaskResult：证据不完整时返回 failed，不凭"我已完成"设为成功。
 */

export interface TaskEnvelope {
  taskId: string;
  parentRunId: string;
  delegatedByActorId: string;
  targetAgentId: string;
  goal: string;
  /** 任务包引用（子 agent 只见任务包与必要资料，不见父上下文） */
  inputRefs: string[];
  allowedToolIds: string[];
  contextSnapshotId: string;
  expectedOutputSchemaId: string;
  acceptanceCriteriaRef: string | null;
  /** 子预算（从父预算原子预留） */
  budget: {
    maxModelCalls: number;
    maxToolCalls: number;
    maxWallTimeMs: number;
  };
  deadline: string;
  depth: number;
  idempotencyKey: string;
}

export interface AgentTaskResult {
  taskId: string;
  childRunId: string;
  status: "succeeded" | "failed" | "cancelled" | "unknown";
  outputRefs: string[];
  evidenceRefs: string[];
  validationRef: string | null;
}

export interface BlackboardWrite {
  key: string;
  content: string;
  taskId: string;
}

export interface MergeRecord {
  key: string;
  /** 并发写冲突时保留两个版本（不静默覆盖） */
  conflict: boolean;
  versions: Array<{ taskId: string; content: string }>;
  mergedBy: "sequential" | "conflict-kept-both";
  causeEventIds: string[];
}
