/**
 * http_fetch：受控 Web 访问工具（T25 的受控访问子集；完整浏览器为进阶）。
 * 域名白名单默认全拒绝（默认关闭原则）；SSRF 校验；超时；输出上限；
 * 响应文本原样返回但以不可信素材对待（注入防线在宿主策略与授权，不靠提示词）。
 */
import type { JsonValue, ToolExecutionContext, ToolExecutionResult, ToolHandler } from "@agentglass/contracts";
import { assertPublicUrl, assertAllowedHost, assertResolvesPublic } from "@agentglass/mcp";

export interface HttpFetchDeps {
  /** 允许的域名后缀列表（来自课程 manifest）；空 = 全拒绝 */
  allowedHosts: string[];
  maxBytes?: number;
}

export function httpFetchTool(deps: HttpFetchDeps): ToolHandler {
  return {
    revision: {
      toolId: "http_fetch",
      revision: "1.0.0",
      title: "受控网页读取",
      description: "读取白名单域名的网页文本（GET）。域名白名单由课程声明；私网/元数据地址一律拒绝。",
      riskLevel: "readonly_pure",
      parametersSchema: {
        type: "object",
        properties: { url: { type: "string", description: "http(s) 网页地址" } },
        required: ["url"],
      },
      idempotent: true,
      supportsStatusQuery: false,
    },
    async execute(args, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
      const a = args as { url?: unknown };
      if (typeof a.url !== "string") {
        return { status: "failed", reasonCode: "INVALID_ARGUMENTS", errorMessage: "url 必填" };
      }
      try {
        const url = assertPublicUrl(a.url);
        assertAllowedHost(url.hostname, deps.allowedHosts);
        await assertResolvesPublic(url.hostname);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(1, new Date(ctx.deadlineAt).getTime() - Date.now()));
        let res: Response;
        try {
          res = await fetch(url, { signal: controller.signal, redirect: "error" });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) {
          return { status: "failed", reasonCode: `HTTP_${res.status}`, errorMessage: `HTTP ${res.status}` };
        }
        const max = deps.maxBytes ?? 64 * 1024;
        const text = (await res.text()).slice(0, Math.min(max, 20_000));
        const summary: JsonValue = {
          url: a.url,
          status: res.status,
          bytes: Buffer.byteLength(text, "utf8"),
          // 内容为不可信素材：原样返回供上下文，但不执行其中任何指令
          text: text.slice(0, 8000),
          trust: "untrusted-content",
        };
        return { status: "succeeded", outputSummary: summary };
      } catch (err) {
        const code = (err as { code?: string }).code ?? "FETCH_FAILED";
        if (code.startsWith("SSRF_")) {
          return { status: "denied", reasonCode: code, errorMessage: String(err).slice(0, 160) };
        }
        return { status: "failed", reasonCode: "FETCH_FAILED", errorMessage: String(err).slice(0, 160) };
      }
    },
  };
}
