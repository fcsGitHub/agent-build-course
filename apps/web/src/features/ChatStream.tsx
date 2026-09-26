/**
 * 对话流渲染（借鉴 Chainlit 步骤树 / AI Elements Conversation / Claude Code 紧凑工具行）：
 * - RunTranscript：一次运行按事件顺序渲染「回合 + 通信活动」——回合头（序号/worker 归属/
 *   输入估算/流式计时/上下文深链）、流式助手气泡（markdown + 打字机光标）、工具卡
 *   （单行折叠 + 耗时）；多 agent 的委派/移交/结果回收、MCP 协议、A2A 连接、技能加载
 *   渲染为窄通信卡，穿插在对应位置。
 * - SmoothText：目标文本异步增长时平滑追赶的打字机效果。
 * - ChatScroll：智能吸底——用户上翻时停止跟随并浮出「回到最新」按钮。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { resolveTurnText, type AgentActivity, type RunDerived, type ToolCallView, type TurnView } from "../derive";
import { Markdown } from "../markdown";

export interface RunChatState {
  runId: string;
  derived: RunDerived;
  finalText?: string;
  state: string;
}

/* ── 打字机：平滑追赶上层异步拼接的目标文本 ── */
function useSmoothText(target: string, active: boolean): string {
  const [n, setN] = useState(target.length);
  useEffect(() => {
    if (!active) {
      setN(target.length);
      return;
    }
    const timer = setInterval(() => {
      setN((prev) => {
        if (prev >= target.length) return prev;
        return prev + Math.max(1, Math.ceil((target.length - prev) / 5));
      });
    }, 28);
    return () => clearInterval(timer);
  }, [target, active]);
  return target.slice(0, n);
}

/* ── 流式计时：活动回合的生成耗时（500ms 心跳；冻结后停在一次近似值） ── */
function useElapsedMs(sinceIso: string | undefined, active: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [active]);
  if (!sinceIso) return null;
  const start = Date.parse(sinceIso);
  if (Number.isNaN(start)) return null;
  return Math.max(0, (active ? now : start) - start);
}

/* ── 智能吸底容器 ── */
export function ChatScroll(props: { children: ReactNode; watch: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const onScroll = (): void => {
    const el = ref.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 90);
  };
  useEffect(() => {
    if (pinned) ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [props.watch, pinned]);
  return (
    <div className="chat-scroll-wrap">
      <div className="chat-scroll" ref={ref} onScroll={onScroll}>
        {props.children}
      </div>
      {!pinned && (
        <button
          className="scroll-bottom"
          onClick={() => {
            setPinned(true);
            ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
          }}
        >
          ↓ 回到最新
        </button>
      )}
    </div>
  );
}

function toolGlyph(toolId: string): string {
  if (toolId.startsWith("a2a_")) return "⇄";
  if (toolId.includes("mcp")) return "◆";
  if (/^(read|list|grep|search|web_search|research)/.test(toolId)) return "⌕";
  if (/^(write|edit)/.test(toolId)) return "✎";
  if (/(test|exec|bash|run)/.test(toolId)) return "▶";
  if (/(http|fetch)/.test(toolId)) return "⇣";
  return "⚙";
}

function formatDuration(ms: number | undefined): string | null {
  if (ms == null) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/* ── 工具卡：单行折叠 + 状态 + 耗时；展开看真实参数与结果工件 ── */
export function ToolCard(props: { tool: ToolCallView }) {
  const { tool } = props;
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const cls = tool.status === "succeeded" ? "ok" : tool.status === "failed" || tool.status === "denied" ? "bad" : "run";
  const dur = formatDuration(tool.durationMs);
  const toggle = async (): Promise<void> => {
    const next = !open;
    setOpen(next);
    if (next && tool.resultRef && result == null) {
      try {
        setResult((await api.artifact(tool.resultRef)).slice(0, 2000));
      } catch {
        setResult("（工件不可读）");
      }
    }
  };
  return (
    <div className={`tool-row ${open ? "open" : ""}`}>
      <button className="tool-row-head" onClick={() => void toggle()}>
        {tool.status === "pending" ? (
          <span className="tool-spin" aria-hidden />
        ) : (
          <span className={`tool-ico ${cls}`} aria-hidden>
            {tool.status === "succeeded" ? "✓" : tool.status === "failed" ? "✗" : "⊘"}
          </span>
        )}
        <span className="tool-glyph" aria-hidden>{toolGlyph(tool.toolId)}</span>
        <span className="tool-name">{tool.toolId}</span>
        <span className="tool-desc">
          {tool.status === "pending" && "执行中"}
          {tool.status === "succeeded" && "成功"}
          {tool.status === "failed" && "失败"}
          {tool.status === "denied" && "被拒绝"}
        </span>
        {dur && <span className="tool-dur">{dur}</span>}
        <span className="tool-chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="tool-detail mono">
          <div className="tool-sec">参数</div>
          <pre>{prettyArgs(tool.argsText) || "（无）"}</pre>
          {result != null && (
            <>
              <div className="tool-sec">真实结果（工件前 2000 字符）</div>
              <pre>{result}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function prettyArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/* ── agent 通信活动卡：委派 / 移交 / 结果回收 / MCP / A2A / 技能加载 ── */
function activityText(a: AgentActivity): { glyph: string; label: string; detail: string; cls: string } {
  switch (a.kind) {
    case "delegated":
      return {
        glyph: "◉",
        label: "委派子任务",
        detail: `→ worker「${a.workerId ?? "?"}」${a.goal ? ` · ${a.goal}` : ""}`,
        cls: "act-delegate",
      };
    case "handed_off":
      return {
        glyph: "⇄",
        label: "控制权移交",
        detail: a.to === "(final)" ? `${a.from} → 最终输出` : `${a.from} → ${a.to}`,
        cls: "act-handoff",
      };
    case "result": {
      if (a.blackboardKey) {
        return {
          glyph: a.conflict ? "⚠" : "✓",
          label: "黑板合并",
          detail: `键「${a.blackboardKey}」 · ${a.conflict ? "写冲突，保留全部版本" : "顺序合流"} · ${a.versions ?? "?"} 版`,
          cls: a.conflict ? "act-warn" : "act-result",
        };
      }
      if (a.status === "succeeded") {
        return {
          glyph: "✓",
          label: "结果回收",
          detail: `worker「${a.workerId ?? "?"}」成功 · ${a.outputChars ?? "?"} 字`,
          cls: "act-result",
        };
      }
      return {
        glyph: "✗",
        label: "结果回收",
        detail: `worker「${a.workerId ?? "?"}」${a.status ?? "失败"}${a.reason ? ` · ${a.reason}` : ""}`,
        cls: "act-warn",
      };
    }
    case "mcp_connect":
      return { glyph: "◆", label: "MCP 连接", detail: `server「${a.server ?? "?"}」能力协商完成`, cls: "act-mcp" };
    case "mcp_protocol":
      return {
        glyph: "◆",
        label: "MCP 协议",
        detail: `${a.server ?? "?"} ${a.dir === "in" ? "→" : "←"} ${a.method ?? "消息"}（脱敏记录）`,
        cls: "act-mcp",
      };
    case "a2a_connect":
      return { glyph: "⇄", label: "A2A 连接", detail: `远程 agent「${a.agentName ?? "?"}」card 发现完成`, cls: "act-a2a" };
    case "skill":
      return { glyph: "▤", label: "技能加载", detail: `${a.slug ?? "?"} v${a.version ?? "?"}`, cls: "act-skill" };
    default:
      return { glyph: "·", label: "活动", detail: "", cls: "" };
  }
}

export function AgentActivityCard(props: { activity: AgentActivity }) {
  const { glyph, label, detail, cls } = activityText(props.activity);
  return (
    <div className={`act-row ${cls}`} title={`事件 #${props.activity.seq}`}>
      <span className="act-glyph" aria-hidden>{glyph}</span>
      <span className="act-label">{label}</span>
      <span className="act-detail">{detail}</span>
    </div>
  );
}

/* ── 单回合：助手气泡（流式）+ 工具卡 ── */
function TurnBlock(props: {
  turn: TurnView;
  blobCache: ReadonlyMap<string, string>;
  textOverride?: string;
  isLast: boolean;
  onOpenContext: (callId: string) => void;
}) {
  const { turn, blobCache, textOverride, onOpenContext } = props;
  const rawText = textOverride ?? resolveTurnText(turn, blobCache);
  const text = useSmoothText(rawText, turn.streaming);
  const elapsed = useElapsedMs(turn.requestedAt, turn.streaming);
  const showBubble = text.length > 0 || turn.streaming || turn.failed;
  const isWorker = turn.workerId != null;
  return (
    <div className={`turn ${isWorker ? "turn-worker" : ""}`}>
      <div className="turn-rail" aria-hidden>
        <span className={`turn-dot ${turn.streaming ? "live" : turn.failed ? "bad" : ""} ${isWorker ? "worker" : ""}`}>
          {isWorker ? "W" : `T${turn.index}`}
        </span>
        <span className="turn-line" />
      </div>
      <div className="turn-body">
        <div className="turn-head">
          <span className="turn-title">
            {isWorker ? `worker「${turn.workerId}」 · 第 ${turn.index} 次调用` : `第 ${turn.index} 轮 · 模型调用`}
          </span>
          {turn.streaming && elapsed != null && (
            <span className="turn-meta stream-meta">
              生成中 {(elapsed / 1000).toFixed(1)}s · {turn.deltaBlobIds.length} 片段
            </span>
          )}
          {!turn.streaming && turn.estimatedInputTokens != null && (
            <span className="turn-meta muted">输入 ~{turn.estimatedInputTokens} tok</span>
          )}
          {turn.usage?.outputTokens != null && (
            <span className="turn-meta muted">输出 {turn.usage.outputTokens} tok</span>
          )}
          {turn.truncated && <span className="badge badge-warn">输出被截断</span>}
          {turn.contextCallId && (
            <button className="link turn-ctx" title="查看这一次调用模型实际看到的完整上下文" onClick={() => onOpenContext(turn.contextCallId!)}>
              ◉ 上下文
            </button>
          )}
        </div>
        {showBubble && (
          <div className={`bubble agent ${turn.streaming ? "streaming" : ""} ${isWorker ? "worker" : ""}`}>
            <div className="bubble-head">
              <span className={`avatar ${isWorker ? "worker" : ""}`} aria-hidden>{isWorker ? turn.workerId!.slice(0, 1).toUpperCase() : "A"}</span>
              <span className="bubble-role">
                {turn.streaming ? "正在生成…" : turn.failed ? "生成中断" : isWorker ? `子 agent ${turn.workerId}` : "助手"}
              </span>
            </div>
            <div className="bubble-body">
              <Markdown text={text} />
              {turn.streaming && <span className="stream-caret" aria-hidden />}
            </div>
          </div>
        )}
        {turn.tools.map((t) => (
          <ToolCard key={t.callId} tool={t} />
        ))}
      </div>
    </div>
  );
}

/* ── 一次运行的完整转写（回合与通信活动按事件顺序穿插） ── */
export function RunTranscript(props: {
  derived: RunDerived;
  blobCache: ReadonlyMap<string, string>;
  finalText?: string;
  onOpenContext: (callId: string) => void;
}) {
  const { derived, blobCache, finalText, onOpenContext } = props;
  if (derived.entries.length === 0) {
    return <p className="muted small run-waiting">运行已接纳，等待事件流入……</p>;
  }
  const lastTurn = derived.turns.at(-1);
  const lastTurnIndex = lastTurn?.index;
  const multiAgent = derived.turns.some((t) => t.workerId != null);
  return (
    <div className="transcript">
      {derived.entries.map((entry) =>
        entry.kind === "turn" ? (
          <TurnBlock
            key={`t-${entry.turn.index}`}
            turn={entry.turn}
            blobCache={blobCache}
            textOverride={entry.turn.index === lastTurnIndex && entry.turn.workerId == null ? finalText : undefined}
            isLast={entry.turn.index === lastTurnIndex}
            onOpenContext={onOpenContext}
          />
        ) : (
          <AgentActivityCard key={`a-${entry.activity.seq}`} activity={entry.activity} />
        ),
      )}
      {/* 多 agent 运行：合并输出作为收尾气泡（worker 回合保持各自原文） */}
      {multiAgent && finalText && (
        <div className="turn">
          <div className="turn-rail" aria-hidden>
            <span className="turn-dot merge">Σ</span>
            <span className="turn-line" />
          </div>
          <div className="turn-body">
            <div className="turn-head">
              <span className="turn-title">合并输出 · 协调器</span>
              <span className="turn-meta muted">确定性合并（按声明顺序，非完成顺序）</span>
            </div>
            <div className="bubble agent">
              <div className="bubble-head">
                <span className="avatar" aria-hidden>Σ</span>
                <span className="bubble-role">协调器汇总</span>
              </div>
              <div className="bubble-body">
                <Markdown text={finalText} />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
