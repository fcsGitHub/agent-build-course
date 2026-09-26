import { useCallback, useEffect, useState } from "react";
import { api, type RunRow, type CompareRow } from "../api";

export function HistoryPage(props: { onOpenReplay: (runId: string) => void }) {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [compareSel, setCompareSel] = useState<string[]>([]);
  const [compare, setCompare] = useState<{ runs: CompareRow[] } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setRuns((await api.history()).runs);
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 1500);
    return () => clearInterval(t);
  }, [load]);

  const toggleCompare = (id: string): void => {
    setCompareSel((sel) =>
      sel.includes(id) ? sel.filter((x) => x !== id) : sel.length < 4 ? [...sel, id] : sel,
    );
  };

  const runCompare = async (): Promise<void> => {
    if (compareSel.length >= 2) setCompare(await api.compare(compareSel));
  };

  return (
    <div className="history">
      <h1>历史与对照</h1>
      <div className="history-actions">
        <span className="muted">选择 2-4 个运行进行对照（相同任务、不同代码/输入/预算）。</span>
        <button disabled={compareSel.length < 2} onClick={() => void runCompare()}>对照</button>
      </div>
      {compare && <CompareTable rows={compare.runs} />}
      <table className="runs-table">
        <thead>
          <tr>
            <th>对照</th><th>运行 ID</th><th>课程</th><th>模式</th><th>状态</th><th>停止原因</th><th>输入</th><th>时间</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td><input type="checkbox" checked={compareSel.includes(r.id)} onChange={() => toggleCompare(r.id)} /></td>
              <td><code>{r.id.slice(0, 14)}…</code></td>
              <td>{r.lesson_id}</td>
              <td>{r.mode.toUpperCase()}</td>
              <td><span className={`badge st-${r.state}`}>{r.state}</span></td>
              <td>{r.stop_reason ?? "—"}</td>
              <td className="muted">{r.input_preview.slice(0, 40)}</td>
              <td className="muted">{new Date(r.created_at).toLocaleTimeString()}</td>
              <td>
                <button onClick={() => props.onOpenReplay(r.id)}>回放</button>
                <a className="btn-link" href={api.exportRun(r.id)} download={`${r.id}.agtrace.zip`}>导出</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CompareTable({ rows }: { rows: CompareRow[] }) {
  return (
    <table className="compare-table">
      <thead>
        <tr><th>维度</th>{rows.map((r) => <th key={r.runId}>{r.runId.slice(0, 10)}…</th>)}</tr>
      </thead>
      <tbody>
        <tr><td>输入</td>{rows.map((r) => <td key={r.runId}>{r.inputPreview.slice(0, 50)}</td>)}</tr>
        <tr><td>状态 / 停止原因</td>{rows.map((r) => <td key={r.runId}>{r.state}{r.stopReason ? `（${r.stopReason}）` : ""}</td>)}</tr>
        <tr><td>模型调用次数</td>{rows.map((r) => <td key={r.runId}>{r.modelCalls}</td>)}</tr>
        <tr><td>工具调用次数</td>{rows.map((r) => <td key={r.runId}>{r.toolCalls}</td>)}</tr>
        <tr><td>Tokens（入/出）</td>{rows.map((r) => <td key={r.runId}>{r.usage.input} / {r.usage.output}</td>)}</tr>
        <tr><td>最终回答</td>{rows.map((r) => <td key={r.runId} className="mono">{r.finalText.slice(0, 200)}</td>)}</tr>
      </tbody>
    </table>
  );
}
