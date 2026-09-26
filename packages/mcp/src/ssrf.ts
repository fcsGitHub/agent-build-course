/**
 * SSRF 防护（T22/T25）。远程 endpoint 与 http_fetch 目标统一校验：
 * 仅 http(s)、拒绝回环/私网/链路本地/元数据地址；解析后 IP 再复核（DNS rebinding 防护为部署项）。
 * 依据设计文档 v1.1 §14.3、§20.4。
 */
import { isIP } from "node:net";
import { lookup } from "node:dns";

export class SSRFError extends Error {
  constructor(public readonly code: "SSRF_SCHEME" | "SSRF_HOSTNAME" | "SSRF_PRIVATE_ADDRESS", message: string) {
    super(message);
    this.name = "SSRFError";
  }
}

export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 0) return true;
  if (ip === "::1" || ip === "::") return true;
  if (ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true; // link-local / ULA
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return ip !== ip; // 非 IPv4 点分（IPv6 已在上面处理）
  const [a, b] = parts as [number, number];
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // metadata 地址段
  if (a === 0) return true;
  return false;
}

export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SSRFError("SSRF_HOSTNAME", `URL 无法解析: ${truncate(raw, 80)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SSRFError("SSRF_SCHEME", `仅允许 http(s): ${url.protocol}`);
  }
  const host = url.hostname;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new SSRFError("SSRF_HOSTNAME", `内网主机名不允许: ${host}`);
  }
  const ipLike = host.replace(/^\[|\]$/g, "");
  if (isIP(ipLike) !== 0 && isPrivateIp(ipLike)) {
    throw new SSRFError("SSRF_PRIVATE_ADDRESS", `私网/回环地址不允许: ${host}`);
  }
  return url;
}

/** 域名白名单检查（http_fetch 用） */
export function assertAllowedHost(hostname: string, allowedHosts: string[]): void {
  if (allowedHosts.length === 0) {
    throw new SSRFError("SSRF_HOSTNAME", "未配置任何允许域名（默认全拒绝）");
  }
  const ok = allowedHosts.some((h) => hostname === h || hostname.endsWith(`.${h}`));
  if (!ok) {
    throw new SSRFError("SSRF_HOSTNAME", `域名不在白名单: ${hostname}`);
  }
}

/** DNS 解析后复核所有地址均为公网（防 DNS rebinding 的第一层） */
export function assertResolvesPublic(hostname: string): Promise<void> {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true }, (err, addresses) => {
      if (err) {
        reject(new SSRFError("SSRF_HOSTNAME", `DNS 解析失败: ${hostname}`));
        return;
      }
      for (const a of addresses) {
        if (isPrivateIp(a.address)) {
          reject(new SSRFError("SSRF_PRIVATE_ADDRESS", `${hostname} 解析到私网地址 ${a.address}`));
          return;
        }
      }
      resolve();
    });
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
