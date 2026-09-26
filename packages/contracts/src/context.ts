/**
 * 上下文工程合同。依据设计文档 v1.1 第 10.3 节。
 */
import type { BlobRef } from "./runtime";

export type ContextItemKind =
  | "policy"
  | "task"
  | "message"
  | "tool_result"
  | "retrieval"
  | "wiki"
  | "memory"
  | "skill"
  | "tool_schema";

export type ContextTrust = "host" | "user" | "external";

export type ContextDecision =
  | "included"
  | "compressed"
  | "offloaded"
  | "irrelevant"
  | "budget_excluded"
  | "policy_excluded";

export interface ContextItem {
  id: string;
  kind: ContextItemKind;
  sourceRef: BlobRef;
  originId: string;
  originVersion: string;
  trust: ContextTrust;
  priority: number;
  atomicGroupId?: string;
  estimatedTokens: number;
  selected: boolean;
  decision: ContextDecision;
  transformedFromIds: string[];
  /** 人类可读的选入/排除原因（教学必须展示） */
  decisionReason?: string;
}

export interface CompiledContext {
  id: string;
  runId: string;
  callId: string;
  items: ContextItem[];
  messageBodyRef: BlobRef;
  estimatedInputTokens: number;
  outputReserveTokens: number;
  safetyReserveTokens: number;
  compilerVersion: string;
}

/** 预算约束：预计输入 + 输出预留 + 安全余量 ≤ 已知上下文上限 */
export interface TokenBudget {
  contextLimit: number;
  outputReserveTokens: number;
  safetyReserveTokens: number;
}
