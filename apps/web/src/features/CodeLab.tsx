/**
 * 受控代码实验室（T38/T39/T40 前端）。
 * 三态面板：运行快照（只读）/ 个人草稿（可编辑）/ 基线-草稿 diff。
 * 保存不触发模型与执行；校验零模型调用；采用后用于下一次显式运行。
 */
import { useCallback, useEffect, useState } from "react";
import { api, type DraftDto } from "../api";
import { lineDiff } from "../diff";

export function CodeLabPanel(props: {
  lessonId: string;
  sessionId: string;
  currentRevisionId: string;
  onAdopted: (revisionId: string) => void;
}) {
  const { lessonId, currentRevisionId, onAdopted } = props;
  const [draft, setDraft] = useState<DraftDto | null>(null);
  const [baseline, setBaseline] = useState<Record<string, string>>({});
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [view, setView] = useState<"draft" | "diff">("draft");
  const [status, setStatus] = useState<string>("");
  const [validation, setValidation] = useState<{ status: string; gates: Record<string, string>; revisionId?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const d = await api.createDraft(lessonId); // 幂等：服务端对同一课程返回既有草稿
      setDraft(d.draft);
      setBaseline(d.draft.files);
      setActiveFile(Object.keys(d.draft.files)[0] ?? null);
    } catch {
      setStatus("本课程未开放代码编辑");
    }
  }, [lessonId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!draft) return <p className="muted">{status || "加载草稿…"}</p>;

  const files = draft.files;
  const changed = Object.keys(baseline).filter((p) => files[p] !== baseline[p]);

  const save = async (): Promise<void> => {
    if (activeFile == null) return;
    setBusy(true);
    try {
      const r = await api.saveDraft(draft.id, draft.revision, files);
      setDraft(r.draft);
      setStatus(`已保存草稿 v${r.draft.revision}（保存不触发模型/执行）`);
      setValidation(null);
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  const validate = async (): Promise<void> => {
    setBusy(true);
    setValidation(null);
    try {
      const r = await api.validateDraft(draft.id);
      setValidation({ status: r.status, gates: r.report.safetyGates, revisionId: r.revisionId });
      setStatus(r.status === "passed" ? "校验通过：可以采用此版本试跑" : "安全门槛未通过：此版本不能执行");
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  };

  const adopt = async (): Promise<void> => {
    if (!validation?.revisionId) return;
    onAdopted(validation.revisionId);
    setStatus(`已采用版本 ${validation.revisionId}；下一次发送将使用新版本真实运行。当前活动运行不受影响。`);
  };

  const value = activeFile != null ? files[activeFile] ?? "" : "";
  const baseValue = activeFile != null ? baseline[activeFile] ?? "" : "";

  return (
    <div className="code-lab">
      <div className="cl-toolbar">
        <span className={`cl-badge ${changed.length > 0 ? "badge-warn" : ""}`}>
          {changed.length > 0 ? `个人草稿（${changed.length} 个文件已修改）` : "与课程基线一致"}
        </span>
        <button disabled={busy} onClick={() => void save()}>保存草稿</button>
        <button disabled={busy} className="primary" onClick={() => void validate()}>校验与构建</button>
        <button disabled={busy || validation?.status !== "passed"} className="primary" onClick={() => void adopt()}>
          采用此版本
        </button>
      </div>

      <div className="cl-files">
        {Object.keys(files).map((p) => (
          <button key={p} className={p === activeFile ? "active" : ""} onClick={() => setActiveFile(p)}>
            {p}
            {files[p] !== baseline[p] ? " *" : ""}
          </button>
        ))}
        <span className="spacer" />
        {(["draft", "diff"] as const).map((v) => (
          <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>
            {v === "draft" ? "编辑" : "差异"}
          </button>
        ))}
      </div>

      {view === "draft" ? (
        <textarea
          className="code-editor"
          value={value}
          onChange={(e) => {
            const next = { ...files, [activeFile!]: e.target.value };
            setDraft({ ...draft, files: next });
          }}
          spellCheck={false}
        />
      ) : (
        <div className="diff-view mono">
          {lineDiff(baseValue, value).map((l, i) => (
            <div key={i} className={`diff-line d-${l.kind}`}>
              <span className="diff-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>
              {l.text || " "}
            </div>
          ))}
        </div>
      )}

      {validation && (
        <div className={`validation ${validation.status}`}>
          <b>安全门槛</b>
          <ul className="gates">
            {Object.entries(validation.gates).map(([k, v]) => (
              <li key={k} className={`gate gate-${v}`}>{k}: {v}</li>
            ))}
          </ul>
          {validation.revisionId && <p>构建版本：<code>{validation.revisionId}</code></p>}
          <p className="muted small">校验通过 ≠ 任务完成；教学行为断言失败可探索试跑，但不能晋级课程版本。</p>
        </div>
      )}

      {status && <p className="cl-status">{status}</p>}
      <p className="muted small">
        当前会话执行版本：<code>{currentRevisionId.slice(0, 24)}…</code>（活动运行不受草稿影响；修改后的版本经校验并采用后，用于下一次显式发送）
      </p>
    </div>
  );
}
