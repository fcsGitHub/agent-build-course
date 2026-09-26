import { useEffect, useMemo, useState } from "react";
import { api, type LessonCatalogEntry } from "../api";

/** 阶段元数据：与设计文档 §4 的课程地图对应（IX 为前沿扩展阶段） */
const STAGE_META: Record<string, { title: string; note?: string }> = {
  I: { title: "从一次调用到真正的循环" },
  II: { title: "工作流与外部知识" },
  III: { title: "上下文、记忆与技能" },
  IV: { title: "规划、图与人机协同" },
  V: { title: "协议、harness 与工程可靠性" },
  VI: { title: "多智能体与跨系统协作" },
  VII: { title: "长任务与受控演进", note: "自我改进的前置：先有门控，再谈演进" },
  VIII: { title: "综合毕业实验" },
  IX: { title: "前沿与递归自我改进（RSI）", note: "上下文工程 · DeepResearch · 有界 RSI（DGM 骨架）" },
};

function shortId(id: string): string {
  return id.replace(/^L(\d+)-.*/, "L$1");
}

export function LearnPage(props: { onOpenLesson: (id: string) => void }) {
  const [catalog, setCatalog] = useState<LessonCatalogEntry[]>([]);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    void api.catalog().then((r) => setCatalog(r.lessons));
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      q.length === 0
        ? catalog
        : catalog.filter(
            (c) =>
              c.id.toLowerCase().includes(q) ||
              c.title.toLowerCase().includes(q) ||
              c.summary.toLowerCase().includes(q),
          ),
    [catalog, q],
  );
  const stages = [...new Set(filtered.map((c) => c.stage))].sort();
  const frontierCount = catalog.filter((c) => c.stage === "IX").length;

  const toggleStage = (stage: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      return next;
    });
  };
  const allCollapsed = stages.length > 0 && stages.every((s) => collapsed.has(s));
  const toggleAll = (): void => {
    setCollapsed(allCollapsed ? new Set() : new Set(stages));
  };

  return (
    <div className="learn">
      <header className="learn-hero">
        <h1>AgentGlass</h1>
        <p className="learn-tag">
          Agent 原理可观测实验室 —— 同一次真实运行，从信息流、源码、模型可见上下文、工具副作用与成本多个角度观察。
        </p>
        <div className="learn-facts">
          <span><b>{catalog.length}</b> 门课程</span>
          <span><b>9</b> 个阶段</span>
          <span><b>{frontierCount}</b> 门前沿课（RSI）</span>
          <span className="dot-sep" />
          <span>流程图断点 · 逐事件回放 · 四层证据</span>
        </div>
        <p className="muted small learn-notice">
          打开课程零模型调用；写下任务并发送后，运行才开始。案例提示只进草稿，发送由你决定。
        </p>
      </header>

      <div className="learn-tools">
        <input
          data-testid="lesson-search"
          className="learn-search"
          type="search"
          placeholder="搜索课程：编号 / 标题 / 关键词（如 MCP、预算、上下文）…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {q.length > 0 && (
          <span className="muted small">
            命中 {filtered.length} / {catalog.length} 门
          </span>
        )}
        <span className="spacer" />
        <button className="small-btn" onClick={toggleAll} disabled={stages.length === 0}>
          {allCollapsed ? "展开全部阶段" : "收起全部阶段"}
        </button>
      </div>

      {stages.length === 0 && q.length > 0 && (
        <p className="muted learn-empty">没有匹配「{query.trim()}」的课程——换个关键词试试（如 工具 / 检索 / 多 agent）。</p>
      )}

      {stages.map((stage) => {
        const meta = STAGE_META[stage] ?? { title: `阶段 ${stage}` };
        const lessons = filtered.filter((c) => c.stage === stage);
        const frontier = stage === "IX";
        const isCollapsed = collapsed.has(stage);
        return (
          <section key={stage} className={`stage ${frontier ? "stage-frontier" : ""}`}>
            <div className="stage-head">
              <button
                className={`stage-fold ${isCollapsed ? "collapsed" : ""}`}
                title={isCollapsed ? "展开该阶段" : "收起该阶段"}
                onClick={() => toggleStage(stage)}
                aria-expanded={!isCollapsed}
              >
                {isCollapsed ? "▸" : "▾"}
              </button>
              <span className="stage-no">{stage}</span>
              <div className="stage-title">
                <h2>{meta.title}</h2>
                {meta.note && <span className="muted small">{meta.note}</span>}
              </div>
              <span className="stage-count muted small">{lessons.length} 门</span>
            </div>
            {!isCollapsed && (
              <div className="lesson-grid">
                {lessons.map((c) => (
                  <button key={c.id} className="lesson-card" onClick={() => props.onOpenLesson(c.id)}>
                    <span className="lesson-id">{shortId(c.id)}</span>
                    <span className="lesson-title">{c.title}</span>
                    <span className="lesson-summary">{c.summary}</span>
                    {c.prerequisites.length > 0 && (
                      <span className="lesson-prereq muted small">先修 {c.prerequisites.map(shortId).join(" · ")}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
