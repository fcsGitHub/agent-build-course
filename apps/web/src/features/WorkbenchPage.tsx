/**
 * 实验台（双分区，左右并排）：
 * - 左：对话区 —— 流式对话流。事件账本（SSE 主通道 + 轮询兜底）经 deriveRun 投影为
 *   「回合」序列：每回合 = 一次模型调用（上下文组装 → 流式输出 → 工具调用），
 *   回合头可一键深链到该轮的上下文检视。多次输入在同一对话流中累积（每次输入一次运行）。
 * - 右：观察区 —— 架构 / 信息流 / 代码 / 上下文 / 运行 五个页签。架构与信息流为真实
 *   SVG 框图（manifest 为真相源；事件驱动点亮与信息包动画）。运行中可随时暂停/停止；
 *   暂停横幅一键查看此刻上下文组装；「单步」= turn_end 断点，每回合驻留。
 * 边界：代码草稿独立于活动运行，版本不可变；打开课程零模型调用。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type CaseHint, type InputDto, type LessonManifestDto, type TraceEvent } from "../api";
import { deriveRun, missingBlobs, type RunDerived } from "../derive";
import { ChatScroll, RunTranscript } from "./ChatStream";
import { CodeLabPanel } from "./CodeLab";
import { ContextInspector } from "./ContextInspector";
import { breakpointLabel, buildGraph, DiagramLegend, GraphDiagram, lastTouchedNode, packetsFromEvents } from "./Diagrams";

interface SessionInfo {
  sessionId: string;
  agentRevisionId: string;
  budget: Record<string, number>;
}

interface ProfileOption {
  id: string;
  name: string;
  provider: string;
  modelId: string;
}

interface RunView {
  run: { id: string; state: string; stopReason: string | null; mode: string; inputPreview: string; budget: Record<string, number> };
  model: { provider: string; modelId: string; simulated: boolean } | null;
}

interface ApprovalRow {
  id: string;
  runId: string;
  toolRevision: string;
  argsSummary: string;
  target: string;
  state: string;
  expiresAt: string;
}

/** 对话流条目：一次用户输入 + 对应的运行转写（按会话累积，跨运行保留） */
type ChatEntry =
  | { kind: "user"; key: string; text: string }
  | { kind: "run"; key: string; runId: string };

const TERMINAL_STATES = ["completed", "failed", "cancelled"];

export function WorkbenchPage(props: {
  lessonId: string;
  onOpenHistory: () => void;
}) {
  const { lessonId } = props;
  const [manifest, setManifest] = useState<LessonManifestDto | null>(null);
  const [lessonMd, setLessonMd] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [hints, setHints] = useState<CaseHint[]>([]);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [inputs, setInputs] = useState<InputDto[]>([]);
  const [draft, setDraft] = useState("");
  const [chatLog, setChatLog] = useState<ChatEntry[]>([]);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [blobCache, setBlobCache] = useState<Map<string, string>>(new Map());
  const [completedRuns, setCompletedRuns] = useState<Map<string, { derived: RunDerived; finalText: string }>>(new Map());
  const [runView, setRunView] = useState<RunView | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [approval, setApproval] = useState<ApprovalRow | null>(null);
  const [inspectorTab, setInspectorTab] = useState<"arch" | "flow" | "code" | "prompt" | "run">("arch");
  const [focusCallId, setFocusCallId] = useState<string | null>(null);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [profileId, setProfileId] = useState<string>("");
  // 断点：按课程记忆（localStorage），运行激活时同步到服务端（run_breakpoints 表）
  const [breakpoints, setBreakpoints] = useState<string[]>([]);
  const seenRunsRef = useRef<Set<string>>(new Set());

  const bpStoreKey = `agentglass:breakpoints:${lessonId}`;
  useEffect(() => {
    try {
      const raw = localStorage.getItem(bpStoreKey);
      setBreakpoints(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      setBreakpoints([]);
    }
  }, [bpStoreKey]);

  const toggleBreakpoint = useCallback(
    (target: string): void => {
      setBreakpoints((prev) => {
        const next = prev.includes(target) ? prev.filter((t) => t !== target) : [...prev, target];
        try {
          localStorage.setItem(bpStoreKey, JSON.stringify(next));
        } catch {
          /* 本地记忆失败不影响本次会话 */
        }
        if (activeRunIdRef.current && !terminalRef.current) {
          void api.setRunBreakpoints(activeRunIdRef.current, next).catch(() => undefined);
        }
        return next;
      });
    },
    [bpStoreKey],
  );

  // 新运行激活时同步本地断点（本地为准：包括清空；断点跨运行保持，直到用户取消）
  const activeRunIdRef = useRef<string | null>(null);
  const terminalRef = useRef(false);
  const breakpointsRef = useRef<string[]>([]);
  useEffect(() => {
    breakpointsRef.current = breakpoints;
  }, [breakpoints]);
  useEffect(() => {
    terminalRef.current = runView ? TERMINAL_STATES.includes(runView.run.state) : false;
  }, [runView]);
  useEffect(() => {
    activeRunIdRef.current = activeRunId;
  }, [activeRunId]);
  useEffect(() => {
    if (!activeRunId || terminalRef.current) return;
    // 本地非空才推送；空列表 = 未设置（沿用服务端继承的同会话断点），避免误清
    if (breakpointsRef.current.length > 0) {
      void api.setRunBreakpoints(activeRunId, breakpointsRef.current).catch(() => undefined);
    }
    // 仅在运行切换时同步；breakpoints 变化由 toggleBreakpoint 即时推送
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId]);

  // 打开课程：加载包 + 空白输入 + 创建会话（不产生任何模型调用）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cat = await api.catalog();
        const entry = cat.lessons.find((l) => l.id === lessonId);
        if (!entry) throw new Error(`课程不存在: ${lessonId}`);
        const detail = await api.lesson(entry.id, entry.revision);
        const hintsRes = await api.caseHints(entry.id, entry.revision);
        const profileRes = await api.profiles();
        if (cancelled) return;
        setManifest(detail.manifest);
        setLessonMd(detail.lessonMarkdown);
        setSystemPrompt(detail.systemPrompt);
        setHints(hintsRes.hints);
        setProfiles(profileRes.profiles.map((p) => ({ id: p.id, name: p.name, provider: p.provider, modelId: p.modelId })));
        const chosen = profileRes.profiles[0]?.id ?? "";
        setProfileId(chosen);
        if (chosen) {
          const session = await api.createSession(entry.id, chosen);
          if (cancelled) return;
          setSession(session);
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lessonId]);

  const resetConversation = (): void => {
    setEvents([]);
    setChatLog([]);
    setCompletedRuns(new Map());
    setRunView(null);
    setActiveRunId(null);
    setApproval(null);
    setInputs([]);
    seenRunsRef.current = new Set();
  };

  const switchProfile = async (id: string): Promise<void> => {
    if (!manifest || id === profileId) return;
    setProfileId(id);
    resetConversation();
    if (id) {
      const session = await api.createSession(manifest.id, id);
      setSession(session);
    } else {
      setSession(null);
    }
  };

  /** 冻结一次已终结运行的转写快照（供对话流在历史位置渲染） */
  const freezeRun = useCallback(async (runId: string): Promise<void> => {
    try {
      const all: TraceEvent[] = [];
      let cursor = 0;
      for (let i = 0; i < 40; i += 1) {
        const res = await api.runEvents(runId, cursor);
        all.push(...res.events);
        if (res.events.length === 0 || res.nextCursor <= cursor) break;
        cursor = res.nextCursor;
      }
      const outs = await api.runOutputs(runId);
      const derivedSnapshot = deriveRun(all);
      setCompletedRuns((prev) => {
        if (prev.has(runId)) return prev;
        return new Map(prev).set(runId, { derived: derivedSnapshot, finalText: outs.finalText });
      });
    } catch {
      /* 下轮刷新重试 */
    }
  }, []);

  // 轮询会话输入（队列状态）与待决策审批；同时维护对话流（user+run 条目按接纳顺序追加）
  const refreshSession = useCallback(async () => {
    if (!session) return;
    const s = await api.session(session.sessionId);
    setInputs(s.inputs);
    const accepted = s.inputs.filter((i) => i.acceptedRunId);
    const fresh = accepted.filter((i) => !seenRunsRef.current.has(i.acceptedRunId!));
    if (fresh.length > 0) {
      setChatLog((prev) => {
        const next = [...prev];
        for (const inp of fresh) {
          seenRunsRef.current.add(inp.acceptedRunId!);
          next.push({ kind: "user", key: `u-${inp.id}`, text: inp.contentPreview });
          next.push({ kind: "run", key: `r-${inp.acceptedRunId}`, runId: inp.acceptedRunId! });
        }
        return next;
      });
      // 非最新运行（例如页面休眠期间连续完成）直接冻结快照
      const latestRunId = accepted.at(-1)!.acceptedRunId!;
      for (const inp of fresh) {
        if (inp.acceptedRunId !== latestRunId) void freezeRun(inp.acceptedRunId!);
      }
    }
    const latest = accepted.at(-1);
    if (latest?.acceptedRunId && latest.acceptedRunId !== activeRunId) {
      setActiveRunId(latest.acceptedRunId);
      setApproval(null);
    }
    if (latest?.acceptedRunId) {
      const pend = await api.pendingApprovals();
      const mine = pend.approvals.find((a) => a.runId === latest.acceptedRunId && a.state === "pending");
      setApproval(mine ?? null);
    }
  }, [session, activeRunId, freezeRun]);

  useEffect(() => {
    const timer = setInterval(() => void refreshSession(), 800);
    return () => clearInterval(timer);
  }, [refreshSession]);

  // 事件流：SSE 主通道（350ms 泵 + Last-Event-ID 补拉）+ 轮询兜底（SSE 异常时自动提速）
  useEffect(() => {
    if (!activeRunId) return;
    setEvents([]);
    setRunView(null);
    let stopped = false;
    let cursor = 0;
    let fastPoll = false;
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const ingest = (fresh: TraceEvent[]): void => {
      if (fresh.length === 0) return;
      for (const e of fresh) cursor = Math.max(cursor, e.seq);
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.seq));
        const add = fresh.filter((e) => !seen.has(e.seq));
        if (add.length === 0) return prev;
        return [...prev, ...add].sort((a, b) => a.seq - b.seq);
      });
    };

    const pollOnce = async (): Promise<boolean> => {
      try {
        const res = await api.runEvents(activeRunId, cursor);
        ingest(res.events);
        const run = await api.run(activeRunId);
        setRunView(run);
        if (TERMINAL_STATES.includes(run.run.state)) {
          void freezeRun(activeRunId);
          return true;
        }
      } catch {
        // 下轮重试（补拉语义）
      }
      return false;
    };

    try {
      es = new EventSource(`/api/v1/runs/${activeRunId}/stream?afterSeq=0`);
      es.onmessage = (msg) => {
        try {
          ingest([JSON.parse(String(msg.data)) as TraceEvent]);
        } catch {
          /* 心跳等非 JSON 行忽略 */
        }
      };
      es.onerror = () => {
        fastPoll = true; // 代理/网络不支持 SSE 时退回纯轮询
      };
    } catch {
      fastPoll = true;
    }

    const tick = async (): Promise<void> => {
      if (stopped) return;
      const done = await pollOnce();
      if (done || stopped) return;
      pollTimer = setTimeout(() => void tick(), fastPoll ? 400 : 1000);
    };
    pollTimer = setTimeout(() => void tick(), 0);

    return () => {
      stopped = true;
      es?.close();
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [activeRunId, freezeRun]);

  // 事件 → 回合模型
  const derived = useMemo(() => deriveRun(events), [events]);

  // 流式片段/回合全文 blob 按需取回（内容寻址缓存，跨运行复用）
  useEffect(() => {
    const missing = missingBlobs(derived, blobCache);
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      const got = await Promise.all(
        missing.slice(0, 12).map(async (id) => [id, await api.artifact(id).catch(() => "")] as const),
      );
      if (cancelled) return;
      setBlobCache((prev) => {
        const next = new Map(prev);
        for (const [id, text] of got) next.set(id, text);
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [derived, blobCache]);

  // 运行状态行：从事件推导当前阶段（含断点命中的专门提示）
  const lastBreakpointHit = useMemo(
    () => events.filter((e) => e.type === "run.breakpoint_hit").at(-1),
    [events],
  );
  const pausedTarget =
    runView?.run.state === "paused" && lastBreakpointHit ? String(lastBreakpointHit.summary.target ?? "") : undefined;
  const statusLine = useMemo(() => {
    if (!runView) return null;
    const st = runView.run.state;
    if (TERMINAL_STATES.includes(st)) return null;
    if (st === "awaiting_approval") return "等待你的批准：高影响写入需要确认…";
    if (st === "paused") return null; // 暂停由横幅呈现
    const turns = derived.turns.length;
    const last = events.at(-1)?.type ?? "";
    if (last.startsWith("tool.")) return `第 ${Math.max(1, turns)} 轮 · 工具执行中`;
    if (last.startsWith("model.")) return `第 ${Math.max(1, turns)} 轮 · 模型生成中`;
    if (last === "context.compiled") return `第 ${turns + 1} 轮 · 组装上下文`;
    return `运行中（${st}）`;
  }, [runView, events, derived]);

  const send = async (): Promise<void> => {
    if (!session || !manifest) {
      setError("未配置模型：不能发起实时运行。请先在右上角选择，或到「设置」页添加模型配置。");
      return;
    }
    const text = draft.trim();
    if (text.length === 0) return;
    setSending(true);
    setError(null);
    try {
      // 断点随输入携带：运行创建事务内播种，首运行也能在首个边界前命中（PUT 同步有竞态，只作运行中补充）
      await api.submitInput(
        session.sessionId,
        text,
        `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        undefined,
        undefined,
        breakpointsRef.current.length > 0 ? breakpointsRef.current : undefined,
      );
      setDraft(""); // 发送后清空输入框；未发送草稿只留在内存
    } catch (err) {
      setError(String(err));
    } finally {
      setSending(false);
    }
  };

  const insertHint = (hint: CaseHint): void => {
    // 提示卡只能插入草稿；插入不创建消息、不调用模型
    setDraft((d) => (d.length === 0 ? hint.text : `${d}\n${hint.text}`));
  };

  const sendCommand = async (cmd: "pause" | "cancel" | "resume"): Promise<void> => {
    if (!activeRunId) return;
    try {
      await api.runCommand(activeRunId, cmd);
    } catch (err) {
      setError(String(err));
    }
  };

  /** 边界交互：运行中随时暂停并进入代码编辑（草稿独立于活动运行） */
  const pauseAndEdit = (): void => {
    setInspectorTab("code");
    if (["running", "queued", "awaiting_approval"].includes(activeRunState)) void sendCommand("pause");
  };

  /** 深链：跳到上下文检视器并聚焦某一轮的组装结果 */
  const openContext = (callId: string): void => {
    setFocusCallId(callId);
    setInspectorTab("prompt");
  };

  /** 暂停横幅动作：查看此刻上下文组装（最近一次编译，轮次如实标注） */
  const viewCurrentContext = (): void => {
    const latest = events.filter((e) => e.type === "context.compiled").at(-1);
    if (latest) openContext(String(latest.summary.compiledContextId ?? ""));
    else setInspectorTab("prompt");
  };

  const decide = async (decision: "grant" | "reject"): Promise<void> => {
    if (!approval) return;
    try {
      await api.decideApproval(approval.id, decision);
      setApproval(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const activeRunState = runView?.run.state ?? "idle";
  const running = ["running", "queued", "awaiting_approval"].includes(activeRunState);
  const paused = activeRunState === "paused";
  const selectedEvent = selectedSeq != null ? events.find((e) => e.seq === selectedSeq) : undefined;
  const stepMode = breakpoints.includes("turn_end");

  // 观察区框图（共享拓扑：架构/信息流同源）
  const graph = useMemo(() => (manifest ? buildGraph(manifest, events) : null), [manifest, events]);
  const pulseNode = useMemo(() => (graph ? lastTouchedNode(graph, events) : undefined), [graph, events]);

  // 对话流滚动签名
  const chatWatch = `${chatLog.length}:${events.length}:${blobCache.size}:${statusLine ?? ""}:${paused}`;

  return (
    <div className="workbench">
      <header className="wb-header">
        <span className="wb-title">{manifest?.title ?? lessonId}</span>
        <span className={`badge mode-${activeRunState === "idle" ? "idle" : "live"}`}>
          {running && <span className="live-dot" aria-hidden />}
          {activeRunState === "idle" ? "READY" : `LIVE · ${activeRunState.toUpperCase()}`}
        </span>
        {runView?.model && (
          <span className={`badge ${runView.model.simulated ? "badge-warn" : ""}`}>
            {runView.model.provider}/{runView.model.modelId}
            {runView.model.simulated ? "（模拟，非真实模型）" : ""}
          </span>
        )}
        <span className="wb-budget">
          预算：{derived.turns.length}/{manifest?.limits.max_model_calls ?? "?"} 次调用
        </span>
        {breakpoints.length > 0 && (
          <span className="badge badge-bp" title={breakpoints.map((t) => breakpointLabel(t)).join("；")}>
            ◉ 断点 ×{breakpoints.length}
          </span>
        )}
        <select value={profileId} onChange={(e) => void switchProfile(e.target.value)}>
          {profiles.length === 0 && <option value="">未配置模型</option>}
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button
          className={stepMode ? "active" : ""}
          title="单步模式：每回合结束驻留（turn_end 断点），便于逐轮观察上下文组装与工具结果"
          onClick={() => toggleBreakpoint("turn_end")}
        >
          ⏯ 单步
        </button>
        {paused && (
          <button className="primary" onClick={() => void sendCommand("resume")}>恢复</button>
        )}
        {running && (
          <>
            <button onClick={() => void sendCommand("pause")}>暂停</button>
            <button className="danger" onClick={() => void sendCommand("cancel")}>停止</button>
          </>
        )}
        <button onClick={props.onOpenHistory}>历史</button>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="wb-zones">
        {/* ── 对话区 ── */}
        <section className="zone-chat">
          <div className="chat-goal">
            <b>本课目标</b>
            <span>{manifest?.summary}</span>
            <details>
              <summary>课程说明</summary>
              <pre className="lesson-md">{lessonMd}</pre>
            </details>
          </div>

          <ChatScroll watch={chatWatch}>
            {chatLog.length === 0 && !statusLine && !paused && (
              <div className="empty-note">
                <div className="empty-ico" aria-hidden>◇</div>
                <p>输入框为空 —— 此时<b>零模型调用</b>。</p>
                <p className="muted">写下你的任务并发送，才会创建真实运行；<br />下面的提示标签只是草稿素材。</p>
              </div>
            )}
            {chatLog.map((entry) => {
              if (entry.kind === "user") {
                return (
                  <div key={entry.key} className="bubble user">
                    {entry.text}
                  </div>
                );
              }
              const frozen = completedRuns.get(entry.runId);
              if (frozen) {
                return (
                  <RunTranscript
                    key={entry.key}
                    derived={frozen.derived}
                    blobCache={blobCache}
                    finalText={frozen.finalText}
                    onOpenContext={openContext}
                  />
                );
              }
              if (entry.runId === activeRunId) {
                return (
                  <RunTranscript
                    key={entry.key}
                    derived={derived}
                    blobCache={blobCache}
                    onOpenContext={openContext}
                  />
                );
              }
              return (
                <p key={entry.key} className="muted small run-waiting">
                  运行排队中……
                </p>
              );
            })}

            {approval && (
              <div className="approval-card">
                <div className="approval-title">⛔ 需要你的批准：{toolLabel(approval.target)}</div>
                <pre className="mono approval-args">{approval.argsSummary}</pre>
                <p className="muted small">审批绑定参数摘要；目标/工具版本/策略任一变化即失效。批准后写入 run 专属工作区。</p>
                <div className="approval-actions">
                  <button className="danger" onClick={() => void decide("reject")}>拒绝</button>
                  <button className="primary" onClick={() => void decide("grant")}>批准执行</button>
                </div>
              </div>
            )}

            {paused && (
              <div className="paused-banner">
                <div className="paused-title">
                  {pausedTarget
                    ? `◉ 断点命中：${breakpointLabel(pausedTarget)}`
                    : "⏸ 运行已暂停"}
                </div>
                <p className="muted small">
                  现场已驻留——可以检视最近一次上下文组装（第 {derived.turns.length} 轮）、信息流与代码，然后恢复。
                </p>
                <div className="paused-actions">
                  <button onClick={viewCurrentContext}>◉ 查看此刻上下文组装</button>
                  {manifest?.editing && <button onClick={pauseAndEdit}>✎ 去改代码</button>}
                  <button className="primary" onClick={() => void sendCommand("resume")}>恢复运行 →</button>
                </div>
              </div>
            )}

            {statusLine && (
              <div className="status-row">
                <span className="status-spin" aria-hidden />
                <span className="status-line">{statusLine}</span>
              </div>
            )}
          </ChatScroll>

          <div className="composer">
            {hints.length > 0 && (
              <div className="hint-chips">
                {hints.map((h) => (
                  <button key={h.id} className="chip" title={h.text} onClick={() => insertHint(h)}>
                    {h.text.slice(0, 16)}{h.text.length > 16 ? "…" : ""}
                  </button>
                ))}
                <span className="muted small">点击只插入输入框，发送由你决定</span>
              </div>
            )}
            <textarea
              data-testid="message-composer"
              value={draft}
              placeholder="给 agent 下任务……（Ctrl+Enter 发送）"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send();
              }}
              rows={3}
            />
            <div className="composer-actions">
              <span className="composer-side">
                <span className="muted small">排队中：{inputs.filter((i) => i.status === "queued").length} 条</span>
                {manifest?.editing && (running || paused) && (
                  <button onClick={pauseAndEdit}>{running ? "⏸ 暂停并改代码" : "✎ 去改代码"}</button>
                )}
              </span>
              {paused && <button onClick={() => void sendCommand("resume")}>恢复</button>}
              {running && <button className="danger" onClick={() => void sendCommand("cancel")}>中断</button>}
              <button data-testid="send-message" className="primary send-btn" disabled={sending || draft.trim().length === 0} onClick={() => void send()}>
                发送 ↑
              </button>
            </div>
          </div>
        </section>

        {/* ── 观察区 ── */}
        <aside className="zone-observe">
          <div className="inspector-tabs">
            {(["arch", "flow", "code", "prompt", "run"] as const).map((t) => (
              <button key={t} className={inspectorTab === t ? "active" : ""} onClick={() => setInspectorTab(t)}>
                {{ arch: "架构", flow: "信息流", code: "代码", prompt: "上下文", run: "运行" }[t]}
              </button>
            ))}
          </div>
          <div className="inspector-body">
            {inspectorTab === "arch" && graph && manifest && (
              <ArchTab
                graph={graph}
                events={events}
                running={running}
                pulseNode={pulseNode}
                manifest={manifest}
                onOpenFlow={() => setInspectorTab("flow")}
                breakpoints={breakpoints}
                onToggleBreakpoint={toggleBreakpoint}
                pausedTarget={pausedTarget}
              />
            )}
            {inspectorTab === "flow" && graph && (
              <FlowTab
                graph={graph}
                events={events}
                running={running}
                pulseNode={pulseNode}
                selectedSeq={selectedSeq}
                onSelect={setSelectedSeq}
                breakpoints={breakpoints}
                onToggleBreakpoint={toggleBreakpoint}
                pausedTarget={pausedTarget}
              />
            )}
            {inspectorTab === "code" && manifest && !manifest.editing && (
              <p className="muted">本课程未开放代码编辑（编辑开放面随课程递进；见 L01/L05/L06）。</p>
            )}
            {inspectorTab === "code" && manifest && manifest.editing && session && (
              <CodeLabPanel
                lessonId={manifest.id}
                sessionId={session.sessionId}
                currentRevisionId={session.agentRevisionId}
                onAdopted={(revId) => {
                  setSession((s) => (s ? { ...s, agentRevisionId: revId } : s));
                  void api.adoptRevision(session.sessionId, revId);
                }}
              />
            )}
            {inspectorTab === "prompt" && (
              <ContextInspector
                events={events}
                runId={activeRunId}
                systemPrompt={systemPrompt}
                focusCallId={focusCallId}
                onFocusConsumed={() => setFocusCallId(null)}
              />
            )}
            {inspectorTab === "run" && <RunPanel events={events} runView={runView} derived={derived} />}
          </div>
        </aside>
      </div>
    </div>
  );
}

function toolLabel(target: string): string {
  const m = target.split(":")[1] ?? target;
  return m;
}

/** 架构页签：真实框图（manifest 为真相源）+ 特性卡；节点可设断点 */
function ArchTab(props: {
  graph: NonNullable<ReturnType<typeof buildGraph>>;
  events: TraceEvent[];
  running: boolean;
  pulseNode?: string;
  manifest: LessonManifestDto;
  onOpenFlow: () => void;
  breakpoints: string[];
  onToggleBreakpoint: (target: string) => void;
  pausedTarget?: string;
}) {
  const { graph, running, pulseNode, manifest, breakpoints, onToggleBreakpoint, pausedTarget } = props;
  const rt = manifest.runtime;
  return (
    <div className="arch">
      <div className="dg-frame">
        <GraphDiagram
          graph={graph}
          running={running}
          pulseNodeId={pulseNode}
          breakpoints={breakpoints}
          onToggleBreakpoint={onToggleBreakpoint}
          pausedTarget={pausedTarget}
        />
      </div>
      <DiagramLegend />
      {graph.layout === "loop" && (
        <p className="muted small">
          虚线回边即 agent 循环：停止判定=「继续」时回到「上下文编译」进入下一轮；图上数字为真实事件计数。
          点击「模型调用 / 工具执行 / 停止判定」节点可设断点：运行到该处驻留，供你观察现场。
        </p>
      )}

      <div className="arch-specials">
        {(rt.mcp_servers?.length ?? 0) > 0 && (
          <div className="arch-special">MCP server：{rt.mcp_servers!.join("、")}（协议事件脱敏记录）</div>
        )}
        {(rt.a2a_agents?.length ?? 0) > 0 && (
          <div className="arch-special">A2A 远程 agent：{rt.a2a_agents!.map((a) => `a2a_${a}`).join("、")}（结果为待验证信息）</div>
        )}
        {(manifest.requires?.tools?.includes("write_file") ?? false) && (
          <div className="arch-special">高影响写入（write_file）需审批驻留 → 对话区内批准</div>
        )}
        {rt.compaction === "tool_result_head" && <div className="arch-special">上下文压缩：tool_result_head（对照 L15）</div>}
      </div>
      <p className="muted small">
        架构以课程 manifest 为准（服务端持有，不可被运行时修改）。实际执行轨迹见
        <button className="link" onClick={props.onOpenFlow}>信息流</button>。
      </p>
    </div>
  );
}

/** 信息流页签：真实框图 + 事件包动画 + 事件明细（可查工件）；节点可设断点 */
function FlowTab(props: {
  graph: NonNullable<ReturnType<typeof buildGraph>>;
  events: TraceEvent[];
  running: boolean;
  pulseNode?: string;
  selectedSeq: number | null;
  onSelect: (seq: number) => void;
  breakpoints: string[];
  onToggleBreakpoint: (target: string) => void;
  pausedTarget?: string;
}) {
  const { graph, events, running, pulseNode, selectedSeq, onSelect, breakpoints, onToggleBreakpoint, pausedTarget } = props;
  const [payload, setPayload] = useState<{ seq: number; text: string } | null>(null);
  const packets = useMemo(() => packetsFromEvents(graph, events), [graph, events]);
  const edges = events.filter((e) =>
    [
      "model.request_prepared", "model.response_completed", "tool.proposed", "tool.call_completed",
      "context.compiled", "policy.stop_decision", "agent.delegated", "agent.result_received",
      "recursion.node_completed", "graph.node_completed", "approval.requested", "approval.granted",
      "mcp.protocol_event", "a2a.agent_connected", "tool.denied", "run.breakpoint_hit",
    ].includes(e.type),
  );
  const openPayload = async (e: TraceEvent): Promise<void> => {
    onSelect(e.seq);
    if (e.payloadRef) {
      try {
        setPayload({ seq: e.seq, text: (await api.artifact(e.payloadRef.id)).slice(0, 2000) });
      } catch {
        setPayload({ seq: e.seq, text: "（工件不可读）" });
      }
    } else {
      setPayload(null);
    }
  };
  return (
    <div>
      <div className="dg-frame">
        <GraphDiagram
          graph={graph}
          running={running}
          pulseNodeId={pulseNode}
          packets={packets}
          breakpoints={breakpoints}
          onToggleBreakpoint={onToggleBreakpoint}
          pausedTarget={pausedTarget}
        />
      </div>
      <DiagramLegend />
      {events.length > 0 && (
        <p className="muted small">圆点 = 真实事件沿边流动（与下方明细一一对应）；点击带工件的行查看内容；点击节点设断点。</p>
      )}
      {edges.length === 0 ? (
        <p className="muted">尚无实际信息流。发送任务后，这里按真实事件绘制调用边与流动包。</p>
      ) : (
        <ol className="flow-list">
          {edges.map((e) => (
            <li key={e.eventId} className={selectedSeq === e.seq ? "selected" : ""} onClick={() => void openPayload(e)}>
              <span className="event-seq">#{e.seq}</span>
              <span className="flow-type">{e.type}</span>
              {e.payloadRef && <span className="flow-payload">工件 {e.payloadRef.id.slice(0, 10)}…</span>}
            </li>
          ))}
        </ol>
      )}
      {payload && (
        <div className="ctx-detail">
          <div className="tool-sec">事件 #{payload.seq} 工件内容（前 2000 字符）</div>
          <pre>{payload.text}</pre>
        </div>
      )}
    </div>
  );
}

function RunPanel(props: { events: TraceEvent[]; runView: RunView | null; derived: RunDerived }) {
  const { runView, derived } = props;
  if (!runView) return <p className="muted">尚无运行。</p>;
  return (
    <div className="run-meta">
      <p><b>运行 ID</b><br /><code>{runView.run.id}</code></p>
      <p><b>模式</b> {runView.run.mode === "live" ? "LIVE 实时" : runView.run.mode} · <b>状态</b> {runView.run.state}{runView.run.stopReason ? `（${runView.run.stopReason}）` : ""}</p>
      <p><b>模型</b> {runView.model?.provider}/{runView.model?.modelId}{runView.model?.simulated ? "（模拟）" : ""}</p>
      <p><b>回合</b> {derived.turns.length} 次模型调用 · {derived.turns.reduce((n, t) => n + t.tools.length, 0)} 次工具调用</p>
      <p><b>用量</b> 输入 {derived.usage.input} tokens / 输出 {derived.usage.output} tokens（费用：未配置价格表，未知）</p>
      <p><b>预算</b> {JSON.stringify(runView.run.budget)}</p>
    </div>
  );
}
