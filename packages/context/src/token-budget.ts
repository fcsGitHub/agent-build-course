/**
 * token 估算与预算内选择（T13）。用例 5：同 atomicGroupId 的条目必须整体选择或整体排除。
 * 依据设计文档 v1.1 第 10.2/10.4 节。
 */
import type { ContextItem, TokenBudget } from "@agentglass/contracts";

/**
 * 保守 token 估算：CJK 字符约 1.5 字符/token（估 0.75 token/字），其他约 4 字符/token。
 * tokenizer 与模型不完全匹配时保持保守（宁可高估）。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 0.75 + other / 4) + 1;
}

export interface BudgetSelectResult {
  selected: ContextItem[];
  /** 全部候选（含未选中的 decision 标注） */
  all: ContextItem[];
  estimatedInputTokens: number;
  /** 存在无法安全排除的未闭合工具事务时为 false，调用方必须停止并报告 */
  constructible: boolean;
  failureReason?: string;
}

/**
 * 预算约束：预计输入 + 输出预留 + 安全余量 ≤ 上下文上限。
 * 候选按 priority 降序（同优先级按给定顺序稳定排序）；原子组以组为单位竞争。
 */
export function selectWithinBudget(
  items: ContextItem[],
  budget: TokenBudget,
): BudgetSelectResult {
  const headroom =
    budget.contextLimit - budget.outputReserveTokens - budget.safetyReserveTokens;
  const all = items.map((i) => ({ ...i }));

  // 分组：原子组 vs 独立项
  const groups = new Map<string, ContextItem[]>();
  const singles: ContextItem[] = [];
  for (const item of all) {
    if (item.atomicGroupId) {
      const g = groups.get(item.atomicGroupId) ?? [];
      g.push(item);
      groups.set(item.atomicGroupId, g);
    } else {
      singles.push(item);
    }
  }
  // 组代表：取组内最高优先级，成本为整组之和
  interface Candidate {
    items: ContextItem[];
    priority: number;
    tokens: number;
    id: string;
  }
  const candidates: Candidate[] = [];
  for (const [groupId, groupItems] of groups) {
    candidates.push({
      id: groupId,
      items: groupItems,
      priority: Math.max(...groupItems.map((i) => i.priority)),
      tokens: groupItems.reduce((s, i) => s + i.estimatedTokens, 0),
    });
  }
  for (const item of singles) {
    candidates.push({ id: item.id, items: [item], priority: item.priority, tokens: item.estimatedTokens });
  }

  // 未闭合工具事务组：assistant(tool_calls) 存在但缺配对结果 → 宿主规则强制保留
  for (const groupItems of groups.values()) {
    const hasCallMessage = groupItems.some(
      (i) => i.kind === "message" && i.atomicGroupId != null,
    );
    const hasResult = groupItems.some((i) => i.kind === "tool_result");
    if (hasCallMessage && !hasResult) {
      for (const gi of groupItems) {
        gi.selected = true;
        gi.decision = "included";
        gi.decisionReason = "未闭合工具事务必须保留（协议要求），不可拆开";
      }
    }
  }

  // 稳定排序：priority 降序，原始顺序保持
  candidates.sort((a, b) => b.priority - a.priority);

  let used = 0;
  const selectedIds = new Set<string>();
  for (const cand of candidates) {
    // 已被规则强制选中的组
    if (cand.items.every((i) => i.selected)) {
      used += cand.tokens;
      for (const i of cand.items) selectedIds.add(i.id);
      continue;
    }
    if (used + cand.tokens <= headroom) {
      used += cand.tokens;
      for (const i of cand.items) {
        i.selected = true;
        i.decision = "included";
        i.decisionReason = i.decisionReason ?? "预算内按优先级选入";
      }
      for (const i of cand.items) selectedIds.add(i.id);
    }
  }

  // 未选中的原因标注
  for (const cand of candidates) {
    if (cand.items.every((i) => i.selected)) continue;
    for (const i of cand.items) {
      if (i.selected) continue;
      if (cand.tokens > headroom) {
        i.decision = "budget_excluded";
        i.decisionReason = `整组 ${cand.tokens} token 超过预算余量 ${headroom}`;
      } else {
        i.decision = "budget_excluded";
        i.decisionReason = `预算不足：已用 ${used} + 本组 ${cand.tokens} > 余量 ${headroom}`;
      }
    }
  }

  // 原子组内不一致视为缺陷（防御性断言）
  for (const groupItems of groups.values()) {
    const states = new Set(groupItems.map((i) => i.selected));
    if (states.size > 1) {
      return {
        selected: [],
        all,
        estimatedInputTokens: 0,
        constructible: false,
        failureReason: `原子组 ${[...groupItems][0]!.atomicGroupId} 选择状态不一致（编译器缺陷）`,
      };
    }
  }

  const selected = all.filter((i) => i.selected);
  const estimatedInputTokens = used;
  return {
    selected,
    all,
    estimatedInputTokens,
    constructible: true,
  };
}
