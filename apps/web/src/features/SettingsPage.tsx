import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

interface ProfileRow {
  id: string;
  name: string;
  provider: string;
  endpoint: string;
  modelId: string;
  probed: boolean;
  secretRef: string | null;
  secretMasked: string | null;
}

export function SettingsPage() {
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [form, setForm] = useState({ name: "", provider: "openai-compatible", endpoint: "", modelId: "", secretRef: "" });
  const [message, setMessage] = useState("");
  const [probe, setProbe] = useState<{ id: string; steps: Array<{ step: string; passed: boolean; detail: string }>; ok: boolean } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setProfiles((await api.profiles()).profiles);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (): Promise<void> => {
    if (!form.name || !form.modelId) {
      setMessage("名称与模型 ID 必填");
      return;
    }
    if (form.provider !== "fake" && !/^https?:\/\//.test(form.endpoint)) {
      setMessage(`${form.provider} 提供方需要 http(s) endpoint`);
      return;
    }
    if (form.secretRef && !form.secretRef.startsWith("env:")) {
      setMessage("密钥引用必须以 env: 开头（变量名）。不要把密钥本体填在这里：请将其设为环境变量后重启服务，这里只填 env:变量名。");
      return;
    }
    try {
      await api.createProfile({
        name: form.name,
        provider: form.provider,
        endpoint: form.endpoint,
        modelId: form.modelId,
        secretRef: form.secretRef || undefined,
      });
      setForm({ name: "", provider: "openai-compatible", endpoint: "", modelId: "", secretRef: "" });
      setMessage("已保存（密钥只保存引用，永不回显）");
      await load();
    } catch (err) {
      setMessage(String(err));
    }
  };

  const runProbe = async (id: string): Promise<void> => {
    setMessage("探测会发送少量真实请求（fake 提供方除外）…");
    try {
      const r = await api.probeProfile(id);
      setProbe({ id, ...r });
      setMessage(r.ok ? "探测完成：全部能力可用" : "探测完成：部分能力不可用（对应实验将禁用）");
      await load();
    } catch (err) {
      setMessage(String(err));
    }
  };

  const endpointPlaceholder =
    form.provider === "anthropic"
      ? "例如：https://open.bigmodel.cn/api/anthropic"
      : "例如：https://api.deepseek.com（DeepSeek）/ https://api.openai.com/v1";

  return (
    <div className="settings">
      <h1>设置 — 模型</h1>
      <p className="muted">
        未配置有效模型时，实验台不能发起实时运行（历史回放不受影响）。
        密钥通过环境变量提供（如 <code>AGENTGLASS_OPENAI_API_KEY</code>），系统只保存引用；
        环境变量需在<strong>启动 API 与 worker 的终端</strong>里设置，进程已在运行时新设置的变量要<strong>重启服务</strong>后才会被读到。
        「密钥」列显示 <code>[MISSING]</code> 表示当前服务进程读不到该变量。
      </p>

      <table className="runs-table">
        <thead>
          <tr><th>名称</th><th>提供方</th><th>模型</th><th>Endpoint</th><th>密钥</th><th>已探测</th><th>操作</th></tr>
        </thead>
        <tbody>
          {profiles.map((p) => {
            const missing = p.secretRef != null && p.secretMasked === "[MISSING]";
            return (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.provider}{p.provider === "fake" ? "（模拟）" : ""}</td>
                <td><code>{p.modelId}</code></td>
                <td className="muted">{p.endpoint || "—"}</td>
                <td>
                  {p.secretRef == null ? (
                    <span className="muted">—</span>
                  ) : missing ? (
                    <code className="secret-missing" title={`环境变量 ${p.secretRef.slice(4)} 未设置或为空：请在启动服务的终端设置后重启 API 与 worker`}>[MISSING] {p.secretRef}</code>
                  ) : (
                    <code title={p.secretRef ?? undefined}>{p.secretMasked}</code>
                  )}
                </td>
                <td>{p.probed ? "✓" : "未探测"}</td>
                <td><button onClick={() => void runProbe(p.id)}>探测</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {probe && (
        <div className="probe-report">
          <b>探测报告（{probe.id}）</b>
          <ul>
            {probe.steps.map((s) => (
              <li key={s.step} className={s.passed ? "gate-passed" : "gate-failed"}>
                {s.step}: {s.passed ? "✓" : "✗"} — {s.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      <h2>新增模型配置</h2>
      <div className="settings-form">
        <label>名称 <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：本地 Qwen / DeepSeek" /></label>
        <label>
          提供方
          <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
            <option value="openai-compatible">openai-compatible（真实端点，OpenAI 协议）</option>
            <option value="anthropic">anthropic（真实端点，Messages 协议）</option>
            <option value="fake">fake（教学模拟，显式标记）</option>
          </select>
        </label>
        <label>Endpoint <input value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} placeholder={endpointPlaceholder} /></label>
        <label>模型 ID <input value={form.modelId} onChange={(e) => setForm({ ...form, modelId: e.target.value })} placeholder="例如：deepseek-chat" /></label>
        <label>
          密钥引用（env:变量名，不是密钥本体）
          <input value={form.secretRef} onChange={(e) => setForm({ ...form, secretRef: e.target.value })} placeholder="env:AGENTGLASS_OPENAI_API_KEY" />
        </label>
        <button className="primary" onClick={() => void create()}>保存</button>
        {message && <span className="muted">{message}</span>}
      </div>
    </div>
  );
}
