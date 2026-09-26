/**
 * 技能工具（T18 工具面）。
 * list_skills：第一层元信息；load_skill：第二层正文（每次加载由宿主产生 skill.loaded 事件）。
 * 脚本执行面不提供工具——脚本需要独立能力授权，默认关闭（诚实返回不可用）。
 */
import type { JsonValue, ToolExecutionResult, ToolHandler } from "@agentglass/contracts";
import type { SkillRegistry } from "@agentglass/skills";

export interface SkillToolDeps {
  registry: SkillRegistry;
  /** 本课程允许的技能白名单（来自课程 manifest） */
  allowedSlugs: string[];
  /** 加载事件回调（worker 桥接到事件账本） */
  onLoaded?: (slug: string, version: string, chars: number) => void;
}

export function skillToolHandlers(deps: SkillToolDeps): ToolHandler[] {
  const listSkills: ToolHandler = {
    revision: {
      toolId: "list_skills",
      revision: "1.0.0",
      title: "列出可用技能",
      description: "列出本课程可用的技能元信息（名称/描述/版本；不含正文）。",
      riskLevel: "readonly_pure",
      parametersSchema: { type: "object", properties: {} },
      idempotent: true,
      supportsStatusQuery: false,
    },
    async execute(): Promise<ToolExecutionResult> {
      const meta = deps.registry.listMeta(deps.allowedSlugs.length > 0 ? deps.allowedSlugs : undefined) as unknown as JsonValue;
      return { status: "succeeded", outputSummary: { skills: meta, count: Array.isArray(meta) ? meta.length : 0 } };
    },
  };

  const loadSkill: ToolHandler = {
    revision: {
      toolId: "load_skill",
      revision: "1.0.0",
      title: "加载技能正文",
      description: "加载指定技能的正文（SKILL.md body）到上下文；脚本不会执行。",
      riskLevel: "readonly_pure",
      parametersSchema: {
        type: "object",
        properties: { slug: { type: "string" } },
        required: ["slug"],
      },
      idempotent: true,
      supportsStatusQuery: false,
    },
    async execute(args): Promise<ToolExecutionResult> {
      const a = args as { slug?: unknown };
      if (typeof a.slug !== "string") {
        return { status: "failed", reasonCode: "INVALID_ARGUMENTS", errorMessage: "slug 必填" };
      }
      if (deps.allowedSlugs.length > 0 && !deps.allowedSlugs.includes(a.slug)) {
        return {
          status: "denied",
          reasonCode: "SKILL_NOT_ALLOWED",
          errorMessage: `技能 ${a.slug} 不在本课程白名单内（安装 ≠ 授权）`,
        };
      }
      try {
        const { body, version } = deps.registry.loadBody(a.slug);
        deps.onLoaded?.(a.slug, version, body.length);
        const summary: JsonValue = {
          slug: a.slug,
          version,
          body: body.slice(0, 2400),
          note: "技能正文进入上下文；脚本未授权不执行",
        };
        return { status: "succeeded", outputSummary: summary };
      } catch (err) {
        return { status: "failed", reasonCode: "SKILL_LOAD_FAILED", errorMessage: String(err).slice(0, 200) };
      }
    },
  };

  return [listSkills, loadSkill];
}
