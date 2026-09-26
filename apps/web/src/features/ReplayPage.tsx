/**
 * 回放页（T10/T33）。两种来源：数据库中的历史运行、导入的 .agtrace.zip 包。
 * 回放只读取事件并经同一 reducer 重建；不调用模型、不执行工具。
 * 框图与实验台同源（Diagrams.tsx）：随游标推进点亮节点与计数，播放时信息包沿边移动；
 * 导入包仅在携带课程清单快照时重建框图（否则如实降级为事件流，不虚构拓扑）。
 */
import { useMemo, useState } from "react";
import { api, type LessonManifestDto, type TraceEvent } from "../api";
import { unzipSync, strFromU8 } from "fflate";
import { buildGraph, DiagramLegend, GraphDiagram, lastTouchedNode, packetsFromEvents } from "./Diagrams";

export function ReplayPage(props: { runId?: string; onBack: () => void }) {
  const { runId, onBack } = props;
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [manifest, setManifest] = useState<LessonManifestDto | null>(null);
  const [manifestNote, setManifestNote] = useState<string>("");
  const [cursor, setCursor] = useState(0);
  const [source, setSource] = useState<string>("");
  const [playing, setPlaying] = useState(false);

  const loadRun = async (id: string): Promise<void> => {
    let cursorSeq = 0;
    const all: TraceEvent[] = [];
    for (;;) {
      const res = await api.runEvents(id, cursorSeq);
      all.push(...res.events);
      if (res.events.length === 0) break;
      cursorSeq = res.nextCursor;
    }
    setEvents(all);
    setCursor(0);
    setSource(`历史运行 ${id}`);
    // 课程清单仅用于框图重建（纯投影）；拿不到就如实降级为事件流
    try {
      const detail = await api.run(id);
      const lesson = await api.lesson(detail.run.lessonId, detail.run.lessonRevision);
      setManifest(lesson.manifest);
      setManifestNote("");
    } catch {
      setManifest(null);
      setManifestNote("课程清单不可用（已卸载或版本变化）：框图不可重建，仅展示事件流。");
    }
  };

  if (runId && source === "") void loadRun(runId);

  const importZip = async (file: File): Promise<void> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const entries = unzipSync(bytes);
    const jsonl = strFromU8(entries["events/events.jsonl"]!);
    const evts = jsonl
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as TraceEvent)
      .sort((a, b) => a.seq - b.seq);
    setEvents(evts);
    setCursor(0);
    setSource(`导入包（${evts.length} 事件）`);
    let m: LessonManifestDto | null = null;
    let note = "";
    try {
      if (entries["manifest.json"]) {
        const bm = JSON.parse(strFromU8(entries["manifest.json"]!)) as { lesson?: { manifest?: Record<string, unknown> } };
        if (bm.lesson?.manifest) {
          m = bm.lesson.manifest as unknown as LessonManifestDto;
        } else {
          note = "导入包未携带课程清单快照（旧格式导出）：框图不可重建，仅展示事件流。";
        }
      }
    } catch {
      note = "导入包清单解析失败：仅展示事件流。";
    }
    setManifest(m);
    setManifestNote(note);
  };

  const current = events[cursor];
  const start = (): void => {
    if (events.length === 0) return;
    setPlaying(true);
    const timer = setInterval(() => {
      setCursor((c) => {
        if (c >= events.length - 1) {
          clearInterval(timer);
          setPlaying(false);
          return c;
        }
        return c + 1;
      });
    }, 250);
  };

  const visible = useMemo(() => events.slice(0, cursor + 1), [events, cursor]);

  // 框图随游标推进：只投影"已揭示"的事件（纯函数，无执行）
  const graph = useMemo(() => (manifest ? buildGraph(manifest, visible) : null), [manifest, visible]);
  const packets = useMemo(() => (graph ? packetsFromEvents(graph, visible) : []), [graph, visible]);
  const pulseNode = useMemo(() => (graph ? lastTouchedNode(graph, visible) : undefined), [graph, visible]);

  return (
    <div className="replay">
      <div className="replay-toolbar">
        <button onClick={onBack}>返回</button>
        <span className={`badge badge-replay`}>REPLAY — 记录中的模型请求，不产生新的调用或副作用</span>
        <span className="muted">{source}</span>
        <label className="import-label">
          导入 .agtrace.zip
          <input
            data-testid="trace-file-input"
            type="file"
            accept=".zip"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importZip(f);
            }}
          />
        </label>
      </div>
      <div className="replay-controls">
        <button disabled={cursor === 0} onClick={() => setCursor(0)}>⏮ 开头</button>
        <button disabled={cursor === 0 || playing} onClick={() => setCursor((c) => Math.max(0, c - 1))}>◀ 上一事件</button>
        <button disabled={playing || events.length === 0} onClick={start}>▶ 播放</button>
        <button disabled={cursor >= events.length - 1} onClick={() => { setPlaying(false); setCursor((c) => Math.min(events.length - 1, c + 1)); }}>下一事件 ▶</button>
        <button disabled={events.length === 0} onClick={() => { setPlaying(false); setCursor(events.length - 1); }}>⏭ 跳到末尾</button>
        <span className="muted">{events.length > 0 ? `${cursor + 1} / ${events.length}` : "无事件"}</span>
      </div>
      {graph && (
        <div className="replay-diagram">
          <div className="dg-frame">
            <GraphDiagram graph={graph} running={playing} pulseNodeId={pulseNode} packets={packets} />
          </div>
          <DiagramLegend />
          <p className="muted small">框图随游标推进重新投影（同一 reducer 的可见事件前缀）；当前事件在图上以脉冲节点标注。</p>
        </div>
      )}
      {manifestNote && <p className="muted small">{manifestNote}</p>}
      <div className="replay-body">
        {current ? (
          <div className="replay-event">
            <div className="replay-event-head">
              <span className="event-seq">#{current.seq}</span>
              <span className="flow-type">{current.type}</span>
              <span className="muted">{new Date(current.emittedAt).toLocaleTimeString()}</span>
            </div>
            <pre className="mono">{JSON.stringify(current.summary, null, 2)}</pre>
            {current.payloadRef && <p className="muted small">载荷工件：{current.payloadRef.id}（{current.payloadRef.bytes} 字节；离线包中按策略保留）</p>}
          </div>
        ) : (
          <p className="muted center-note">选择左侧历史运行，或导入 .agtrace.zip 开始回放。回放不执行任何代码。</p>
        )}
        {visible.length > 0 && (
          <ol className="flow-list replay-list">
            {visible.map((e) => (
              <li key={e.eventId} className={e.seq === cursor + 1 ? "selected" : ""} onClick={() => { setPlaying(false); setCursor(e.seq - 1); }}>
                <span className="event-seq">#{e.seq}</span>
                <span className="flow-type">{e.type}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
