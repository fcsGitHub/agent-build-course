/**
 * 规范教学事件合同。依据设计文档 v1.1 第 9.1 节。
 * type 必须属于版本化事件注册表（见 event-registry.ts）。
 */
import type { BlobRef, JsonValue } from "./runtime";

export interface SourceAnchor {
  manifestId: string;
  fileId: string;
  symbol: string;
  regionId: string;
  startLine: number;
  endLine: number;
}

export type DataClass = "public" | "course" | "private" | "restricted";

export interface TraceEvent {
  schemaVersion: 1;
  eventId: string;
  runId: string;
  /** 仅由持久化事务分配 */
  seq: number;
  /** 必须属于版本化事件注册表 */
  type: string;
  actorId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  causationEventIds: string[];
  emittedAt: string;
  monotonicOffsetMs?: number;
  conceptIds: string[];
  source?: SourceAnchor;
  dataClass: DataClass;
  /** 小且经过脱敏的结构性摘要，不复制原始大文本；大内容放 payloadRef 指向 blob */
  summary: { [key: string]: JsonValue };
  payloadRef?: BlobRef;
}

export const TRACE_EVENT_SCHEMA_VERSION = 1 as const;

/**
 * 版本化事件注册表。禁止未注册事件写入；注册表版本变更必须伴随迁移说明。
 */
export const EVENT_REGISTRY: Record<string, { dataClass: DataClass; description: string }> = {
  "run.created": { dataClass: "public", description: "运行创建" },
  "run.started": { dataClass: "public", description: "运行开始执行" },
  "run.state_changed": { dataClass: "public", description: "生命周期状态变更" },
  "run.pause_requested": { dataClass: "public", description: "请求在安全边界暂停" },
  "run.paused": { dataClass: "public", description: "已暂停" },
  "run.breakpoint_hit": { dataClass: "public", description: "断点命中（在指定边界/图节点驻留）" },
  "run.resumed": { dataClass: "public", description: "恢复执行" },
  "run.completed": { dataClass: "public", description: "运行完成" },
  "run.failed": { dataClass: "public", description: "运行失败" },
  "run.cancelled": { dataClass: "public", description: "运行取消" },
  "run.cancel_requested": { dataClass: "public", description: "请求取消" },
  "run.reconciliation_required": { dataClass: "public", description: "副作用待核对" },

  "input.accepted": { dataClass: "public", description: "输入被接纳并绑定运行" },

  "context.candidates_collected": { dataClass: "public", description: "候选上下文收集完成" },
  "context.compiled": { dataClass: "public", description: "上下文编译完成，含选入/排除原因" },
  "context.compacted": { dataClass: "public", description: "历史压缩，含丢失信息说明" },

  "model.request_prepared": { dataClass: "public", description: "模型请求已准备（含出站载荷证据）" },
  "model.request_dispatched": { dataClass: "public", description: "模型请求已真实发出" },
  "model.delta_batch": { dataClass: "public", description: "流式输出片段批次" },
  "model.response_completed": { dataClass: "public", description: "模型响应完成，含用量" },
  "model.request_failed": { dataClass: "public", description: "模型请求失败" },
  "model.request_cancelled": { dataClass: "public", description: "模型请求被取消" },
  "model.response_truncated": { dataClass: "public", description: "输出达到上限被截断" },

  "tool.proposed": { dataClass: "public", description: "模型提出工具请求（尚未执行）" },
  "tool.validated": { dataClass: "public", description: "工具参数通过校验" },
  "tool.denied": { dataClass: "public", description: "工具请求被拒绝" },
  "tool.call_completed": { dataClass: "public", description: "一次工具调用闭合（请求+结果）" },

  "effect.prepared": { dataClass: "public", description: "副作用意图已登记" },
  "effect.dispatched": { dataClass: "public", description: "副作用已派发" },
  "effect.succeeded": { dataClass: "public", description: "副作用确认成功" },
  "effect.failed": { dataClass: "public", description: "副作用确认失败" },
  "effect.unknown": { dataClass: "public", description: "副作用结果未知，需核对" },

  "approval.requested": { dataClass: "public", description: "请求具体能力审批" },
  "approval.granted": { dataClass: "public", description: "审批通过（绑定参数摘要）" },
  "approval.rejected": { dataClass: "public", description: "审批拒绝" },
  "approval.invalidated": { dataClass: "public", description: "既有审批失效" },

  "graph.node_started": { dataClass: "public", description: "图节点开始执行" },
  "graph.node_completed": { dataClass: "public", description: "图节点执行完成" },
  "skill.loaded": { dataClass: "public", description: "技能加载（元信息/正文）" },
  "agent.delegated": { dataClass: "public", description: "子任务委派（TaskEnvelope 摘要）" },
  "agent.handed_off": { dataClass: "public", description: "控制权移交" },
  "agent.result_received": { dataClass: "public", description: "子任务结果回收（含因果链）" },
  "reflection.recorded": { dataClass: "public", description: "失败反思记录（含反馈来源）" },
  "candidate.evaluated": { dataClass: "public", description: "演进候选评测结果" },
  "candidate.promoted": { dataClass: "public", description: "演进候选通过门控并晋级" },
  "candidate.rejected": { dataClass: "public", description: "演进候选被门控拒绝" },
  "mcp.protocol_event": { dataClass: "public", description: "MCP 协议消息（脱敏摘要）" },
  "mcp.server_connected": { dataClass: "public", description: "MCP server 连接并完成协商" },
  "mcp.server_closed": { dataClass: "public", description: "MCP server 连接关闭" },
  "a2a.agent_connected": { dataClass: "public", description: "A2A 远程 agent card 发现完成" },
  "recursion.node_started": { dataClass: "public", description: "递归节点开始（深度/分区绑定）" },
  "recursion.node_completed": { dataClass: "public", description: "递归节点完成（子调用用量）" },

  "rsi.generation_started": { dataClass: "public", description: "RSI 代开始（父代/候选变体绑定）" },
  "rsi.generation_completed": { dataClass: "public", description: "RSI 代完成（晋级决策与最优分数）" },
  "training.dataset_exported": { dataClass: "public", description: "训练数据集导出（synthetic 排除可见）" },
  "training.job_created": { dataClass: "public", description: "训练任务登记（无后端时诚实标记 unsupported）" },
  "hook.invoked": { dataClass: "public", description: "Harness hook 执行" },
  "hook.diff": { dataClass: "public", description: "Hook 修改了数据（含差异摘要）" },
  "task.progress_updated": { dataClass: "public", description: "长期任务进展工件更新" },

  "checkpoint.committed": { dataClass: "public", description: "检查点已提交" },
  "artifact.created": { dataClass: "public", description: "工件已创建" },
  "source.bound": { dataClass: "public", description: "源码清单已绑定" },
  "agent.revision_bound": { dataClass: "public", description: "运行绑定不可变代码版本" },

  "policy.stop_decision": { dataClass: "public", description: "循环继续/停止判定结果" },
  "policy.budget_reserved": { dataClass: "public", description: "预算预留" },
  "policy.budget_settled": { dataClass: "public", description: "预算结算" },
  "code.policy_invoked": { dataClass: "public", description: "学习者代码扩展点被调用" },
  "code.execution_failed": { dataClass: "public", description: "学习者代码执行失败（不可信诊断）" },
};

export function isRegisteredEventType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(EVENT_REGISTRY, type);
}
