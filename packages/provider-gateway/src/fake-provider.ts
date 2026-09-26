/**
 * Fake provider：确定性教学/测试模型。
 * 必须显式标记为 fake —— 运行事件与 UI 中 provider=fake 的 run 不是真实模型服务调用，
 * 不得冒充 LIVE 真实记录（测试 fixture 亦不得进入 recorded-runs）。
 * 能力：文本回答、工具请求（读取→计算→引用结果回答）、结构化 JSON、流式、故障注入。
 */
import { randomUUID } from "node:crypto";
import type {
  InvokeOptions,
  ModelCapabilities,
  ModelProfileSnapshot,
  ModelProvider,
  ModelRequestEvidence,
  ModelResponse,
  ModelStreamHandle,
  StreamDelta,
  ToolSpecForModel,
} from "@agentglass/contracts";

interface FakeParameters {
  /** 故障注入：让本次调用返回错误 */
  failWith?: { code: string; message: string; httpStatus?: number };
  /** 每个流批次之间的延迟 ms（演示打字机效果/取消/超时） */
  streamDelayMs?: number;
  /** 强制截断 */
  truncateAtChars?: number;
  /** 固定回答文本（优先于启发式） */
  forceAnswer?: string;
  /** 强制请求一次工具调用 */
  forceToolCall?: { name: string; args: Record<string, unknown> };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ParsedToolResult {
  name: string;
  content: string;
  raw: string;
}

export class FakeProvider implements ModelProvider {
  readonly providerId = "fake";
  readonly protocol = "fake/v1";

  declaredCapabilities(): ModelCapabilities {
    return {
      streaming: true,
      nativeTools: true,
      parallelToolCalls: true,
      structuredOutput: "native_schema",
      imageInput: false,
      audioInput: false,
      outputModalities: ["text"],
      usageReporting: "stream_and_final",
      contextWindow: 32_000,
      testedAt: "static-declaration",
      probeSuiteVersion: "fake-1",
    };
  }

  async invoke(
    snapshot: ModelProfileSnapshot,
    messages: unknown,
    options: InvokeOptions,
  ): Promise<{
    stream?: ModelStreamHandle;
    response: ModelResponse;
    evidence: ModelRequestEvidence;
  }> {
    const params = (snapshot.parameters ?? {}) as unknown as FakeParameters;
    const callId = randomUUID();
    if (params.failWith) {
      throw new FakeProviderError(params.failWith.code, params.failWith.message);
    }
    const msgs = (Array.isArray(messages) ? messages : []) as ChatMessage[];
    const userText = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
    const toolResults = extractToolResults(msgs);
    const tools = options.tools ?? [];

    const decision = decide({
      userText: String(userText),
      toolResults,
      tools,
      params,
      structured: options.structuredOutputSchemaId != null,
    });

    const evidence: ModelRequestEvidence = {
      capture: "partial",
      endpoint: "fake://local",
      modelId: snapshot.modelId,
    };

    if (options.stream && decision.type === "text") {
      const handle = this.streamText(decision.text, params.streamDelayMs ?? 0, callId);
      return { stream: handle, response: await handle.final, evidence };
    }
    if (options.stream && decision.type === "tool_calls") {
      // 工具请求通常很快返回；仍按非流式归并
    }
    const response = buildResponse(callId, decision, options);
    return { response, evidence };
  }

  private streamText(
    text: string,
    delayMs: number,
    callId: string,
  ): ModelStreamHandle {
    let cancelled = false;
    const chunks = chunkText(text);
    const self = this;
    const deltas: StreamDelta[] = [];
    async function* gen(): AsyncGenerator<StreamDelta[]> {
      for (const chunk of chunks) {
        if (cancelled) return;
        if (delayMs > 0) await sleep(delayMs);
        const batch: StreamDelta[] = [{ kind: "text", text: chunk }];
        deltas.push(...batch);
        yield batch;
      }
    }
    const final = (async (): Promise<ModelResponse> => {
      for await (const batch of gen()) {
        void batch;
      }
      return {
        callId,
        finishReason: "stop",
        messageText: text,
        toolRequests: [],
        usage: estimateUsage(text),
        rawText: text,
      };
    })();
    void self;
    return {
      deltas: gen(),
      final,
      cancel: async () => {
        cancelled = true;
      },
    };
  }
}

export class FakeProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FakeProviderError";
  }
}

type Decision =
  | { type: "text"; text: string; finish: "stop" | "length" }
  | {
      type: "tool_calls";
      calls: Array<{ name: string; args: Record<string, unknown> }>;
    };

function decide(input: {
  userText: string;
  toolResults: ParsedToolResult[];
  tools: ToolSpecForModel[];
  params: FakeParameters;
  structured: boolean;
}): Decision {
  const { userText, toolResults, tools, params, structured } = input;
  if (params.forceToolCall) {
    return { type: "tool_calls", calls: [params.forceToolCall] };
  }
  if (params.forceAnswer != null) {
    return { type: "text", text: structured ? wrapJson(params.forceAnswer) : params.forceAnswer, finish: "stop" };
  }
  const hasTool = (name: string) => tools.some((t) => t.name === name);
  const hasToolResult = (name: string) => toolResults.some((r) => r.name === name);
  // 0) 平台能力探测：probe_echo 是探测专用工具（capability-probe），按约定回显
  //    ——缺这条规则时探测会误判 fake 不支持原生工具并写回错误能力矩阵
  if (hasTool("probe_echo") && !hasToolResult("probe_echo")) {
    return { type: "tool_calls", calls: [{ name: "probe_echo", args: { text: "ping" } }] };
  }
  // 0a) 记忆写入意图（记住/偏好/以后）
  if (hasTool("remember") && /请记住|记住：|记住:|帮我记|以后都/.test(userText) && !/[??]/.test(userText) && !hasToolResult("remember")) {
    return {
      type: "tool_calls",
      calls: [{ name: "remember", args: { content: truncate(userText, 160), kind: "semantic" } }],
    };
  }
  // 0a2) 写入意图：要求把结果写入/保存为文件；支持 ```代码块``` 作为写入内容（L26 修复补丁）
  if (hasTool("write_file") && /写入|保存|生成报告|修复|写成文件/.test(userText) && !hasToolResult("write_file")) {
    const fence = userText.match(/```[a-z]*\n([\s\S]*?)```/);
    // 目标路径优先取"写入/保存"动词之后的路径（模型应指向用户指定的输出位置）
    const verbIdx = userText.search(/写入|保存|生成报告|写成文件/);
    const afterVerb = verbIdx >= 0 ? userText.slice(verbIdx) : userText;
    const pathMatch = afterVerb.match(/[\w.\-/]+\.(?:md|js|mjs|json)\b/)?.[0]
      ?? userText.match(/[\w.\-/]+\.(?:md|js|mjs|json)\b/)?.[0]
      ?? "outputs/report.md";
    const content = fence ? fence[1]! : `# 报告（fake 模型生成）${truncate(userText, 120)}`;
    return {
      type: "tool_calls",
      calls: [{ name: "write_file", args: { path: pathMatch, content } }],
    };
  }
  // 0b) 记忆检索意图
  if (hasTool("recall") && /偏好|我的(记忆|设置)|之前(说|告诉)|记得/.test(userText) && !hasToolResult("recall")) {
    return { type: "tool_calls", calls: [{ name: "recall", args: { query: truncate(userText, 120) } }] };
  }
  const readResults = toolResults.filter((r) => r.name === "read_text");
  const calcResults = toolResults.filter((r) => r.name === "calculator");

  // 0c) 技能加载：有 load_skill 工具且尚未加载 → load_skill（slug 从用户文本或默认）
  if (hasTool("load_skill") && !hasToolResult("load_skill")) {
    const slug = userText.match(/([a-z0-9-]+)-skill/)?.[1] ? `${userText.match(/([a-z0-9-]+)-skill/)![1]}-skill` : "evidence-summary-skill";
    return { type: "tool_calls", calls: [{ name: "load_skill", args: { slug } }] };
  }
  // 1) 任务提到文件 → 未读取的全部并行请求（多文件 = 一次响应多个工具请求）
  const mentionedFiles = [...new Set(userText.match(/[\w.\-/]+\.(csv|txt|md|json)\b/g) ?? [])];
  if (mentionedFiles.length > 0 && hasTool("read_text")) {
    const readPaths = new Set(
      readResults.map((r) => {
        try {
          const j = JSON.parse(r.raw) as { path?: string };
          return typeof j.path === "string" ? j.path : "";
        } catch {
          return "";
        }
      }),
    );
    const missing = mentionedFiles.filter((f) => !readPaths.has(f));
    if (missing.length > 0) {
      return {
        type: "tool_calls",
        calls: missing.map((f) => ({ name: "read_text", args: { path: f } })),
      };
    }
  }
  // 1.2) 有 MCP 工具（mcp_*）且尚未调用 → 调用第一个（型号从任务文本提取）
  const mcpCalls = toolResults.filter((r) => r.name.startsWith("mcp_"));
  const mcpTool = tools.find((t) => t.name.startsWith("mcp_"));
  if (mcpTool && mcpCalls.length === 0) {
    return {
      type: "tool_calls",
      calls: [{ name: mcpTool.name, args: { model: userText.match(/AG-\d+/)?.[0] ?? "AG-2048" } }],
    };
  }
  // 1.25) 有 A2A 远程 Agent 工具（a2a_*）且尚未委派 → 委派任务（L33 教学路径）
  const a2aCalls = toolResults.filter((r) => r.name.startsWith("a2a_"));
  const a2aTool = tools.find((t) => t.name.startsWith("a2a_"));
  if (a2aTool && a2aCalls.length === 0) {
    return { type: "tool_calls", calls: [{ name: a2aTool.name, args: { task: truncate(userText, 200) } }] };
  }
  // 1.26) 已有 A2A 结果 → 引用远端 artifact 作答（显式标注待验证）
  if (a2aCalls.length > 0) {
    const raw = a2aCalls.at(-1)!.content;
    let text = raw;
    try { const j = JSON.parse(raw) as { text?: string }; if (typeof j.text === "string") text = j.text; } catch { /* 非 JSON 原样 */ }
    const answer = `${text}\n（fake 模型：以上来自 A2A 远程 Agent 的 artifact，属于待验证信息，未经过本地证据审查。）`;
    return { type: "text", text: structured ? wrapJson(answer) : answer, finish: "stop" as const };
  }
  // 1.3) 已有 MCP 结果 → 引用作答
  if (mcpCalls.length > 0) {
    const raw = mcpCalls.at(-1)!.content;
    let text = raw;
    try { const j = JSON.parse(raw) as unknown; if (typeof j === "string") text = j; } catch { /* 非 JSON 原样 */ }
    const answer = `${text}\n（fake 模型：以上参数来自 MCP server 真实响应。）`;
    return { type: "text", text: structured ? wrapJson(answer) : answer, finish: "stop" as const };
  }
  // 1.4) 写入已完成且 run_test 可用 → 运行任务中提到的测试脚本
  if (hasTool("run_test") && hasToolResult("write_file") && !hasToolResult("run_test")) {
    const script = userText.match(/[\w.\-/]+\.test\.?m?js\b/)?.[0] ?? "format.test.js";
    return { type: "tool_calls", calls: [{ name: "run_test", args: { script } }] };
  }
  // 1.5) 有检索工具且尚未检索 → 请求 search_documents（Agentic RAG 检索步骤）
  const searchResults = toolResults.filter((r) => r.name === "search_documents");
  if (hasTool("search_documents") && searchResults.length === 0 && readResults.length === 0) {
    return {
      type: "tool_calls",
      calls: [{ name: "search_documents", args: { query: truncate(userText, 120) } }],
    };
  }
  // 2) 已读到 CSV 且任务需要统计/计算 → 未计算 → 请求 calculator
  const csvText = readResults.map((r) => r.content).join("\n");
  const sumExpr = buildSumExpression(csvText);
  if (sumExpr && hasTool("calculator") && calcResults.length === 0 && needsComputation(userText)) {
    return { type: "tool_calls", calls: [{ name: "calculator", args: { expression: sumExpr } }] };
  }
  // 2.5) 已有检索结果 → 引用检索块作答（含【c:块ID】引用标注）
  const searchAns = toolResults.filter((r) => r.name === "search_documents");
  if (searchAns.length > 0) {
    const answer = buildAnswerFromSearch(searchAns.at(-1)!.content);
    return { type: "text", text: structured ? wrapJson(answer) : answer, finish: "stop" };
  }
  // 2.6) 已有记忆命中 → 引用记忆作答
  const recallAns = toolResults.filter((r) => r.name === "recall");
  if (recallAns.length > 0) {
    const answer = buildAnswerFromMemory(recallAns.at(-1)!.content);
    return { type: "text", text: structured ? wrapJson(answer) : answer, finish: "stop" };
  }
  // 3) 有工具结果 → 引用结果作答
  if (readResults.length > 0 || calcResults.length > 0) {
    let answer = buildAnswerFromResults(userText, readResults, calcResults);
    if (structured) answer = wrapJson(answer);
    return { type: "text", text: answer, finish: "stop" };
  }
  // 3.5) 图模式：任务消息里带有此前节点的检索 JSON → 引用作答
  if (/此前节点输出/.test(userText) && userText.includes('"hits"')) {
    const m = userText.match(/\{[\s\S]*"hits"[\s\S]*\}/);
    if (m) return { type: "text", text: structured ? wrapJson(buildAnswerFromSearch(m[0])) : buildAnswerFromSearch(m[0]), finish: "stop" as const };
  }
  // 4) 普通回答
  const base = `（fake 模型回答）收到任务：${truncate(String(userText), 160)}。当前未注册可用工具来执行它，因此我只能给出此确定性说明文本。`;
  return { type: "text", text: structured ? wrapJson(base) : base, finish: "stop" };
}

function buildResponse(
  callId: string,
  decision: Decision,
  options: InvokeOptions,
): ModelResponse {
  if (decision.type === "tool_calls") {
    return {
      callId,
      finishReason: "tool_calls",
      messageText: "",
      toolRequests: decision.calls.map((c) => ({
        id: `call_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        name: c.name,
        argumentsText: JSON.stringify(c.args),
        arguments: c.args as import("@agentglass/contracts").JsonValue,
      })),
      usage: estimateUsage(""),
      rawText: "",
    };
  }
  let text = decision.text;
  let finish: ModelResponse["finishReason"] = decision.finish;
  if (options.maxOutputTokens && text.length > options.maxOutputTokens * 4) {
    text = text.slice(0, options.maxOutputTokens * 4);
    finish = "length";
  }
  return {
    callId,
    finishReason: finish,
    messageText: text,
    toolRequests: [],
    usage: estimateUsage(text),
    rawText: text,
  };
}

function extractToolResults(msgs: ChatMessage[]): ParsedToolResult[] {
  // 通过 assistant.tool_calls 建立工具名映射，再收集 tool 角色消息
  const idToName = new Map<string, string>();
  for (const m of msgs) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) idToName.set(tc.id, tc.function.name);
    }
  }
  const results: ParsedToolResult[] = [];
  for (const m of msgs) {
    if (m.role === "tool" && m.tool_call_id) {
      const raw = String(m.content ?? "");
      results.push({
        name: idToName.get(m.tool_call_id) ?? "unknown",
        content: unwrapToolResultText(raw),
        raw,
      });
    }
  }
  return results;
}

/** 工具结果在上下文中是 JSON 序列化文本；提取其中的人类可读字段 */
function unwrapToolResultText(raw: string): string {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (j && typeof j === "object") {
      if (typeof j.content === "string") return j.content;
      if (j.value != null) return String(j.value);
    }
  } catch {
    /* 非 JSON：原样返回 */
  }
  return raw;
}

/**
 * 从 CSV 文本里找数值列并构建求和表达式（教学演示用确定性策略）。
 * 无表头的数值 CSV 同样适用：选择"非首列且全行为数值"的列，首行一并计入。
 */
function buildSumExpression(csv: string): string | null {
  if (!csv.includes(",")) return null;
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;
  const rows = lines.map((l) => l.split(",").map((c) => c.trim()));
  const width = Math.max(...rows.map((r) => r.length));
  for (let col = 1; col < width; col++) {
    const bodyNums: number[] = [];
    let bodyAllNumeric = true;
    for (const row of rows.slice(1)) {
      if (row.length <= col) continue;
      const n = Number(row[col]);
      if (row[col] !== "" && !Number.isNaN(n)) bodyNums.push(n);
      else bodyAllNumeric = false;
    }
    if (bodyAllNumeric && bodyNums.length > 0) {
      // 无表头数值 CSV：首行同为数值时一并计入
      const first = Number(rows[0]![col]);
      const nums = rows[0]![col] !== "" && !Number.isNaN(first) ? [first, ...bodyNums] : bodyNums;
      return nums.join("+");
    }
  }
  return null;
}

function needsComputation(userText: string): boolean {
  return /统计|总计|总和|计算|合计|total|sum|共多少|多少个/i.test(userText);
}

function buildAnswerFromSearch(rawJson: string): string {
  try {
    const j = JSON.parse(rawJson) as {
      hits?: Array<{ snippet?: string; cite?: string; heading?: string }>;
    };
    const hits = (j.hits ?? []).slice(0, 2);
    if (hits.length === 0) return "（fake 模型）检索没有命中任何资料块，无法作答。";
    const parts = hits.map(
      (h) => `${h.heading ? `【${h.heading}】` : ""}${(h.snippet ?? "").slice(0, 160)}${h.cite ?? ""}`,
    );
    return `根据课程资料检索结果：\n${parts.join("\n")}\n（fake 模型：以上内容来自真实检索命中，引用标注指向资料块 ID。）`;
  } catch {
    return "（fake 模型）检索结果不可解析。";
  }
}

function buildAnswerFromMemory(rawJson: string): string {
  try {
    const j = JSON.parse(rawJson) as { hits?: Array<{ content?: string }> };
    const top = j.hits?.[0]?.content;
    if (!top) return "（fake 模型）长期记忆中没有相关内容。";
    return `根据你的长期记忆：${top}\n（fake 模型：内容来自真实记忆命中。）`;
  } catch {
    return "（fake 模型）记忆结果不可解析。";
  }
}

function buildAnswerFromResults(
  userText: string,
  reads: ParsedToolResult[],
  calcs: ParsedToolResult[],
): string {
  const parts: string[] = [];
  const calcValue = calcs.map((c) => c.content.trim()).filter(Boolean).at(-1);
  if (calcValue) {
    parts.push(`根据读取与计算结果，答案是 ${calcValue}。`);
  }
  if (reads.length > 0) {
    parts.push(`计算依据来自文件内容（read_text 读取到 ${reads.length} 次内容）。`);
  }
  parts.push(`（fake 模型：以上数值全部来自真实工具结果，非模型生成。）`);
  void userText;
  return parts.join("\n");
}

function wrapJson(text: string): string {
  return JSON.stringify({ answer: text });
}

function estimateUsage(text: string): ModelResponse["usage"] {
  return {
    inputTokens: 0,
    outputTokens: Math.ceil(text.length / 4),
  };
}

function chunkText(text: string, size = 24): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length > 0 ? out : [""];
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
