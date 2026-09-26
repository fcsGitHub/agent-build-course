/**
 * 事务事件账本（T03）。同一事务提交状态变更（调用方负责）、事件与 outbox；
 * 服务端分配 seq；客户端按 (run_id, seq) 去重与补拉。
 * 依据设计文档 v1.1 第 9.1/9.2 节。
 */
import { randomUUID } from "node:crypto";
import type { Database } from "@agentglass/db";
import { nowIso } from "@agentglass/db";
import type {
  BlobRef,
  DataClass,
  SourceAnchor,
  TraceEvent,
} from "@agentglass/contracts";
import { isRegisteredEventType, TRACE_EVENT_SCHEMA_VERSION } from "@agentglass/contracts";

export interface NewTraceEvent {
  type: string;
  /** 缺省为 "agentglass-runtime" */
  actorId?: string;
  causationEventIds?: string[];
  conceptIds?: string[];
  source?: SourceAnchor;
  dataClass?: DataClass;
  summary: { [key: string]: unknown };
  payloadRef?: BlobRef;
  monotonicOffsetMs?: number;
  /** 不允许在 append 时伪造 eventId/seq；它们由本模块生成/分配 */
}

export class EventConflictError extends Error {
  constructor(
    public readonly code: "DUPLICATE_EVENT_ID" | "DUPLICATE_SEQ" | "UNREGISTERED_EVENT_TYPE",
    message: string,
  ) {
    super(message);
    this.name = "EventConflictError";
  }
}

export class EventStore {
  constructor(private readonly db: Database) {}

  /** 在打开的事务内追加事件。调用方负责 BEGIN/COMMIT 状态变更与事件同事务。 */
  append(runId: string, events: NewTraceEvent[]): TraceEvent[] {
    if (events.length === 0) return [];
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM trace_events WHERE run_id = ?")
      .get(runId) as { maxSeq: number };
    let seq = row.maxSeq;
    const traceId = `trace_${runId}`;
    const emittedAtBase = new Date().toISOString();
    const inserted: TraceEvent[] = [];
    for (const e of events) {
      if (!isRegisteredEventType(e.type)) {
        throw new EventConflictError(
          "UNREGISTERED_EVENT_TYPE",
          `事件类型未注册: ${e.type}`,
        );
      }
      seq += 1;
      const eventId = `evt_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const spanId = randomUUID().replace(/-/g, "").slice(0, 16);
      const event: TraceEvent = {
        schemaVersion: TRACE_EVENT_SCHEMA_VERSION,
        eventId,
        runId,
        seq,
        type: e.type,
        actorId: e.actorId ?? "agentglass-runtime",
        traceId,
        spanId,
        parentSpanId: undefined,
        causationEventIds: e.causationEventIds ?? [],
        emittedAt: emittedAtBase,
        monotonicOffsetMs: e.monotonicOffsetMs,
        conceptIds: e.conceptIds ?? [],
        source: e.source,
        dataClass: e.dataClass ?? "public",
        summary: sanitizeSummary(e.summary),
        payloadRef: e.payloadRef,
      };
      try {
        this.db
          .prepare(
            `INSERT INTO trace_events (
              event_id, run_id, seq, type, actor_id, trace_id, span_id, parent_span_id,
              causation_event_ids, emitted_at, monotonic_offset_ms, concept_ids,
              source_manifest_id, source_file_id, source_symbol, source_region_id,
              source_start_line, source_end_line, data_class, summary, payload_ref
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            event.eventId,
            event.runId,
            event.seq,
            event.type,
            event.actorId,
            event.traceId,
            event.spanId,
            event.parentSpanId ?? null,
            JSON.stringify(event.causationEventIds),
            event.emittedAt,
            event.monotonicOffsetMs ?? null,
            JSON.stringify(event.conceptIds),
            event.source?.manifestId ?? null,
            event.source?.fileId ?? null,
            event.source?.symbol ?? null,
            event.source?.regionId ?? null,
            event.source?.startLine ?? null,
            event.source?.endLine ?? null,
            event.dataClass,
            JSON.stringify(event.summary),
            event.payloadRef ? JSON.stringify(event.payloadRef) : null,
          );
        this.db
          .prepare(
            "INSERT INTO event_outbox (event_id, run_id, seq, published, created_at) VALUES (?, ?, ?, 0, ?)",
          )
          .run(event.eventId, runId, seq, nowIso());
      } catch (err) {
        const msg = String(err);
        if (msg.includes("UNIQUE")) {
          throw new EventConflictError(
            "DUPLICATE_SEQ",
            `(run_id, seq) 冲突: ${runId}#${seq}`,
          );
        }
        throw err;
      }
      inserted.push(event);
    }
    return inserted;
  }

  /**
   * 事务辅助：在单个事务中执行状态变更 + 事件追加。
   * node:sqlite 同步执行；异常时回滚。
   */
  transact<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  readAfter(runId: string, afterSeq: number, limit = 500): TraceEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM trace_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(runId, afterSeq, limit) as Row[];
    return rows.map(rowToEvent);
  }

  readRange(runId: string, fromSeq: number, toSeq: number): TraceEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM trace_events WHERE run_id = ? AND seq >= ? AND seq <= ? ORDER BY seq ASC`,
      )
      .all(runId, fromSeq, toSeq) as Row[];
    return rows.map(rowToEvent);
  }

  getEvent(eventId: string): TraceEvent | undefined {
    const row = this.db.prepare("SELECT * FROM trace_events WHERE event_id = ?").get(
      eventId,
    ) as Row | undefined;
    return row ? rowToEvent(row) : undefined;
  }

  maxSeq(runId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM trace_events WHERE run_id = ?")
      .get(runId) as { maxSeq: number };
    return row.maxSeq;
  }

  eventCount(runId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM trace_events WHERE run_id = ?")
      .get(runId) as { n: number };
    return row.n;
  }

  // ---- outbox ----

  claimUnpublished(limit = 1000): Array<{ eventId: string; runId: string; seq: number }> {
    const rows = this.db
      .prepare(
        `SELECT event_id, run_id, seq FROM event_outbox WHERE published = 0 ORDER BY created_at ASC LIMIT ?`,
      )
      .all(limit) as Array<{ event_id: string; run_id: string; seq: number }>;
    return rows.map((r) => ({ eventId: r.event_id, runId: r.run_id, seq: r.seq }));
  }

  markPublished(eventIds: string[]): void {
    const stmt = this.db.prepare("UPDATE event_outbox SET published = 1 WHERE event_id = ?");
    this.transact(() => {
      for (const id of eventIds) stmt.run(id);
    });
  }

  /**
   * 运行终态后其 outbox 行不再有实时投递意义（迟到的订阅者经 readAfter 直读事件表），
   * 标记为已发布以防 outbox 无界增长；unpublishedCount 因此只反映活动运行的真实积压。
   */
  markRunPublished(runId: string): void {
    this.db.prepare("UPDATE event_outbox SET published = 1 WHERE run_id = ? AND published = 0").run(runId);
  }

  unpublishedCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM event_outbox WHERE published = 0")
      .get() as { n: number };
    return row.n;
  }
}

type Row = Record<string, unknown>;

function rowToEvent(r: Row): TraceEvent {
  const payloadRefJson = r.payload_ref as string | null;
  const source =
    r.source_manifest_id != null
      ? {
          manifestId: r.source_manifest_id as string,
          fileId: r.source_file_id as string,
          symbol: r.source_symbol as string,
          regionId: r.source_region_id as string,
          startLine: r.source_start_line as number,
          endLine: r.source_end_line as number,
        }
      : undefined;
  return {
    schemaVersion: 1,
    eventId: r.event_id as string,
    runId: r.run_id as string,
    seq: r.seq as number,
    type: r.type as string,
    actorId: r.actor_id as string,
    traceId: r.trace_id as string,
    spanId: r.span_id as string,
    causationEventIds: JSON.parse((r.causation_event_ids as string) ?? "[]"),
    emittedAt: r.emitted_at as string,
    monotonicOffsetMs: (r.monotonic_offset_ms as number | null) ?? undefined,
    conceptIds: JSON.parse((r.concept_ids as string) ?? "[]"),
    source,
    dataClass: r.data_class as DataClass,
    summary: JSON.parse(r.summary as string),
    payloadRef: payloadRefJson ? JSON.parse(payloadRefJson) : undefined,
  };
}

/**
 * summary 只放小且脱敏的结构性摘要：剔除明显敏感键；长度超限的字符串值截断。
 * 原始大文本必须走 payloadRef blob，不得塞进 summary。
 */
const SENSITIVE_KEYS = /^(authorization|api[_-]?key|secret|token|password|cookie)$/i;
const MAX_SUMMARY_VALUE = 2048;

export function sanitizeSummary(summary: { [key: string]: unknown }): {
  [key: string]: import("@agentglass/contracts").JsonValue;
} {
  const out: { [key: string]: import("@agentglass/contracts").JsonValue } = {};
  for (const [k, v] of Object.entries(summary)) {
    if (SENSITIVE_KEYS.test(k)) {
      out[k] = "[REDACTED]";
      continue;
    }
    out[k] = truncateValue(v) as import("@agentglass/contracts").JsonValue;
  }
  return out;
}

function truncateValue(v: unknown): unknown {
  if (typeof v === "string") {
    return v.length > MAX_SUMMARY_VALUE ? v.slice(0, MAX_SUMMARY_VALUE) + "…[TRUNCATED]" : v;
  }
  if (Array.isArray(v)) {
    return v.length > 64
      ? [...v.slice(0, 64).map(truncateValue), "…[TRUNCATED]"]
      : v.map(truncateValue);
  }
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length > 64) {
      const trimmed = Object.fromEntries(
        entries.slice(0, 64).map(([k, val]) => [k, truncateValue(val)]),
      );
      trimmed["…"] = "[TRUNCATED]";
      return trimmed;
    }
    return Object.fromEntries(entries.map(([k, val]) => [k, truncateValue(val)]));
  }
  return v;
}
