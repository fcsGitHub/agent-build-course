/**
 * 工具注册与效果合同（T05）。依据设计文档 v1.1 第 5/8/18 节。
 */
import type { BlobRef, JsonValue } from "./runtime";

export type ToolRiskLevel =
  | "readonly_pure"
  | "workspace_write"
  | "command_browser"
  | "external_high_impact";

export interface ToolRevision {
  toolId: string;
  revision: string;
  title: string;
  description: string;
  riskLevel: ToolRiskLevel;
  /** JSON Schema（提供方 parameters 格式） */
  parametersSchema: JsonValue;
  /** 是否幂等（决定恢复策略） */
  idempotent: boolean;
  supportsStatusQuery: boolean;
}

export interface ToolExecutionContext {
  runId: string;
  workspaceRoot: string;
  /** 授权的工具 ID 集合（由课程白名单∩用户权限决定） */
  allowedToolIds: string[];
  deadlineAt: string;
  maxOutputBytes: number;
}

export interface ToolInvocation {
  toolId: string;
  revision: string;
  args: JsonValue;
  ctx: ToolExecutionContext;
  idempotencyKey: string;
}

export interface ToolExecutionResult {
  status: "succeeded" | "failed" | "denied";
  reasonCode?: string;
  outputRef?: BlobRef;
  /** 小型结构化输出摘要（进下一轮上下文） */
  outputSummary?: JsonValue;
  errorMessage?: string;
}

export interface ToolHandler {
  readonly revision: ToolRevision;
  execute(
    args: JsonValue,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}

export type EffectState =
  | "prepared"
  | "dispatched"
  | "succeeded"
  | "failed"
  | "unknown";

export interface EffectRecoveryInput {
  state: EffectState;
  idempotent: boolean;
  supportsStatusQuery: boolean;
}

export type RecoveryDecision =
  | "retry"
  | "query_status"
  | "manual_reconciliation"
  | "none";
