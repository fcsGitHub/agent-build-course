/**
 * 会话与输入提交合同。依据设计文档 v1.1 第 19.6 节 conversation.ts。
 */
import type { BlobRef, BudgetLimit } from "./runtime";

export type InputOrigin =
  | "interactive"
  | "case_hint"
  | "explicit_reuse"
  | "batch_eval"
  | "capability_probe"
  | "live_test"
  | "simulated_user";

export interface InputSubmission {
  id: string;
  sessionId: string;
  clientMessageId: string;
  submittedBy: string;
  origin: InputOrigin;
  submittedAt: string;
  userConfirmedAt?: string;
  caseHintId?: string;
  caseHintRevision?: string;
  contentRef: BlobRef;
  attachmentRefs: BlobRef[];
  lessonVersion: string;
  agentRevisionId: string;
  runtimeSnapshotId: string;
  modelProfileSnapshotId: string;
  assetSnapshotId: string;
  policySnapshotId: string;
  budget: BudgetLimit;
  status: "queued" | "accepted" | "cancelled" | "replaced";
  replacesSubmissionId?: string;
  acceptedRunId?: string;
}

/** 前 3 类来源必须经过用户明确提交；其他来源只允许对应已授权服务入口创建 */
export const USER_CONFIRMED_ORIGINS: readonly InputOrigin[] = [
  "interactive",
  "case_hint",
  "explicit_reuse",
];
