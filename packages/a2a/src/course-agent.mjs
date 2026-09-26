/**
 * T28 A2A agent fixture：本地 .mjs 零依赖 agent（agent card + JSON-RPC message/send/tasks/get/cancel）。
 * 返回 artifact 文本 + 状态 completed；用于合同测试与课程 L33（远程协作）演示。
 */
import { createInterface } from "node:readline";

const CARD = {
  name: "agentglass-course-agent",
  description: "课程远程 Agent：回答 AG 系列设备规格摘要（待验证信息）",
  url: "http://localhost:0", // 由启动方覆盖
  version: "1.0.0",
  provider: { organization: "agentglass-course" },
  skills: [
    { id: "spec-summary", name: "规格摘要", description: "总结 AG 系列设备的核心规格" },
  ],
};

const tasks = new Map();

const rl = createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

function handle(method, params, id) {
  switch (method) {
    case "card": // 测试辅助：直接取 card
      return CARD;
    case "message/send": {
      const taskId = `task_${Math.random().toString(36).slice(2, 10)}`;
      const text = params?.message?.parts?.[0]?.text ?? "";
      const task = {
        id: taskId,
        status: { state: "completed", message: "ok" },
        artifacts: [{ name: "summary", parts: [{ type: "text", text: `（远程 Agent 回答）收到任务：${text.slice(0, 120)}` }] }],
      };
      tasks.set(taskId, task);
      return { task };
    }
    case "tasks/get": {
      const t = tasks.get(params?.id);
      if (!t) throw new Error(`task not found: ${params?.id}`);
      return { task: t };
    }
    case "tasks/cancel": {
      const t = tasks.get(params?.id);
      if (!t) throw new Error(`task not found: ${params?.id}`);
      t.status = { state: "canceled" };
      return { task: t };
    }
    default:
      throw new Error(`method not found: ${method}`);
  }
}

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line.trim());
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id == null) return;
  try {
    send({ jsonrpc: "2.0", id, result: handle(method, params, id) });
  } catch (err) {
    send({ jsonrpc: "2.0", id, error: { code: -32000, message: String(err).slice(0, 200) } });
  }
});

process.on("disconnect", () => process.exit(0));
