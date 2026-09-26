/**
 * AgentGlass CLI（T24）。与 Web 共用同一 API/本地控制端口；权限不高于 Web 身份。
 * 命令：doctor / lesson run / run inspect / run events / run pause / run cancel / replay。
 * `lesson run` 未提供 --input 时进入交互输入提示，等待用户填写并确认；不自动选取案例。
 */
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { writeFileSync } from "node:fs";

const BASE = process.env.AGENTGLASS_URL ?? "http://127.0.0.1:8787";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body != null ? { "content-type": "application/json" } : undefined,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { code?: string; message?: string };
  if (!res.ok) {
    console.error(`✗ ${data.code ?? res.status}: ${data.message ?? ""}`);
    process.exit(1);
  }
  return data;
}

const program = new Command();
program.name("agentglass").description("AgentGlass 命令行入口（与 Web 同一运行合同）").version("0.1.0");

program
  .command("doctor")
  .description("检查 API、worker、模型配置与课程包状态")
  .action(async () => {
    try {
      const health = await call<{ ok: boolean }>("GET", "/api/v1/health");
      console.log(`✓ API ${BASE} ${health.ok ? "正常" : "异常"}`);
    } catch {
      console.error(`✗ API 不可达：${BASE}（请先启动 apps/api 与 apps/worker）`);
      process.exit(1);
    }
    const { lessons } = await call<{ lessons: Array<{ id: string; title: string; revision: string }> }>("GET", "/api/v1/courses");
    console.log(`✓ 课程包 ${lessons.length} 门（L00—L07 应为 8）`);
    const { profiles } = await call<{ profiles: Array<{ id: string; name: string; provider: string; probed: boolean }> }>("GET", "/api/v1/model-profiles");
    if (profiles.length === 0) {
      console.log("! 未配置模型：不能发起实时运行（回放不受影响）。设置页或 POST /api/v1/model-profiles 添加。");
    } else {
      for (const p of profiles) {
        console.log(`✓ 模型 ${p.name}（${p.provider}${p.provider === "fake" ? "，模拟" : ""}${p.probed ? "，已探测" : ""}）`);
      }
    }
  });

const lesson = program.command("lesson").description("课程操作");
lesson
  .command("run")
  .description("为课程打开会话；未提供 --input 时交互式等待用户输入并确认")
  .requiredOption("--lesson <lessonId>")
  .option("--model <profileId>", "模型配置 ID（缺省取第一个已配置模型）")
  .option("--input <text>", "用户任务正文（显式提交；与交互输入等效）")
  .option("--wait", "提交后等待运行到达终态", false)
  .action(async (opts: { lesson: string; model?: string; input?: string; wait?: boolean }) => {
    let text = opts.input;
    if (text == null) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      console.log("请输入你的任务（显式提交才会创建运行；直接回车取消）：");
      text = await rl.question("> ");
      rl.close();
      if (text.trim().length === 0) {
        console.log("已取消：未发送任何内容。");
        return;
      }
    }
    const profiles = await call<{ profiles: Array<{ id: string }> }>("GET", "/api/v1/model-profiles");
    const modelId = opts.model ?? profiles.profiles[0]?.id;
    if (!modelId) {
      console.error("✗ 未配置模型：不能发起实时运行（A01）。");
      process.exit(1);
    }
    const { sessionId } = await call<{ sessionId: string }>("POST", "/api/v1/sessions", { lessonId: opts.lesson, modelProfileId: modelId });
    const { submission } = await call<{ submission: { id: string } }>("POST", `/api/v1/sessions/${sessionId}/inputs`, {
      text,
      clientMessageId: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    console.log(`已提交输入 ${submission.id}（会话 ${sessionId}）`);
    if (!opts.wait) return;
    for (;;) {
      await new Promise((r) => setTimeout(r, 600));
      const s = await call<{ inputs: Array<{ id: string; acceptedRunId: string | null }> }>("GET", `/api/v1/sessions/${sessionId}`);
      const runId = s.inputs.find((i) => i.id === submission.id)?.acceptedRunId;
      if (!runId) continue;
      const r = await call<{ run: { state: string; stopReason: string | null } }>("GET", `/api/v1/runs/${runId}`);
      if (!["queued", "running"].includes(r.run.state)) {
        console.log(`运行 ${runId} 终态：${r.run.state}${r.run.stopReason ? `（${r.run.stopReason}）` : ""}`);
        const outs = await call<{ finalText: string }>("GET", `/api/v1/runs/${runId}/outputs`);
        if (outs.finalText) console.log(`--- 最终回答 ---\n${outs.finalText}`);
        process.exit(r.run.state === "completed" ? 0 : 3);
      }
    }
  });

const run = program.command("run").description("运行操作");
run
  .command("inspect")
  .argument("<runId>")
  .action(async (runId: string) => {
    const r = await call<{ run: Record<string, unknown>; model: unknown }>("GET", `/api/v1/runs/${runId}`);
    console.log(JSON.stringify(r, null, 2));
  });
run
  .command("events")
  .argument("<runId>")
  .option("--follow", "持续轮询新事件", false)
  .action(async (runId: string, opts: { follow?: boolean }) => {
    let cursor = 0;
    for (;;) {
      const { events } = await call<{ events: Array<{ seq: number; type: string; summary: Record<string, unknown> }> }>(
        "GET", `/api/v1/runs/${runId}/events?afterSeq=${cursor}`,
      );
      for (const e of events) {
        console.log(`#${e.seq} ${e.type} ${JSON.stringify(e.summary).slice(0, 120)}`);
        cursor = e.seq;
      }
      if (!opts.follow) break;
      await new Promise((r) => setTimeout(r, 800));
    }
  });
run
  .command("pause").argument("<runId>").action(async (runId: string) => {
    await call("POST", `/api/v1/runs/${runId}/commands`, { command: "pause" });
    console.log("已请求在下一个安全边界暂停。");
  });
run
  .command("cancel").argument("<runId>").action(async (runId: string) => {
    await call("POST", `/api/v1/runs/${runId}/commands`, { command: "cancel" });
    console.log("已请求取消。");
  });
run
  .command("export").argument("<runId>").option("--out <file>", "输出文件", "run.agtrace.zip")
  .action(async (runId: string, opts: { out: string }) => {
    const res = await fetch(`${BASE}/api/v1/runs/${runId}/export`);
    if (!res.ok) {
      console.error(`✗ 导出失败: ${res.status}`);
      process.exit(1);
    }
    writeFileSync(opts.out, Buffer.from(await res.arrayBuffer()));
    console.log(`已导出 ${opts.out}（${(await res.arrayBuffer()).byteLength} 字节）`);
  });

program
  .command("replay")
  .description("回放 .agtrace.zip 包（离线；不执行任何代码）")
  .argument("<bundle>")
  .action(async (bundle: string) => {
    if (!existsSync(bundle)) {
      console.error(`✗ 文件不存在: ${bundle}`);
      process.exit(1);
    }
    const { importBundle } = await import("@agentglass/replay");
    const bytes = new Uint8Array(await (await import("node:fs/promises")).readFile(bundle));
    const result = importBundle(bytes);
    if (!result.ok) {
      console.error(`✗ 包校验失败：${result.errors.join("; ")}`);
      process.exit(1);
    }
    console.log(`✓ 包完整：${result.manifest?.originalRunId}，${result.events?.length ?? 0} 事件（reducer ${result.manifest?.reducerVersion}）`);
    const events = [...(result.events ?? [])].sort((a, b) => a.seq - b.seq);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    for (const e of events) {
      console.log(`#${e.seq} ${e.type} ${JSON.stringify(e.summary).slice(0, 160)}`);
      if (e.seq % 5 === 0) {
        const answer = await rl.question("—— 回车继续，q 退出 ——");
        if (answer.trim() === "q") break;
      }
    }
    rl.close();
  });

program.parseAsync().catch((err) => {
  console.error(String(err));
  process.exit(1);
});

export { join };
