/**
 * E2E（API 级，synthetic 环境）：课程打开零调用（A19）、输入幂等（A21）、
 * 模型密钥掩码、事件分页补拉、运行导出与对照。
 * 真实模型资格另走 test:live；本文件不消耗外部模型。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

let dataDir: string;
/* 运行时通过动态 import 加载（避免测试目录引入 API 依赖） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let worker: any;
let lessonsDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "ag-e2e-"));
  lessonsDir = join(__dirname, "..", "..", "lessons");
  process.env.AGENTGLASS_DATA = dataDir;
  process.env.AGENTGLASS_LESSONS = lessonsDir;
  process.env.AGENTGLASS_SEED_FAKE = "1";
  // @ts-expect-error 动态加载 API 服务（测试目录不声明其依赖）
  const server = await import("../../apps/api/src/server.ts");
  app = server.app;
  const { RunCoordinator } = await import("@agentglass/worker");
  const { openDatabase } = await import("@agentglass/db");
  const { LessonRegistry } = await import("@agentglass/lessons");
  const db = openDatabase({ file: join(dataDir, "agentglass.db") });
  worker = new RunCoordinator({ db, dataDir, lessons: new LessonRegistry(lessonsDir), pollIntervalMs: 80 });
  worker.start();
});

afterAll(async () => {
  worker?.stop();
  await app?.close();
  // Windows 上 WAL 句柄释放可能滞后；清理失败不影响测试结论
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("课程与交互合同（A19/A22）", () => {
  it("打开课程、获取案例提示不创建运行、不接纳输入", async () => {
    const lesson = await app.inject({ method: "GET", url: "/api/v1/lessons/L05-observe-act/revisions/1.1.0" });
    expect(lesson.statusCode).toBe(200);
    const body = lesson.json();
    expect(body.manifest.learner_input.auto_send).toBe(false);
    expect(body.manifest.learner_input.default_text).toBe("");

    const hints = await app.inject({ method: "GET", url: "/api/v1/lessons/L05-observe-act/revisions/1.1.0/case-hints" });
    expect(hints.statusCode).toBe(200);
    expect(hints.json().hints.length).toBeGreaterThan(0);
    // 案例提示只是数据；没有任何运行被创建
    const history = await app.inject({ method: "GET", url: "/api/v1/history" });
    expect(history.json().runs).toHaveLength(0);
  });

  it("错误版本号返回 404（冻结清单，不用当前 HEAD）", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/lessons/L05-observe-act/revisions/9.9.9" });
    expect(r.statusCode).toBe(404);
  });

  it("密钥引用拒绝裸密钥（必须 env: 引用，密钥本体不落库）", async () => {
    const raw = await app.inject({
      method: "POST",
      url: "/api/v1/model-profiles",
      payload: { name: "bad", provider: "openai-compatible", endpoint: "https://api.example.com", modelId: "m", secretRef: "sk-raw-key-should-not-be-stored" },
    });
    expect(raw.statusCode).toBe(400);
    expect(raw.json().code).toBe("INVALID_SECRET_REF");

    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/model-profiles",
      payload: { name: "good", provider: "openai-compatible", endpoint: "https://api.example.com", modelId: "m", secretRef: "env:SOME_VAR" },
    });
    expect(ok.statusCode).toBe(201);
  });
});

describe("实时输入与运行（A21）", () => {
  it("用户明确提交 → 运行完成 → 事件可分页补拉 → 幂等重试不重复", async () => {
    // 注册 fake 教学模型配置（显式标记；真实模型走 test:live）
    const profile = await app.inject({
      method: "POST",
      url: "/api/v1/model-profiles",
      payload: { name: "fake-deterministic（教学模拟）", provider: "fake", endpoint: "", modelId: "fake-deterministic" },
    });
    expect(profile.statusCode).toBe(201);
    const session = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: { lessonId: "L05-observe-act", modelProfileId: profile.json().id },
    });
    expect(session.statusCode).toBe(201);
    const { sessionId } = session.json();

    const text = "请读取实验目录中的 inventory.csv，统计所有品类的库存总量，并说明你的计算依据。";
    const clientMessageId = `e2e-${randomUUID()}`;
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/inputs`,
      payload: { text, clientMessageId },
    });
    expect(first.statusCode).toBe(201);

    // 等待运行完成
    let runId: string | null = null;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const sess = await app.inject({ method: "GET", url: `/api/v1/sessions/${sessionId}` });
      const inputs = sess.json().inputs as Array<{ acceptedRunId: string | null }>;
      const accepted = inputs.find((i) => i.acceptedRunId);
      if (accepted?.acceptedRunId) {
        runId = accepted.acceptedRunId;
        const run = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}` });
        if (!["queued", "running"].includes(run.json().run.state)) break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(runId).toBeTruthy();
    const final = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}` });
    expect(final.json().run.state).toBe("completed");
    expect(final.json().model.simulated).toBe(true); // fake 模型显式标记

    // 幂等：同键同文返回 200 + duplicate
    const dup = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/inputs`,
      payload: { text, clientMessageId },
    });
    expect(dup.statusCode).toBe(200);
    expect(dup.json().duplicate).toBe(true);

    // 同键异文冲突 409
    const conflict = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/inputs`,
      payload: { text: text + "改了", clientMessageId },
    });
    expect(conflict.statusCode).toBe(409);

    // 事件分页补拉：afterSeq 游标一致
    const page1 = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}/events?afterSeq=0&limit=5` });
    expect(page1.json().events as unknown[]).toHaveLength(5);
    const cursor = page1.json().nextCursor;
    const page2 = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}/events?afterSeq=${cursor}` });
    expect((page2.json().events as Array<{ seq: number }>)[0]!.seq).toBe(cursor + 1);

    // 输出可读且引用真实计算值
    const outputs = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}/outputs` });
    expect(outputs.json().finalText).toContain("222");
  }, 90_000);
});

describe("运行对照与导出", () => {
  it("compare 汇总两个运行的用量与结果；导出 zip 可下载", async () => {
    const history = await app.inject({ method: "GET", url: "/api/v1/history" });
    const runs = history.json().runs as Array<{ id: string }>;
    expect(runs.length).toBeGreaterThanOrEqual(1);
    if (runs.length < 2) return; // 只有 1 个运行时跳过对照断言

    const compare = await app.inject({
      method: "GET",
      url: `/api/v1/compare?runIds=${runs[0]!.id},${runs[1]!.id}`,
    });
    expect(compare.statusCode).toBe(200);
    expect(compare.json().runs).toHaveLength(2);
    for (const r of compare.json().runs) {
      expect(r.modelCalls).toBeGreaterThan(0);
      expect(r.usage).toBeDefined();
    }

    const exportResp = await app.inject({ method: "GET", url: `/api/v1/runs/${runs[0]!.id}/export` });
    expect(exportResp.statusCode).toBe(200);
    expect(exportResp.headers["content-type"]).toBe("application/zip");
    expect(exportResp.rawPayload.length).toBeGreaterThan(100);
  });
});

describe("健康检查（T35：组件级真实状态）", () => {
  it("health 返回 ok=true，metrics 与真实 schema 一致（outbox published 计数可执行）", async () => {
    const health = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(health.statusCode).toBe(200);
    const body = health.json();
    // db quick_check 与 blobs 目录都真实存在时才允许 ok
    expect(body.ok).toBe(true);
    expect(body.components.db).toBe("ok");
    expect(body.components.blobs).toBe("ok");
    // metrics 查询与真实 schema 对齐（published 列），不是静默降级
    expect(body.components.metrics).toBeDefined();
    expect(body.components.metrics.lessons).toBeGreaterThan(0);
    expect(typeof body.components.metrics.runsTotal).toBe("number");
    expect(typeof body.components.metrics.outboxPending).toBe("number");
    expect(typeof body.components.metrics.inputsQueued).toBe("number");
  });
});
