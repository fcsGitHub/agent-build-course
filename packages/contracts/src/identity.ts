/**
 * 身份与作用域合同（T02，本地单用户模式简化实现）。
 * 依据设计文档 v1.1 第 20.3 节：简洁身份模型 learner / instructor / admin。
 */

export type BusinessRole = "learner" | "instructor" | "admin";

export interface IdentityContext {
  userId: string;
  projectId: string;
  role: BusinessRole;
  /** 本地模式为 local；多人课堂版接入正式身份认证后为 "session" 等 */
  authKind: "local" | "session";
}

export const LOCAL_IDENTITY: IdentityContext = {
  userId: "local-learner",
  projectId: "local-project",
  role: "learner",
  authKind: "local",
};

export function identityFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): IdentityContext {
  // 本地模式：固定单用户身份；多人版在此接入认证（不要求学习者手填 run id / token）
  void headers;
  return { ...LOCAL_IDENTITY };
}
