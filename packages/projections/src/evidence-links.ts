/**
 * 事件→证据联动（T09 后端部分）。规范关联键：
 * concept_id ↔ source.region_id ↔ graph.node_id ↔ event_id ↔ context_item_id。
 * 无映射时明确返回缺口，不让前端从自然语言猜测。
 */
import type { TraceEvent } from "@agentglass/contracts";

export interface EvidenceLink {
  eventId: string;
  seq: number;
  conceptIds: string[];
  source?: {
    manifestId: string;
    fileId: string;
    symbol: string;
    regionId: string;
    startLine: number;
    endLine: number;
  };
  payloadBlobId?: string;
  nextContextSeq?: number;
  modelCallSeq?: number;
}

/** 为一个事件构建联动证据；缺失维度显式标记 */
export function buildEvidenceLink(
  event: TraceEvent,
  allEvents: TraceEvent[],
): EvidenceLink {
  const link: EvidenceLink = {
    eventId: event.eventId,
    seq: event.seq,
    conceptIds: event.conceptIds,
    source: event.source,
    payloadBlobId: event.payloadRef?.id,
  };
  // 该事件之后的下一次上下文编译（工具结果何时进入哪次模型请求）
  if (event.type === "tool.call_completed") {
    const next = allEvents.find((e) => e.seq > event.seq && e.type === "context.compiled");
    if (next) link.nextContextSeq = next.seq;
  }
  if (event.type === "context.compiled") {
    const next = allEvents.find((e) => e.seq > event.seq && e.type === "model.request_prepared");
    if (next) link.modelCallSeq = next.seq;
  }
  return link;
}

/** 概念 → 事件索引 */
export function eventsByConcept(events: TraceEvent[], conceptId: string): TraceEvent[] {
  return events.filter((e) => e.conceptIds.includes(conceptId));
}
