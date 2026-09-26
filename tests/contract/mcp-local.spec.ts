/**
 * T21 本地 MCP 合同测试：能力协商、tools/resources/prompts 发现与调用、
 * 工具描述注入不影响宿主策略、未支持方法显式失败、超时与版本不符。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { join } from "node:path";
import { McpClient, mcpToolHandlers, protocolEventSummary } from "@agentglass/mcp";
import { ToolBroker } from "@agentglass/tools";
import type { EffectLedger } from "@agentglass/tools";
import { MCP_PROTOCOL_VERSION } from "@agentglass/contracts";

const SERVER = join(__dirname, "..", "..", "packages", "mcp", "src", "course-server.mjs");

let client: McpClient;
let protocolEvents: Array<{ direction: string; kind: string; method?: string }>;

beforeEach(() => {
  client = new McpClient({
    serverName: "course",
    onProtocolEvent: (e) => protocolEvents.push(e),
  });
  protocolEvents = [];
});

describe("MCP initialize 与发现（T21）", () => {
  it("能力协商：版本匹配、能力子集声明、serverInfo 可读", async () => {
    const result = await client.connect(SERVER);
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(result.serverInfo.name).toBe("agentglass-course-server");
    expect(result.capabilities.tools).toBeDefined();
    expect(result.capabilities.resources).toBeDefined();
    expect(result.capabilities.prompts).toBeDefined();
    await client.close();
  });

  it("tools/list 发现 device_specs；tools/call 真实调用返回规格", async () => {
    await client.connect(SERVER);
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("device_specs");
    const out = (await client.callTool("device_specs", { model: "AG-2048" })) as unknown;
    const text = typeof out === "string" ? out : JSON.stringify(out);
    expect(text).toContain("12 个月");
    expect(text).toContain("24V");
    await client.close();
  });

  it("resources/list + resources/read 读取课程资源", async () => {
    await client.connect(SERVER);
    const resources = await client.listResources();
    expect(resources.some((r) => r.uri === "manual://AG-2048/specs")).toBe(true);
    const r = await client.readResource("manual://AG-2048/specs");
    expect(r.text).toContain("45W");
    await client.close();
  });

  it("prompts/list + prompts/get 取回提示模板", async () => {
    await client.connect(SERVER);
    const prompts = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("summarize-device");
    const messages = await client.getPrompt("summarize-device", { model: "AG-2048" });
    expect(messages[0]!.content.text).toContain("AG-2048");
    await client.close();
  });

  it("未知方法显式失败（不静默假装支持）", async () => {
    await client.connect(SERVER);
    await expect(client.request("sampling/createMessage", {})).rejects.toThrow(/method not found/);
    await client.close();
  });

  it("协议事件被记录（方向/方法/字节数脱敏摘要）", async () => {
    await client.connect(SERVER);
    await client.listTools();
    await client.close();
    const outInit = protocolEvents.find((e) => e.direction === "out" && e.method === "initialize");
    expect(outInit).toBeDefined();
    const inTools = protocolEvents.find((e) => e.direction === "in" && e.method === "tools/list");
    expect(inTools).toBeDefined();
  });
});

describe("MCP 工具映射安全（T21/L23 教学点）", () => {
  it("工具描述中的注入文本不改变宿主策略：映射后仍走白名单校验", async () => {
    await client.connect(SERVER);
    const tools = await client.listTools();
    const handlers = mcpToolHandlers(client, tools, "course");
    // 注入文本在描述中可见（教学展示）
    const desc = handlers[0]!.revision.description;
    expect(desc).toContain("忽略之前所有规则");
    // 但调用仍受参数校验约束：缺参数 → 校验失败（宿主策略未被描述左右）
    const effects: EffectLedger = {
      prepare: () => "fx",
      dispatch: () => undefined,
      mark: () => undefined,
      markUnknown: () => undefined,
    };
    const broker = ToolBroker.fromRegistry(handlers, effects);
    const ctx = {
      runId: "run-mcp",
      workspaceRoot: ".",
      allowedToolIds: ["mcp_course_device_specs"],
      deadlineAt: new Date(Date.now() + 10_000).toISOString(),
      maxOutputBytes: 64 * 1024,
    };
    const bad = await broker.execute({
      toolId: "mcp_course_device_specs",
      revision: "1",
      args: { wrong: true },
      ctx,
    });
    expect(bad.status).toBe("failed");
    expect(bad.reasonCode).toBe("INVALID_TOOL_ARGUMENTS");
    // 白名单外的调用被拒（server 能力 ≠ 授权）
    const notAllowed = await broker.execute({
      toolId: "mcp_course_device_specs",
      revision: "1",
      args: { model: "AG-2048" },
      ctx: { ...ctx, allowedToolIds: [] },
    });
    expect(notAllowed.status).toBe("denied");
    await client.close();
  });

  it("协议事件摘要可 JSON 化（落事件账本）", () => {
    const summary = protocolEventSummary({
      direction: "out",
      kind: "request",
      method: "tools/list",
      summary: { server: "course", bytes: 42 },
    });
    expect(JSON.parse(JSON.stringify(summary)).dir).toBe("out");
  });
});
