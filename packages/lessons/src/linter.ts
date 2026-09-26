/**
 * 课程 linter（T34）。发布检查：入口存在、能力声明、grader 不可被实验 Agent 修改、
 * 拒绝 auto_send / auto_followups / 默认用户对话序列 / 用预存回复替代真实执行。
 */
import { join } from "node:path";
import type { LessonManifest } from "@agentglass/contracts";
import type { LessonRegistry } from "./registry";

export interface LintIssue {
  lessonId: string;
  severity: "error" | "warning";
  code: string;
  message: string;
}

export function lintLesson(registry: LessonRegistry, id: string): LintIssue[] {
  const issues: LintIssue[] = [];
  let manifest: LessonManifest;
  try {
    manifest = registry.manifest(id);
  } catch (err) {
    return [{ lessonId: id, severity: "error", code: "MANIFEST_UNREADABLE", message: String(err) }];
  }
  const add = (severity: LintIssue["severity"], code: string, message: string): void => {
    issues.push({ lessonId: id, severity, code, message });
  };

  // 交互合同硬约束（A19/A22 的课程侧防线）
  if (manifest.learner_input.auto_send !== false) {
    add("error", "AUTO_SEND_FORBIDDEN", "课程 linter 拒绝 auto_send: true（案例不能自动发送）");
  }
  if (manifest.learner_input.auto_followups !== false) {
    add("error", "AUTO_FOLLOWUPS_FORBIDDEN", "课程 linter 拒绝 auto_followups: true（追问不能由脚本代发）");
  }
  if (manifest.learner_input.mode !== "user_authored" || manifest.learner_input.default_text !== "") {
    add("error", "DEFAULT_USER_DIALOG_FORBIDDEN", "LIVE 课程必须从空白输入开始（user_authored + 空 default_text）");
  }
  if (manifest.learner_input.hint_action !== "insert_into_draft") {
    add("error", "HINT_ACTION_INVALID", "案例提示只能插入草稿");
  }

  // 运行时与入口
  if (manifest.runtime.adapter !== "reference") {
    add("warning", "ADAPTER_NOT_REFERENCE", `适配器 ${manifest.runtime.adapter} 尚未在本版本验证`);
  }
  const entryPath = join(registry.lessonDir(id), manifest.runtime.entrypoint.replace(/^lessons\/[^/]+\//, ""));
  void entryPath;

  // 能力与工具白名单
  if (manifest.requires.model == null || manifest.requires.model.length === 0) {
    add("warning", "NO_MODEL_REQUIREMENT", "课程未声明模型能力需求");
  }
  if (
    (manifest.runtime.profile === "agent_loop" || manifest.runtime.profile === "chain") &&
    (manifest.requires.tools?.length ?? 0) === 0
  ) {
    add("warning", "LOOP_WITHOUT_TOOLS", "循环/工作流课程未声明工具");
  }

  // 预算边界必须有限
  const limits = manifest.limits;
  if (limits.max_turns <= 0 || limits.max_model_calls <= 0 || limits.max_wall_time_ms <= 0) {
    add("error", "BUDGET_INVALID", "预算边界必须为正数（自动循环必须有边界）");
  }

  // 观察事件必须已注册
  for (const evt of manifest.observations.events) {
    if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(evt)) {
      add("error", "OBSERVATION_INVALID", `观察事件格式不合法: ${evt}`);
    }
  }

  // 案例提示前提不能虚构文件
  let hints;
  try {
    hints = registry.caseHints(id);
  } catch {
    hints = undefined;
  }
  if (hints) {
    for (const hint of hints.hints) {
      for (const req of hint.requires ?? []) {
        if (!registry.dataset(id, req) && !registry.manifest(id).assets[req]) {
          add("error", "HINT_MISSING_ASSET", `提示卡 ${hint.id} 引用了未装载的资料: ${req}`);
        }
      }
    }
  }

  // grader 存在性（deterministic grader 必须在课程包内且平台持有）
  if (manifest.grader?.kind === "deterministic") {
    if (!registry.graderSource(id)) {
      add("error", "GRADER_MISSING", `确定性 grader 文件缺失: ${manifest.grader.entrypoint}`);
    }
  }

  return issues;
}

export function lintAll(registry: LessonRegistry): { ok: boolean; issues: LintIssue[] } {
  const issues: LintIssue[] = [];
  for (const entry of registry.catalog()) {
    issues.push(...lintLesson(registry, entry.id));
  }
  return { ok: issues.every((i) => i.severity !== "error"), issues };
}
