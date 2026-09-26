/**
 * 效果账本接口（T05/T11）。prepared → dispatched → succeeded/failed/unknown。
 * DB 实现由 worker 提供；测试可用内存实现。
 */
import type { EffectState } from "@agentglass/contracts";

export interface EffectIntentRecord {
  id: string;
  runId: string;
  idempotencyKey: string;
  toolRevision: string;
  argsDigest: string;
}

export interface EffectLedger {
  prepare(intent: Omit<EffectIntentRecord, "id">): string;
  dispatch(intentId: string): void;
  mark(intentId: string, state: Extract<EffectState, "succeeded" | "failed">, reasonCode?: string, detail?: string): void;
  markUnknown(intentId: string, reason: string): void;
}

export function decideRecovery(input: {
  state: EffectState;
  idempotent: boolean;
  supportsStatusQuery: boolean;
}): "retry" | "query_status" | "manual_reconciliation" | "none" {
  if (input.state === "succeeded" || input.state === "failed") return "none";
  if (input.state === "prepared") {
    // 从未派发：安全重试（尚无外部副作用）
    return "retry";
  }
  // dispatched 且结果不明
  if (input.idempotent) return "retry";
  if (input.supportsStatusQuery) return "query_status";
  return "manual_reconciliation";
}
