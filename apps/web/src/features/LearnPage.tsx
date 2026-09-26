import { useEffect, useState } from "react";
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

  useEffect(() => {
    void api.catalog().then((r) => setCatalog(r.lessons));
  }, []);

  const stages = [...new Set(catalog.map((c) => c.stage))].sort();
  const frontierCount = catalog.filter((c) => c.stage === "IX").length;

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

      {stages.map((stage) => {
        const meta = STAGE_META[stage] ?? { title: `阶段 ${stage}` };
        const lessons = catalog.filter((c) => c.stage === stage);
        const frontier = stage === "IX";
        return (
          <section key={stage} className={`stage ${frontier ? "stage-frontier" : ""}`}>
            <div className="stage-head">
              <span className="stage-no">{stage}</span>
              <div className="stage-title">
                <h2>{meta.title}</h2>
                {meta.note && <span className="muted small">{meta.note}</span>}
              </div>
              <span className="stage-count muted small">{lessons.length} 门</span>
            </div>
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
          </section>
        );
      })}
    </div>
  );
}
