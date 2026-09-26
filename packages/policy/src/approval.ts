/**
 * 审批绑定（用例 3；设计文档 v1.1 第 13.4 节）。
 * 审批对象是具体能力申请：谁、在哪个 run、以哪个工具版本、用哪些参数、对哪个目标。
 * 参数按稳定、类型保真的规范序列化后计算绑定摘要。
 */
import { createHash } from "node:crypto";

export interface ApprovalRequestSpec {
  actorId: string;
  runId: string;
  toolRevision: string;
  args: Record<string, unknown>;
  policyRevision: string;
  target: string;
  expiresAt: string;
}

export interface BoundApproval extends ApprovalRequestSpec {
  argsDigest: string;
  bindingDigest: string;
}

/** 稳定 JSON 序列化：键排序，类型保真（不把 undefined 与 null 混同） */
export function stableStringify(value: unknown): string {
  return stableStringifyInner(value);
}

function stableStringifyInner(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "undefined") return '"__undefined__"';
  if (Array.isArray(value)) {
    return `[${value.map(stableStringifyInner).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringifyInner(v)}`).join(",")}}`;
  }
  return '"__unsupported__"';
}

export function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function bindApproval(spec: ApprovalRequestSpec): BoundApproval {
  const argsDigest = digest(spec.args);
  const bindingDigest = digest({
    actorId: spec.actorId,
    runId: spec.runId,
    toolRevision: spec.toolRevision,
    argsDigest,
    policyRevision: spec.policyRevision,
    target: spec.target,
  });
  return { ...spec, argsDigest, bindingDigest };
}

export interface RequestedEffect {
  actorId: string;
  runId: string;
  toolRevision: string;
  args: Record<string, unknown>;
  policyRevision: string;
  target: string;
}

/**
 * isApprovalValid：任一绑定要素变化（参数、目标、工具版本、run、策略、用户）即失效；
 * 过期同样失效。撤销/运行状态检查由 ApprovalService 补充（本函数只做绑定判定）。
 */
export function isApprovalValid(
  approval: BoundApproval,
  requested: RequestedEffect,
  now: string,
): boolean {
  if (new Date(approval.expiresAt).getTime() <= new Date(now).getTime()) return false;
  const rebound = bindApproval({
    actorId: requested.actorId,
    runId: requested.runId,
    toolRevision: requested.toolRevision,
    args: requested.args,
    policyRevision: requested.policyRevision,
    target: requested.target,
    expiresAt: approval.expiresAt,
  });
  return rebound.bindingDigest === approval.bindingDigest;
}
