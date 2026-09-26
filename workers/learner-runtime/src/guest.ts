/**
 * 隔离客体 shim（T40）。由 host 以受限环境 fork；只加载冻结构建并通过 IPC 响应
 * 扩展点调用。本进程不获得平台密钥、数据库或网络能力；宿主逐次核验后才能
 * 经代理访问模型/工具。
 */
process.title = "agentglass-guest";

const bundlePath = process.argv[2];
if (!bundlePath) {
  // eslint-disable-next-line no-console
  console.error("usage: guest.cjs <bundle.cjs>");
  process.exit(2);
}

type GuestMessage =
  | { kind: "invoke"; id: number; slot: string; arg: unknown }
  | { kind: "dispose" };

let mod: Record<string, unknown> | undefined;

process.on("message", (raw: GuestMessage) => {
  if (raw.kind === "dispose") {
    process.exit(0);
  }
  if (raw.kind !== "invoke") return;
  const respond = (payload: unknown): void => {
    if (typeof process.send === "function") process.send(payload);
  };
  try {
    if (!mod) {
      // 冻结构建由服务端校验后写入；此处仅加载，不做任何网络/文件访问
      mod = require(bundlePath) as Record<string, unknown>;
    }
    const fn = mod?.[raw.slot];
    if (typeof fn !== "function") {
      respond({ id: raw.id, ok: false, error: `EXTENSION_SLOT_NOT_BOUND: ${raw.slot}` });
      return;
    }
    const value = fn(raw.arg);
    // 结果必须可序列化（结构化克隆边界）
    respond({ id: raw.id, ok: true, value: JSON.parse(JSON.stringify(value ?? null)) });
  } catch (err) {
    respond({ id: raw.id, ok: false, error: String(err).slice(0, 500) });
  }
});
