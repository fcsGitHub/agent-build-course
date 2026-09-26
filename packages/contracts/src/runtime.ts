/**
 * AgentGlass 公共运行时合同。
 * 依据设计文档 v1.1 第 8.2 节。合同由本系统拥有，不暴露任何 SDK 内部类型。
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type RunMode = "live" | "reexecute" | "branch";

export type RunState =
  | "created"
  | "queued"
  | "running"
  | "pause_requested"
  | "paused"
  | "awaiting_approval"
  | "cancel_requested"
  | "completed"
  | "failed"
  | "cancelled"
  | "reconciliation_required";

export type Boundary =
  | "before_model"
  | "after_model"
  | "before_tool"
  | "after_tool"
  | "turn_end"
  | "graph_node_end";

export interface BlobRef {
  id: string;
  sha256: string;
  mediaType: string;
  bytes: number;
}

export interface RuntimeCapabilities {
  boundaries: Boundary[];
  contextCapture: "wire_and_compiled" | "compiled_only" | "partial";
  resume: "durable_checkpoint" | "turn_boundary" | "none";
  fork: "isolated_checkpoint" | "input_only" | "none";
  toolInterception: boolean;
  nestedRuns: boolean;
  /** 经过适配验证的课程扩展点；无支持时为空 */
  editableSlots: string[];
  revisionFork: "same_revision_only" | "declared_compatible" | "none";
}

export interface BudgetLimit {
  maxTurns: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxWallTimeMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** 固定币种的整数微单位；无价格表时省略并在 UI 标费用未知 */
  maxCostMicros?: number;
  maxConcurrency: number;
  maxDepth: number;
}

export interface RunSpec {
  id: string;
  mode: RunMode;
  experimentVersion: string;
  runtimeSnapshotId: string;
  modelProfileSnapshotId: string;
  sourceManifestId: string;
  /** 含受控源码修改的不可变执行版本 */
  agentRevisionId: string;
  sessionId: string;
  inputSubmissionId: string;
  /** 接纳输入时冻结的已发生会话前缀 */
  conversationSnapshotId: string;
  assetSnapshotId: string;
  policySnapshotId: string;
  input: BlobRef;
  budget: BudgetLimit;
  lineage?:
    | { kind: "reexecute"; sourceRunId: string }
    | { kind: "branch"; sourceRunId: string; checkpointId: string };
}

export interface RuntimeContext {
  runId: string;
  attemptId: string;
  leaseEpoch: number;
  workspaceId: string;
  /** 标识授权域，不携带密钥本体 */
  secretScopeId: string;
}

export interface RuntimeResult {
  state: "completed" | "failed" | "cancelled" | "reconciliation_required";
  reasonCode: string;
  outputRefs: BlobRef[];
}

export interface RuntimeCheckpoint {
  id: string;
  runId: string;
  atSeq: number;
  boundary: Boundary;
  adapterVersion: string;
  agentRevisionId: string;
  sourceManifestId: string;
  stateSchemaVersion: string;
  stateRef: BlobRef;
  workspaceSnapshotId: string;
  assetSnapshotId: string;
  pendingEffectIds: string[];
}

export interface AgentRuntimePort {
  readonly id: string;
  readonly adapterVersion: string;
  capabilities(): RuntimeCapabilities;
  start(
    spec: RunSpec,
    ctx: RuntimeContext,
    signal: AbortSignal,
  ): Promise<RuntimeResult>;
  resume(
    cp: RuntimeCheckpoint,
    ctx: RuntimeContext,
    signal: AbortSignal,
  ): Promise<RuntimeResult>;
}

/** 运行停止原因（参考循环的 reasonCode 词汇表） */
export type StopReasonCode =
  | "final_answer"
  | "policy_stop"
  | "budget_turns_exhausted"
  | "budget_model_calls_exhausted"
  | "budget_tool_calls_exhausted"
  | "budget_wall_time_exhausted"
  | "model_error"
  | "tool_denied_unrecoverable"
  | "cancelled"
  | "paused"
  | "context_overflow"
  | "policy_error";

export const DEFAULT_BUDGET: BudgetLimit = {
  maxTurns: 6,
  maxModelCalls: 6,
  maxToolCalls: 8,
  maxWallTimeMs: 180_000,
  maxInputTokens: 32_000,
  maxOutputTokens: 8_000,
  maxConcurrency: 2,
  maxDepth: 1,
};

export function isJsonValue(v: unknown): v is JsonValue {
  if (
    v === null ||
    typeof v === "boolean" ||
    typeof v === "number" ||
    typeof v === "string"
  ) {
    return true;
  }
  if (Array.isArray(v)) return v.every(isJsonValue);
  if (typeof v === "object") {
    return Object.values(v as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}
