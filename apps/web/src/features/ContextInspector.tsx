/**
 * 上下文检视器（观察区 · 上下文 页签）：
 * 把「模型在第 N 轮到底看到了什么」做成一等公民——
 * ① 调用切换条（每轮一 chip，含输入估算）；② 组成条（系统/工具定义/对话/工具结果的
 * token 占比，来自逐项决策 itemDecisions，缺省时按字符估算降级并如实标注）；
 * ③ 完整消息列表（角色着色、长文折叠、markdown 渲染、tool_calls 结构化展示）；
 * ④ 未选入清单（排除原因逐条列出，教学核心证据）。
 */
import { useEffect, useMemo, useState } from "react";
import { api, type ContextMessageDto, type ItemDecisionDto, type TraceEvent } from "../api";
import { Markdown } from "../markdown";

interface ContextDetail {
  callId: string;
  messages: ContextMessageDto[];
  tools?: unknown[];
  itemDecisions: ItemDecisionDto[] | null;
  estimatedInputTokens: number | null;
}

/** 观察区顶部的回合切换条（也供实验台其他位置复用） */
export function CallStrip(props: {
  compilations: TraceEvent[];
  selectedCallId: string | null;
  onSelect: (callId: string) => void;
}) {
  if (props.compilations.length === 0) return null;
  return (
    <div className="call-strip">
      {props.compilations.map((c, i) => {
        const callId = String(c.summary.compiledContextId ?? "");
        const tokens = Number(c.summary.estimatedInputTokens ?? 0);
        return (
          <button
            key={c.eventId}
            className={`call-chip ${props.selectedCallId === callId ? "active" : ""}`}
            title={`事件 #${c.seq} · 选入 ${String(c.summary.included)} / 排除 ${String(c.summary.excluded)}`}
            onClick={() => props.onSelect(callId)}
          >
            <span className="call-chip-no">第 {i + 1} 轮</span>
            <span className="call-chip-tokens">{formatTokens(tokens)}</span>
          </button>
        );
      })}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1000) return `~${(n / 1000).toFixed(1)}k tok`;
  return `~${n} tok`;
}

const KIND_META: Record<string, { label: string; cls: string }> = {
  policy: { label: "系统提示", cls: "seg-policy" },
  tool_schema: { label: "工具定义", cls: "seg-schema" },
  task: { label: "任务", cls: "seg-task" },
  message: { label: "对话消息", cls: "seg-message" },
  tool_result: { label: "工具结果", cls: "seg-result" },
  retrieval: { label: "检索", cls: "seg-knowledge" },
  wiki: { label: "Wiki", cls: "seg-knowledge" },
  memory: { label: "记忆", cls: "seg-knowledge" },
  skill: { label: "技能", cls: "seg-knowledge" },
};

interface Segment {
  label: string;
  cls: string;
  tokens: number;
}

function segmentsFromDecisions(decisions: ItemDecisionDto[]): Segment[] {
  const acc = new Map<string, Segment>();
  for (const d of decisions) {
    if (!d.selected) continue;
    const meta = KIND_META[d.kind] ?? { label: d.kind, cls: "seg-message" };
    const seg = acc.get(meta.label) ?? { label: meta.label, cls: meta.cls, tokens: 0 };
    seg.tokens += d.estimatedTokens;
    acc.set(meta.label, seg);
  }
  return [...acc.values()].filter((s) => s.tokens > 0);
}

/** 降级：无逐项决策（旧运行）时按消息字符数 /4 估算 */
function segmentsFromMessages(messages: ContextMessageDto[], tools: unknown[] | undefined): Segment[] {
  const est = (chars: number): number => Math.ceil(chars / 4);
  const segs: Segment[] = [];
  const sysChars = messages.filter((m) => m.role === "system").reduce((n, m) => n + (m.content ?? "").length, 0);
  if (sysChars > 0) segs.push({ label: "系统提示", cls: "seg-policy", tokens: est(sysChars) });
  if (tools && tools.length > 0) segs.push({ label: "工具定义", cls: "seg-schema", tokens: est(JSON.stringify(tools).length) });
  const convChars = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .reduce((n, m) => n + (m.content ?? "").length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
  if (convChars > 0) segs.push({ label: "对话消息", cls: "seg-message", tokens: est(convChars) });
  const toolChars = messages.filter((m) => m.role === "tool").reduce((n, m) => n + (m.content ?? "").length, 0);
  if (toolChars > 0) segs.push({ label: "工具结果", cls: "seg-result", tokens: est(toolChars) });
  return segs;
}

function MessageCard(props: { message: ContextMessageDto; index: number }) {
  const m = props.message;
  const [expanded, setExpanded] = useState(false);
  const text = m.content ?? "";
  const long = text.length > 900;
  const shown = !long || expanded ? text : `${text.slice(0, 900)}…`;
  return (
    <div className={`ctx-card role-${m.role}`}>
      <div className="ctx-card-head">
        <span className={`ctx-role-badge role-${m.role}`}>{roleLabel(m)}</span>
        <span className="ctx-card-meta muted small">
          {text.length > 0 ? `${text.length} 字符` : ""}
          {m.tool_calls ? ` · ${m.tool_calls.length} 个工具调用` : ""}
        </span>
      </div>
      {text.length > 0 && (
        <div className="ctx-card-body">
          {m.role === "user" || m.role === "assistant" ? (
            <Markdown text={shown} />
          ) : (
            <pre className="ctx-raw">{shown}</pre>
          )}
          {long && (
            <button className="link" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "收起" : `展开全部（${text.length} 字符）`}
            </button>
          )}
        </div>
      )}
      {m.tool_calls && (
        <div className="ctx-toolcalls">
          {m.tool_calls.map((tc) => (
            <div key={tc.id} className="ctx-toolcall">
              <span className="ctx-toolcall-name">⚙ {tc.function.name}</span>
              <pre className="ctx-raw">{prettyArgs(tc.function.arguments)}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function roleLabel(m: ContextMessageDto): string {
  if (m.role === "tool") return `tool · ${m.tool_call_id ?? "结果"}`;
  return m.role;
}

function prettyArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function ContextInspector(props: {
  events: TraceEvent[];
  runId: string | null;
  systemPrompt: string;
  focusCallId?: string | null;
  onFocusConsumed?: () => void;
}) {
  const { events, runId, systemPrompt, focusCallId, onFocusConsumed } = props;
  const compilations = useMemo(() => events.filter((e) => e.type === "context.compiled"), [events]);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ContextDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSystem, setShowSystem] = useState(false);
  const [copied, setCopied] = useState(false);

  // 默认跟随最新一轮（运行中实时滚到最新组装）；用户手动选择后不再强制跟随
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    if (!pinned && compilations.length > 0) {
      setSelectedCallId(String(compilations.at(-1)!.summary.compiledContextId ?? ""));
    }
  }, [compilations, pinned]);

  // 外部深链（如「查看此刻上下文组装」）
  useEffect(() => {
    if (focusCallId) {
      setSelectedCallId(focusCallId);
      setPinned(true);
      onFocusConsumed?.();
    }
  }, [focusCallId, onFocusConsumed]);

  useEffect(() => {
    if (!runId || !selectedCallId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .runContext(runId, selectedCallId)
      .then((res) => {
        if (cancelled) return;
        setDetail({
          callId: res.callId,
          messages: res.items?.messages ?? [],
          tools: res.items?.tools,
          itemDecisions: res.itemDecisions ?? null,
          estimatedInputTokens: res.estimatedInputTokens,
        });
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, selectedCallId]);

  const segments = useMemo(() => {
    if (!detail) return [];
    if (detail.itemDecisions) return segmentsFromDecisions(detail.itemDecisions);
    return segmentsFromMessages(detail.messages, detail.tools);
  }, [detail]);
  const totalTokens = segments.reduce((n, s) => n + s.tokens, 0);
  const excluded = useMemo(() => (detail?.itemDecisions ?? []).filter((d) => !d.selected), [detail]);

  const copyAll = async (): Promise<void> => {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify({ messages: detail.messages, tools: detail.tools }, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* 剪贴板不可用 */
    }
  };

  if (compilations.length === 0) {
    return (
      <div className="ctx-empty">
        <p className="muted">运行后，这里逐轮展示模型实际收到的完整上下文（第四层证据：模型可见上下文）。</p>
        <p className="muted small">每一轮模型调用前，上下文编译器会从候选池按预算选入/排除条目——选入理由与排除原因都会在这里展开。</p>
      </div>
    );
  }

  return (
    <div className="ctx-inspector">
      <CallStrip
        compilations={compilations}
        selectedCallId={selectedCallId}
        onSelect={(id) => {
          setPinned(true);
          setSelectedCallId(id);
        }}
      />
      {loading && <p className="muted small">读取上下文工件…</p>}
      {detail && (
        <>
          <div className="ctx-summary">
            <div className="ctx-bar" role="img" aria-label="上下文组成">
              {segments.map((s) => (
                <div
                  key={s.label}
                  className={`ctx-bar-seg ${s.cls}`}
                  style={{ width: `${Math.max(2.5, (s.tokens / Math.max(1, totalTokens)) * 100)}%` }}
                  title={`${s.label} · ~${s.tokens} tok`}
                />
              ))}
            </div>
            <div className="ctx-bar-legend">
              {segments.map((s) => (
                <span key={s.label} className="ctx-legend-item">
                  <span className={`ctx-legend-dot ${s.cls}`} />
                  {s.label} {formatTokens(s.tokens)}
                </span>
              ))}
              <span className="spacer" />
              <span className="muted small">
                输入估算 {detail.estimatedInputTokens != null ? `~${detail.estimatedInputTokens}` : `~${totalTokens}`} tok
                {detail.itemDecisions ? "" : "（按字符估算）"}
              </span>
              <button className="link" onClick={() => void copyAll()}>{copied ? "✓ 已复制 JSON" : "复制完整 JSON"}</button>
            </div>
          </div>

          <div className="ctx-messages">
            {detail.messages.map((m, i) => (
              <MessageCard key={i} message={m} index={i} />
            ))}
            {detail.tools && detail.tools.length > 0 && (
              <details className="ctx-tools-def">
                <summary>工具定义（{detail.tools.length} 个，随请求发送的 schema）</summary>
                <pre className="ctx-raw">{JSON.stringify(detail.tools, null, 2).slice(0, 4000)}</pre>
              </details>
            )}
          </div>

          {excluded.length > 0 && (
            <div className="ctx-excluded">
              <div className="tool-sec">未选入（{excluded.length}）—— 预算/策略把它们挡在了模型视野之外</div>
              {excluded.map((d) => (
                <div key={d.id} className="ctx-excluded-row">
                  <span className={`ctx-kind cls-${d.kind}`}>{KIND_META[d.kind]?.label ?? d.kind}</span>
                  <span className="ctx-excluded-id mono" title={d.id}>{d.id.length > 26 ? `${d.id.slice(0, 26)}…` : d.id}</span>
                  <span className="ctx-excluded-tokens muted">{formatTokens(d.estimatedTokens)}</span>
                  <span className="ctx-excluded-reason">{d.decisionReason ?? d.decision}</span>
                </div>
              ))}
            </div>
          )}

          <div className="prompt-sys">
            <button className="link" onClick={() => setShowSystem((s) => !s)}>
              {showSystem ? "隐藏" : "查看"}课程 system prompt（服务端资产原文）
            </button>
            {showSystem && <pre className="prompt-sys-body">{systemPrompt || "（未声明）"}</pre>}
          </div>
        </>
      )}
    </div>
  );
}
