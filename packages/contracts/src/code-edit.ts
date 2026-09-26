/**
 * 受控代码编辑合同。依据设计文档 v1.1 第 19.6 节 code-edit.ts。
 * BlobRef / BudgetLimit 复用 runtime.ts，不另定义一套。
 */
import type { BlobRef } from "./runtime";

export type EditRegion =
  | { path: string; kind: "whole_file"; maxBytes: number }
  | { path: string; kind: "function_body"; symbol: string; maxBytes: number };

export interface LessonEditPolicy {
  id: string;
  digest: string;
  lessonVersion: string;
  runtimeId: string;
  regions: EditRegion[];
  allowedImports: string[];
  fixedContractDigest: string;
  maxChangedFiles: number;
  maxPatchBytes: number;
  toolchainDigest: string;
  safetyTestSuiteDigest: string;
  isolationProfileId: string;
}

export interface AgentDraft {
  id: string;
  ownerId: string;
  projectId: string;
  lessonVersion: string;
  baseAgentRevisionId: string;
  editPolicyDigest: string;
  revision: number;
  sourceDigest: string;
  patchRef: BlobRef;
}

export interface CodeValidationReport {
  id: string;
  draftId: string;
  draftRevision: number;
  sourceDigest: string;
  baseManifestId: string;
  editPolicyDigest: string;
  toolchainDigest: string;
  testSuiteDigest: string;
  bundleDigest?: string;
  safetyGates: Record<
    "scope" | "syntax" | "types" | "contracts" | "isolation",
    "passed" | "failed" | "not_run"
  >;
  learningChecks: Array<{
    id: string;
    status: "passed" | "failed" | "not_applicable" | "not_run";
    evidenceRef?: BlobRef;
  }>;
  previewAllowed: boolean;
  diagnosticsRef: BlobRef;
}

export interface AgentRevision {
  id: string;
  ownerId: string;
  projectId: string;
  lessonVersion: string;
  baseAgentRevisionId?: string;
  sourceManifestId: string;
  sourceDigest: string;
  bundleRef: BlobRef;
  editPolicyDigest: string;
  toolchainDigest: string;
  testSuiteDigest: string;
  validationReportId: string;
  author: { kind: "human" | "agent" | "course"; actorId: string };
  stateSchemaVersion: string;
  createdAt: string;
}
