/**
 * 秘密存储（T02 本地模式）。服务端保存秘密引用；密钥本体来自进程环境，
 * 不进入快照、不进入日志、不通过 API 返回。
 * 依据设计文档 v1.1 第 20.2 节。
 */

export interface SecretResolution {
  /** 找到时返回真实值；未找到返回 undefined（调用方显示"密钥缺失"而不是伪造） */
  value?: string;
  masked: string;
}

export interface SecretStore {
  resolve(ref: string, scope: string): SecretResolution;
}

/** 本地模式：secretRef 形如 env:AGENTGLASS_OPENAI_API_KEY */
export class EnvSecretStore implements SecretStore {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  resolve(ref: string, scope: string): SecretResolution {
    void scope;
    if (!ref.startsWith("env:")) {
      return { masked: "***" };
    }
    const name = ref.slice(4);
    const value = this.env[name];
    return {
      value: value && value.length > 0 ? value : undefined,
      masked: maskSecret(value),
    };
  }
}

export function maskSecret(value: string | undefined): string {
  if (!value || value.length === 0) return "[MISSING]";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 3)}…${value.slice(-3)}`;
}

/** 深度脱敏：从任意对象中移除/掩码常见秘密字段（wire capture、日志、导出共用） */
export function redactSensitive<T>(value: T): T {
  return redactWalk(value, new WeakSet()) as T;
}

function redactWalk(v: unknown, seen: WeakSet<object>): unknown {
  if (typeof v === "string") {
    return v.replace(/\b(sk|rk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_KEY]");
  }
  if (Array.isArray(v)) return v.map((x) => redactWalk(x, seen));
  if (v && typeof v === "object") {
    if (seen.has(v as object)) return "[CIRCULAR]";
    seen.add(v as object);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (/^(authorization|api[_-]?key|secret|token|password|cookie)$/i.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactWalk(val, seen);
      }
    }
    return out;
  }
  return v;
}
