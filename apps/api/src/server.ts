/**
 * AgentGlass API（本地实验版）。所有外部输入运行时校验（zod）；
 * 错误统一返回 code/message/retryable/correlation_id；秘密只返回掩码。
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { AppContext } from "./context";
import { createContext } from "./context";
import type {
  BudgetLimit,
  ModelProfileSnapshot,
} from "@agentglass/contracts";
import { DEFAULT_BUDGET, LOCAL_IDENTITY } from "@agentglass/contracts";
import { maskSecret } from "@agentglass/policy";
import { ApprovalService } from "@agentglass/policy";
import { probeProfile, ModelGateway } from "@agentglass/provider-gateway";
import { exportBundle, importBundle } from "@agentglass/replay";
import { SessionService } from "@agentglass/conversation";
import { AgentDraftService, CodeBuildService } from "@agentglass/code-lab";
import type { SafetyRunner } from "@agentglass/code-lab";
import { GuestProcessHost } from "@agentglass/learner-runtime";
import {
  IngestionService,
  IndexService,
  RetrievalService,
  WikiService,
  MemoryService,
} from "@agentglass/knowledge";

const PORT = Number(process.env.AGENTGLASS_PORT ?? 8787);

const ctx: AppContext = createContext();
const gateway = new ModelGateway(ctx.blobs);
const sessionsService = new SessionService(ctx.db, ctx.blobs);
const drafts = new AgentDraftService(ctx.db, ctx.blobs);
const builds = new CodeBuildService(ctx.db, ctx.blobs);
const approvalSvc = new ApprovalService(ctx.db);
const ingestion = new IngestionService(ctx.db, ctx.blobs);
const indexService = new IndexService(ctx.db, ctx.blobs, ingestion);
const retrievalSvc = new RetrievalService(ctx.db, ctx.blobs, ingestion);
const wikiSvc = new WikiService(ctx.db, ingestion);
const memorySvc = new MemoryService(ctx.db);

const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });
await app.register(cors, { origin: true });

class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
  }
}
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ApiError) {
    reply.code(err.statusCode).send({
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      correlation_id: randomUUID(),
    });
    return;
  }
  reply.code(500).send({
    code: "INTERNAL",
    message: String(err).slice(0, 300),
    retryable: false,
    correlation_id: randomUUID(),
  });
});

function zparse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ApiError(400, "INVALID_REQUEST", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return r.data;
}

// ---------- 健康（T35 观测：组件级真实状态，不做假健康） ----------
app.get("/api/v1/health", async () => {
  const components: Record<string, unknown> = {};
  let ok = true;
  try {
    components.db = (ctx.db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check === "ok" ? "ok" : "degraded";
  } catch (e) {
    components.db = `error: ${String(e).slice(0, 80)}`;
    ok = false;
  }
  try {
    components.blobs = existsSync(join(ctx.dataDir, "blobs")) ? "ok" : "missing";
    if (components.blobs !== "ok") ok = false;
  } catch {
    components.blobs = "error";
    ok = false;
  }
  try {
    const lessons = ctx.lessons.catalog().length;
    const runsTotal = (ctx.db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
    const runsActive = (ctx.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE state IN ('queued','running','awaiting_approval','pause_requested')").get() as { n: number }).n;
    const outboxPending = (ctx.db.prepare("SELECT COUNT(*) AS n FROM event_outbox WHERE published = 0").get() as { n: number }).n;
    const inputsQueued = (ctx.db.prepare("SELECT COUNT(*) AS n FROM input_submissions WHERE status = 'queued'").get() as { n: number }).n;
    components.metrics = { lessons, runsTotal, runsActive, outboxPending, inputsQueued };
    if (outboxPending > 10_000) ok = false; // outbox 积压是真实的观测告警
  } catch (e) {
    components.metrics = `error: ${String(e).slice(0, 80)}`;
    ok = false;
  }
  return { ok, version: "0.1.0", mode: "local", checkedAt: new Date().toISOString(), components };
});

// ---------- 课程 ----------
app.get("/api/v1/courses", async () => {
  return { lessons: ctx.lessons.catalog() };
});

app.get("/api/v1/lessons/:id/revisions/:rev", async (req) => {
  const { id, rev } = req.params as { id: string; rev: string };
  const manifest = ctx.lessons.manifest(id);
  if (manifest.revision !== rev) {
    // 冻结清单：当前版本不匹配时明确拒绝（回放用历史包，不用当前 HEAD）
    throw new ApiError(404, "LESSON_REVISION_NOT_FOUND", `课程版本不存在: ${id}@${rev}`);
  }
  const assets = ctx.lessons.allDatasets(id).map((d) => ({ key: d.key, name: d.name, bytes: d.content.length }));
  // 状态图课程注入 graph.json 内容（前端渲染真实节点/边拓扑；manifest 仍为真相源）
  const graph = ctx.lessons.graphDefinition(id);
  const manifestWithGraph = graph
    ? { ...manifest, runtime: { ...manifest.runtime, graph } }
    : manifest;
  return {
    manifest: manifestWithGraph,
    lessonMarkdown: ctx.lessons.lessonMarkdown(id),
    systemPrompt: ctx.lessons.systemPrompt(id),
    assets,
  };
});

app.get("/api/v1/lessons/:id/revisions/:rev/case-hints", async (req) => {
  const { id, rev } = req.params as { id: string; rev: string };
  const manifest = ctx.lessons.manifest(id);
  if (manifest.revision !== rev) throw new ApiError(404, "LESSON_REVISION_NOT_FOUND", `课程版本不存在: ${id}@${rev}`);
  // 只返回提示卡内容与观察点；不填充消息历史，不自动发送
  return ctx.lessons.caseHints(id);
});

app.get("/api/v1/lessons/:id/revisions/:rev/edit-policy", async (req) => {
  const { id, rev } = req.params as { id: string; rev: string };
  const manifest = ctx.lessons.manifest(id);
  if (manifest.revision !== rev) throw new ApiError(404, "LESSON_REVISION_NOT_FOUND", `课程版本不存在: ${id}@${rev}`);
  const policy = ctx.lessons.editPolicy(id);
  return { policy: policy ?? null };
});

// ---------- 模型配置 ----------
const ModelProfileBody = z.object({
  name: z.string().min(1).max(100),
  provider: z.enum(["openai-compatible", "anthropic", "fake"]),
  endpoint: z.string().default(""),
  modelId: z.string().min(1),
  secretRef: z.string().optional(),
  parameters: z.record(z.unknown()).default({}),
});

function snapshotFromProfileRow(row: Record<string, unknown>): ModelProfileSnapshot {
  return JSON.parse(String(row.snapshot ?? "{}")) as ModelProfileSnapshot;
}

app.post("/api/v1/model-profiles", async (req, reply) => {
  const body = zparse(ModelProfileBody, req.body);
  if (body.provider !== "fake" && !/^https?:\/\//.test(body.endpoint)) {
    throw new ApiError(400, "INVALID_ENDPOINT", `${body.provider} 提供方需要 http(s) endpoint`);
  }
  // 平台边界：密钥本体绝不落库。引用必须是环境变量引用（env:变量名）；
  // 直接粘贴密钥是常见误操作（请求时无 Authorization → 云端 401，且密钥明文入库）。
  if (body.secretRef != null && !body.secretRef.startsWith("env:")) {
    throw new ApiError(
      400,
      "INVALID_SECRET_REF",
      "密钥引用必须以 env: 开头（如 env:AGENTGLASS_OPENAI_API_KEY）。密钥本体不要填在这里：请把它设置为环境变量（设置后重启 API 与 worker），这里只填变量名引用。",
    );
  }
  const id = `mp_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = new Date().toISOString();
  const caps = {
    streaming: true,
    nativeTools: body.provider === "fake" || body.provider === "anthropic",
    parallelToolCalls: false,
    structuredOutput: "text_only" as const,
    imageInput: false,
    audioInput: false,
    outputModalities: ["text" as const],
    usageReporting: "none" as const,
    testedAt: "unprobed",
    probeSuiteVersion: "none",
    contextWindow: 32000,
  };
  ctx.db
    .prepare(
      `INSERT INTO model_profiles (id, name, provider, protocol, endpoint, model_id, secret_ref, parameters, capabilities, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      body.name,
      body.provider,
      body.provider === "fake" ? "fake/v1" : body.provider === "anthropic" ? "anthropic/v1" : "openai/v1",
      body.endpoint,
      body.modelId,
      body.secretRef ?? null,
      JSON.stringify(body.parameters),
      JSON.stringify(caps),
      now,
      now,
    );
  reply.code(201);
  return { id };
});

app.get("/api/v1/model-profiles", async () => {
  const rows = ctx.db.prepare("SELECT * FROM model_profiles WHERE archived = 0").all() as Array<
    Record<string, unknown>
  >;
  return {
    profiles: rows.map((r) => ({
      id: r.id,
      name: r.name,
      provider: r.provider,
      endpoint: r.endpoint,
      modelId: r.model_id,
      secretMasked: r.secret_ref ? maskSecret(resolveSecretForMask(String(r.secret_ref))) : null,
      secretRef: r.secret_ref ?? null,
      probed: JSON.parse(String(r.capabilities)).testedAt !== "unprobed",
    })),
  };
});

function resolveSecretForMask(ref: string): string | undefined {
  return ctx.secrets.resolve(ref, "local").value;
}

app.post("/api/v1/model-profiles/:id/probe", async (req) => {
  const { id } = req.params as { id: string };
  const row = ctx.db.prepare("SELECT * FROM model_profiles WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new ApiError(404, "PROFILE_NOT_FOUND", "模型配置不存在");
  const snapshot = makeSnapshot(row);
  const provider = gateway.providerFor(snapshot);
  // 显式真实探测：会消耗模型资源（用户主动点击触发）
  const report = await probeProfile(snapshot, provider);
  ctx.db
    .prepare("UPDATE model_profiles SET capabilities = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(report.capabilities), new Date().toISOString(), id);
  return report;
});

function makeSnapshot(row: Record<string, unknown>): ModelProfileSnapshot {
  return {
    id: `snap_${String(row.id)}`,
    provider: String(row.provider),
    protocol: String(row.protocol),
    endpointId: String(row.endpoint),
    modelId: String(row.model_id),
    secretRef: (row.secret_ref as string | null) ?? undefined,
    // 端点同时放入 parameters.endpoint：真实提供方适配器从快照参数读取出站地址
    parameters: { endpoint: String(row.endpoint), ...(JSON.parse(String(row.parameters ?? "{}")) as object) },
    capabilities: JSON.parse(String(row.capabilities)),
  };
}

// ---------- 会话与输入 ----------
const SessionBody = z.object({
  lessonId: z.string().min(1),
  agentRevisionId: z.string().optional(),
  modelProfileId: z.string().optional(),
  budget: z
    .object({
      maxTurns: z.number().int().positive(),
      maxModelCalls: z.number().int().positive(),
      maxToolCalls: z.number().int().positive(),
      maxWallTimeMs: z.number().int().positive(),
    })
    .partial()
    .optional(),
});

app.post("/api/v1/sessions", async (req, reply) => {
  const body = zparse(SessionBody, req.body);
  const manifest = ctx.lessons.manifest(body.lessonId);
  // 打开会话不创建 Agent run、不调用模型（A19）
  const agentRevisionId =
    body.agentRevisionId ?? await ctx.coordinator.ensureCourseRevision(body.lessonId);
  let modelProfileSnapshotId: string;
  if (body.modelProfileId) {
    const row = ctx.db.prepare("SELECT * FROM model_profiles WHERE id = ?").get(body.modelProfileId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new ApiError(404, "PROFILE_NOT_FOUND", "模型配置不存在");
    modelProfileSnapshotId = freezeModelSnapshot(row);
  } else {
    // 未配置模型仍可打开课程（浏览/编辑）；发起实时运行时才阻止（A01 在运行时强制）
    modelProfileSnapshotId = "snap-unconfigured";
  }
  const assetSnapshot = ctx.blobs.putJson({
    lessonId: manifest.id,
    revision: manifest.revision,
    assets: manifest.assets,
  });
  const policySnapshot = ctx.blobs.putJson({
    editPolicy: ctx.lessons.editPolicy(body.lessonId)?.digest ?? "none",
  });
  const runtimeSnapshot = ctx.blobs.putJson({ adapter: manifest.runtime.adapter, version: 1 });
  const budget: BudgetLimit = {
    ...DEFAULT_BUDGET,
    maxTurns: manifest.limits.max_turns,
    maxModelCalls: manifest.limits.max_model_calls,
    maxToolCalls: manifest.limits.max_tool_calls,
    maxWallTimeMs: manifest.limits.max_wall_time_ms,
    ...(manifest.limits.max_input_tokens ? { maxInputTokens: manifest.limits.max_input_tokens } : {}),
    ...(manifest.limits.max_output_tokens ? { maxOutputTokens: manifest.limits.max_output_tokens } : {}),
    ...body.budget,
  };
  const sessionId = sessionsService.createSession(LOCAL_IDENTITY.userId, LOCAL_IDENTITY.projectId, {
    lessonId: manifest.id,
    lessonRevision: manifest.revision,
    agentRevisionId,
    modelProfileSnapshotId,
    runtimeSnapshotId: runtimeSnapshot.id,
    assetSnapshotId: assetSnapshot.id,
    policySnapshotId: policySnapshot.id,
    budget,
  });
  reply.code(201);
  return { sessionId, agentRevisionId, budget };
});

function freezeModelSnapshot(row: Record<string, unknown>): string {
  const snapshot = makeSnapshot(row);
  const id = `snap_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  ctx.db
    .prepare("INSERT INTO model_profile_snapshots (id, profile_id, snapshot, created_at) VALUES (?, ?, ?, ?)")
    .run(id, String(row.id), JSON.stringify(snapshot), new Date().toISOString());
  return id;
}

const BREAKPOINT_TARGET = /^(before_model|before_tool|after_tool|turn_end|node:[A-Za-z0-9_-]{1,64})$/;
const InputBody = z.object({
  text: z.string().min(1).max(32_000),
  clientMessageId: z.string().min(6).max(80),
  caseHintId: z.string().optional(),
  agentRevisionId: z.string().optional(),
  // 断点随输入携带：运行创建事务内播种，避免「运行已完成后 PUT 才到达」的首运行竞态
  breakpoints: z.array(z.string().regex(BREAKPOINT_TARGET)).max(16).optional(),
});

app.post("/api/v1/sessions/:id/inputs", async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = zparse(InputBody, req.body);
  try {
    const r = sessionsService.submitInput({
      sessionId: id,
      clientMessageId: body.clientMessageId,
      text: body.text,
      origin: body.caseHintId ? "case_hint" : "interactive",
      caseHintId: body.caseHintId,
      agentRevisionId: body.agentRevisionId,
      breakpoints: body.breakpoints,
    });
    reply.code(r.duplicate ? 200 : 201);
    return { submission: r.submission, duplicate: r.duplicate };
  } catch (err) {
    if (String(err).includes("SAME_KEY_DIFFERENT_CONTENT")) {
      throw new ApiError(409, "INPUT_CONFLICT", "同一 clientMessageId 携带了不同正文");
    }
    throw err;
  }
});

app.post("/api/v1/inputs/:id/cancel", async (req) => {
  const { id } = req.params as { id: string };
  const row = ctx.db.prepare("SELECT session_id, status FROM input_submissions WHERE id = ?").get(id) as
    | { session_id: string; status: string }
    | undefined;
  if (!row) throw new ApiError(404, "INPUT_NOT_FOUND", "输入不存在");
  const ok = sessionsService.cancelInput(row.session_id, id);
  return { cancelled: ok };
});

app.post("/api/v1/sessions/:id/adopt-revision", async (req) => {
  const { id } = req.params as { id: string };
  const body = zparse(z.object({ agentRevisionId: z.string().min(1) }), req.body);
  const rev = ctx.db.prepare("SELECT id FROM agent_revisions WHERE id = ?").get(body.agentRevisionId) as
    | { id: string }
    | undefined;
  if (!rev) throw new ApiError(404, "REVISION_NOT_FOUND", "代码版本不存在");
  // 只影响后续新输入；已接纳/排队输入保持各自冻结版本
  ctx.db.prepare("UPDATE sessions SET agent_revision_id = ?, updated_at = ? WHERE id = ?").run(
    body.agentRevisionId,
    new Date().toISOString(),
    id,
  );
  return { adopted: body.agentRevisionId };
});

app.get("/api/v1/sessions/:id", async (req) => {
  const { id } = req.params as { id: string };
  const session = sessionsService.getSession(id);
  if (!session) throw new ApiError(404, "SESSION_NOT_FOUND", "会话不存在");
  return { session, inputs: sessionsService.listInputs(id) };
});

// ---------- 运行 ----------
app.get("/api/v1/runs/:id", async (req) => {
  const { id } = req.params as { id: string };
  const run = ctx.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!run) throw new ApiError(404, "RUN_NOT_FOUND", "运行不存在");
  const modelSnap = ctx.db
    .prepare("SELECT snapshot FROM model_profile_snapshots WHERE id = ?")
    .get(String(run.model_profile_snapshot_id)) as { snapshot: string } | undefined;
  const model = modelSnap ? (JSON.parse(modelSnap.snapshot) as ModelProfileSnapshot) : null;
  return {
    run: {
      id: run.id,
      mode: run.mode,
      state: run.state,
      stopReason: run.stop_reason,
      lessonId: run.lesson_id,
      lessonRevision: run.lesson_revision,
      agentRevisionId: run.agent_revision_id,
      inputPreview: run.input_preview,
      budget: JSON.parse(String(run.budget)),
      createdAt: run.created_at,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      outputRefs: JSON.parse(String(run.output_refs ?? "[]")),
    },
    model: model
      ? { provider: model.provider, modelId: model.modelId, simulated: model.provider === "fake" }
      : null,
  };
});

app.get("/api/v1/runs/:id/events", async (req) => {
  const { id } = req.params as { id: string };
  const q = req.query as { afterSeq?: string; limit?: string };
  const afterSeq = Number(q.afterSeq ?? 0);
  const limit = Math.min(Number(q.limit ?? 500), 1000);
  const events = ctx.events.readAfter(id, afterSeq, limit);
  return { events, nextCursor: events.length > 0 ? events.at(-1)!.seq : afterSeq };
});

app.get("/api/v1/runs/:id/stream", async (req, reply) => {
  const { id } = req.params as { id: string };
  const q = req.query as { afterSeq?: string };
  let cursor = Number(q.afterSeq ?? 0);
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  reply.raw.write("retry: 2000\n\n");
  let closed = false;
  req.raw.on("close", () => {
    closed = true;
  });
  const poll = (): void => {
    if (closed) return;
    try {
      const events = ctx.events.readAfter(id, cursor, 200);
      for (const e of events) {
        reply.raw.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
        cursor = e.seq;
      }
      reply.raw.write(`: ping ${Date.now()}\n\n`);
    } catch {
      // 断线由客户端补拉（Last-Event-ID）
    }
    setTimeout(poll, 350);
  };
  poll();
  void reply;
});

const CommandBody = z.object({ command: z.enum(["pause", "cancel", "resume"]) });
app.post("/api/v1/runs/:id/commands", async (req) => {
  const { id } = req.params as { id: string };
  const body = zparse(CommandBody, req.body);
  const run = ctx.db.prepare("SELECT state FROM runs WHERE id = ?").get(id) as
    | { state: string }
    | undefined;
  if (!run) throw new ApiError(404, "RUN_NOT_FOUND", "运行不存在");
  if (!["running", "queued", "pause_requested", "paused", "cancel_requested"].includes(run.state)) {
    throw new ApiError(409, "INVALID_STATE", `状态 ${run.state} 不接受控制命令`);
  }
  ctx.db
    .prepare("INSERT INTO run_commands (id, run_id, command, payload, actor_id, state, created_at) VALUES (?, ?, ?, '{}', ?, 'pending', ?)")
    .run(`cmd_${randomUUID().replace(/-/g, "").slice(0, 16)}`, id, body.command, LOCAL_IDENTITY.userId, new Date().toISOString());
  return { accepted: body.command };
});

// ---------- 运行断点（流程图节点断点；worker 在安全边界轮询本表） ----------
const BreakpointsBody = z.object({ targets: z.array(z.string().regex(BREAKPOINT_TARGET)).max(16) });
app.get("/api/v1/runs/:id/breakpoints", async (req) => {
  const { id } = req.params as { id: string };
  const run = ctx.db.prepare("SELECT id FROM runs WHERE id = ?").get(id);
  if (!run) throw new ApiError(404, "RUN_NOT_FOUND", "运行不存在");
  const rows = ctx.db.prepare("SELECT target FROM run_breakpoints WHERE run_id = ? ORDER BY target").all(id) as Array<{ target: string }>;
  return { targets: rows.map((r) => r.target) };
});
app.put("/api/v1/runs/:id/breakpoints", async (req) => {
  const { id } = req.params as { id: string };
  const body = zparse(BreakpointsBody, req.body);
  const run = ctx.db.prepare("SELECT state FROM runs WHERE id = ?").get(id) as
    | { state: string }
    | undefined;
  if (!run) throw new ApiError(404, "RUN_NOT_FOUND", "运行不存在");
  if (["completed", "failed", "cancelled"].includes(run.state)) {
    throw new ApiError(409, "INVALID_STATE", `终态运行不接受断点变更`);
  }
  const targets = [...new Set(body.targets)];
  ctx.db.prepare("DELETE FROM run_breakpoints WHERE run_id = ?").run(id);
  const insert = ctx.db.prepare("INSERT INTO run_breakpoints (run_id, target, created_at) VALUES (?, ?, ?)");
  for (const target of targets) insert.run(id, target, new Date().toISOString());
  return { targets };
});

app.get("/api/v1/runs/:id/contexts/:callId", async (req) => {
  const { id, callId } = req.params as { id: string; callId: string };
  const events = ctx.events.readRange(id, 0, ctx.events.maxSeq(id));
  const compiled = events.find(
    (e) => e.type === "context.compiled" && String((e.summary as Record<string, unknown>).compiledContextId ?? "") === callId,
  );
  if (!compiled?.payloadRef) throw new ApiError(404, "CONTEXT_NOT_FOUND", "上下文不存在");
  const blob = ctx.blobs.getJson<{ messages: unknown[]; tools?: unknown[] }>(compiled.payloadRef.id);
  const summary = compiled.summary as Record<string, unknown>;
  const itemDecisionsRef = typeof summary.itemDecisionsRef === "string" ? summary.itemDecisionsRef : null;
  const itemDecisions = itemDecisionsRef ? ctx.blobs.getJson<unknown[]>(itemDecisionsRef) : null;
  return {
    callId,
    items: blob,
    itemDecisions,
    note: "items 来自编译后的标准上下文（四层证据第二层）；出站载荷见 model.request_prepared；itemDecisions 为逐项选入/排除决策（旧运行可能缺省为 null）",
    estimatedInputTokens: summary.estimatedInputTokens ?? null,
  };
});

app.get("/api/v1/runs/:id/outputs", async (req) => {
  const { id } = req.params as { id: string };
  const run = ctx.db.prepare("SELECT output_refs FROM runs WHERE id = ?").get(id) as
    | { output_refs: string }
    | undefined;
  if (!run) throw new ApiError(404, "RUN_NOT_FOUND", "运行不存在");
  const refs = JSON.parse(run.output_refs) as Array<{ id: string }>;
  const finalText = refs[0] ? ctx.blobs.getText(refs[0].id) : "";
  return { finalText, refs };
});

// ---------- 历史 / 对照 / 回放 ----------
app.get("/api/v1/history", async () => {
  const rows = ctx.db
    .prepare("SELECT id, lesson_id, lesson_revision, state, stop_reason, mode, input_preview, agent_revision_id, created_at FROM runs ORDER BY created_at DESC LIMIT 200")
    .all();
  return { runs: rows };
});

app.get("/api/v1/compare", async (req) => {
  const q = req.query as { runIds?: string };
  const ids = (q.runIds ?? "").split(",").filter(Boolean).slice(0, 4);
  if (ids.length < 2) throw new ApiError(400, "INVALID_REQUEST", "compare 需要 2-4 个 runIds");
  const runs = ids.map((id) => {
    const run = ctx.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!run) throw new ApiError(404, "RUN_NOT_FOUND", `运行不存在: ${id}`);
    const events = ctx.events.readRange(id, 0, ctx.events.maxSeq(id));
    const toolCalls = events.filter((e) => e.type === "tool.call_completed").length;
    const modelCalls = events.filter((e) => e.type === "model.response_completed").length;
    const usage = events
      .filter((e) => e.type === "model.response_completed")
      .reduce(
        (acc, e) => {
          const u = (e.summary as Record<string, unknown>).usage as Record<string, unknown> | undefined;
          return {
            input: acc.input + (Number(u?.inputTokens ?? 0) || 0),
            output: acc.output + (Number(u?.outputTokens ?? 0) || 0),
          };
        },
        { input: 0, output: 0 },
      );
    const outputRefs = JSON.parse(String(run.output_refs ?? "[]")) as Array<{ id: string }>;
    const finalText = outputRefs[0] ? ctx.blobs.getText(outputRefs[0].id) : "";
    return {
      runId: id,
      lessonId: run.lesson_id,
      state: run.state,
      stopReason: run.stop_reason,
      agentRevisionId: run.agent_revision_id,
      inputPreview: run.input_preview,
      toolCalls,
      modelCalls,
      usage,
      finalText,
    };
  });
  return { runs };
});

app.get("/api/v1/runs/:id/export", async (req, reply) => {
  const { id } = req.params as { id: string };
  const run = ctx.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!run) throw new ApiError(404, "RUN_NOT_FOUND", "运行不存在");
  const events = ctx.events.readRange(id, 0, ctx.events.maxSeq(id));
  const rev = ctx.db.prepare("SELECT * FROM agent_revisions WHERE id = ?").get(String(run.agent_revision_id)) as
    | Record<string, unknown>
    | undefined;
  const sourceManifest = rev ? ctx.coordinator.manifests().get(String(rev.source_manifest_id)) : undefined;
  const sourceFiles: Record<string, string> = {};
  if (sourceManifest) {
    for (const f of sourceManifest.files) {
      sourceFiles[f.path] = ctx.blobs.getText(f.blobId);
    }
  }
  let lessonManifestYaml = "";
  try {
    lessonManifestYaml = readFileSync(join(ctx.lessons.lessonDir(String(run.lesson_id)), "manifest.yaml"), "utf8");
  } catch {
    /* 课程可能已卸载；导出不因此失败 */
  }
  // 课程清单快照：仅当运行版本与当前课程 HEAD 一致时随包携带（版本不匹配则省略，回放端如实降级）
  let lessonManifestSnapshot: Record<string, unknown> | undefined;
  try {
    const head = ctx.lessons.manifest(String(run.lesson_id));
    if (head.revision === String(run.lesson_revision)) {
      lessonManifestSnapshot = head as unknown as Record<string, unknown>;
    }
  } catch {
    /* 课程已卸载 */
  }
  const zip = exportBundle({
    runId: id,
    mode: String(run.mode),
    events,
    sourceManifest,
    sourceFiles,
    lesson: {
      id: String(run.lesson_id),
      revision: String(run.lesson_revision),
      markdown: ctx.lessons.lessonMarkdown(String(run.lesson_id)),
      manifestYaml: lessonManifestYaml,
      manifest: lessonManifestSnapshot,
    },
    reducerVersion: "reduce-trace-1",
  });
  reply.header("content-type", "application/zip");
  reply.header("content-disposition", `attachment; filename="${id}.agtrace.zip"`);
  return reply.send(Buffer.from(zip));
});

const ImportBody = z.object({ zipBase64: z.string().min(16) });
app.post("/api/v1/trace-imports", async (req) => {
  const body = zparse(ImportBody, req.body);
  const bytes = Uint8Array.from(Buffer.from(body.zipBase64, "base64"));
  const result = importBundle(bytes);
  if (!result.ok) {
    throw new ApiError(400, "BUNDLE_REJECTED", result.errors.join("; "));
  }
  // 导入不执行任何脚本、不创建运行；只登记为可回放的历史记录
  const importId = `imp_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const ref = ctx.blobs.put(new Uint8Array(bytes), "application/zip");
  return { importId, bundleBlobId: ref.id, manifest: result.manifest, eventCount: result.events?.length ?? 0 };
});

// ---------- 受控代码实验（T38-T40） ----------
const CreateDraftBody = z.object({ lessonId: z.string().min(1) });
app.post("/api/v1/agent-drafts", async (req, reply) => {
  const body = zparse(CreateDraftBody, req.body);
  const manifest = ctx.lessons.manifest(body.lessonId);
  const policy = ctx.lessons.editPolicy(body.lessonId);
  if (!policy) throw new ApiError(400, "EDIT_POLICY_MISSING", "本课程未开放代码编辑");
  const baseRevision = await ctx.coordinator.ensureCourseRevision(body.lessonId);
  const baselineFiles = ctx.lessons.baselineFiles(body.lessonId);
  const draft = drafts.createDraft({
    ownerId: LOCAL_IDENTITY.userId,
    projectId: LOCAL_IDENTITY.projectId,
    lessonId: body.lessonId,
    lessonVersion: `${body.lessonId}@${manifest.revision}`,
    baseAgentRevisionId: baseRevision,
    baseFiles: baselineFiles,
    editPolicyDigest: policy.digest,
  });
  reply.code(201);
  return { draft };
});

app.get("/api/v1/agent-drafts/:id", async (req) => {
  const { id } = req.params as { id: string };
  const draft = drafts.get(id);
  if (!draft) throw new ApiError(404, "DRAFT_NOT_FOUND", "草稿不存在");
  return { draft };
});

const SaveDraftBody = z.object({
  expectedRevision: z.number().int().positive(),
  files: z.record(z.string()),
});
app.patch("/api/v1/agent-drafts/:id", async (req) => {
  const { id } = req.params as { id: string };
  const body = zparse(SaveDraftBody, req.body);
  const draft = drafts.get(id);
  if (!draft) throw new ApiError(404, "DRAFT_NOT_FOUND", "草稿不存在");
  // 保存不触发模型/构建/执行（A19）
  const updated = drafts.save({
    draftId: id,
    expectedRevision: body.expectedRevision,
    files: body.files,
    editPolicyDigest: draft ? policyDigestFor(draft.lessonId) : "",
  });
  return { draft: updated };
});

function policyDigestFor(lessonId: string): string {
  return ctx.lessons.editPolicy(lessonId)?.digest ?? "none";
}

/** 平台安全测试运行器：在隔离 guest 子进程中验证扩展函数（硬超时） */
const safetyRunner: SafetyRunner = async (bundlePath, slots) => {
  if (slots.length === 0) return { passed: true, failures: [] };
  const host = new GuestProcessHost(bundlePath, { callTimeoutMs: 2000 });
  const failures: Array<{ id: string; detail: string }> = [];
  try {
    for (const slot of slots) {
      const samples = [
        { completedTurns: 0, hasNewObservation: true, finalAnswerReady: false },
        { completedTurns: 99, hasNewObservation: true, finalAnswerReady: false },
        { completedTurns: 1, hasNewObservation: false, finalAnswerReady: true },
      ];
      for (const [i, sample] of samples.entries()) {
        const r = await host.call({ slot, arg: sample });
        if (!r.ok) {
          failures.push({ id: `${slot}.sample${i}`, detail: r.error ?? "调用失败" });
          continue;
        }
        if (typeof r.value !== "boolean") {
          failures.push({ id: `${slot}.sample${i}`, detail: `返回类型必须是 boolean，实际 ${typeof r.value}` });
        }
      }
    }
  } finally {
    await host.dispose();
  }
  return { passed: failures.length === 0, failures };
};

app.post("/api/v1/agent-drafts/:id/validate", async (req) => {
  const { id } = req.params as { id: string };
  const draft = drafts.get(id);
  if (!draft) throw new ApiError(404, "DRAFT_NOT_FOUND", "草稿不存在");
  const policy = ctx.lessons.editPolicy(draft.lessonId);
  if (!policy) throw new ApiError(400, "EDIT_POLICY_MISSING", "本课程未开放代码编辑");
  // 校验与构建不调用 LLM（默认零模型调用）
  const manifest = ctx.lessons.manifest(draft.lessonId);
  const outcome = await builds.validate({
    draftId: draft.id,
    draftRevision: draft.revision,
    files: draft.files,
    baseFiles: ctx.lessons.baselineFiles(draft.lessonId),
    policy,
    baseManifestId: draft.baseAgentRevisionId,
    extensionSlots: manifest.runtime.extension_slots,
    safetyRunner,
    outputDir: join(ctx.dataDir, "revisions"),
  });
  return outcome;
});

app.get("/api/v1/code-builds/:id", async (req) => {
  const { id } = req.params as { id: string };
  const report = builds.getReport(id);
  if (!report) throw new ApiError(404, "BUILD_NOT_FOUND", "构建不存在");
  return { report };
});

app.get("/api/v1/agent-revisions/:id", async (req) => {
  const { id } = req.params as { id: string };
  const row = ctx.db.prepare("SELECT * FROM agent_revisions WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new ApiError(404, "REVISION_NOT_FOUND", "版本不存在");
  return {
    revision: {
      id: row.id,
      lessonId: row.lesson_id,
      lessonVersion: row.lesson_version,
      authorKind: row.author_kind,
      sourceManifestId: row.source_manifest_id,
      validationReportId: row.validation_report_id,
      createdAt: row.created_at,
    },
  };
});

app.get("/api/v1/source-manifests/:id", async (req) => {
  const { id } = req.params as { id: string };
  const manifest = ctx.coordinator.manifests().get(id);
  if (!manifest) throw new ApiError(404, "MANIFEST_NOT_FOUND", "源码清单不存在");
  const files = manifest.files.map((f) => ({
    ...f,
    content: ctx.blobs.getText(f.blobId),
  }));
  return { manifest: { ...manifest, files } };
});

// ---------- 知识层（R1：T14-T17） ----------
const IngestBody = z.object({
  dataset: z.string().min(1),
  path: z.string().min(1),
  title: z.string().min(1),
  version: z.string().min(1),
  content: z.string().min(1),
  license: z.string().optional(),
});
app.post("/api/v1/datasets/ingest", async (req) => {
  const b = zparse(IngestBody, req.body);
  const datasetId = ingestion.ensureDataset(b.dataset, b.license ?? "course-internal");
  const rev = ingestion.ingestDocument({
    datasetId,
    path: b.path,
    title: b.title,
    version: b.version,
    content: b.content,
    license: b.license,
  });
  return { datasetId, revision: rev };
});

const BuildIndexBody = z.object({ dataset: z.string().min(1), provider: z.enum(["fake-embedding", "openai-compatible"]).default("fake-embedding") });
app.post("/api/v1/datasets/index", async (req) => {
  const b = zparse(BuildIndexBody, req.body);
  const datasetId = ingestion.ensureDataset(b.dataset);
  const snap = await indexService.buildIndex(datasetId, { provider: b.provider }, { chunkerVersion: "chunker-1" });
  return { snapshot: snap };
});

const RetrievalBody = z.object({
  dataset: z.string().min(1),
  query: z.string().min(1),
  topK: z.number().int().positive().max(10).default(4),
  keyword: z.boolean().default(true),
  vector: z.boolean().default(true),
  fusion: z.boolean().default(true),
});
app.post("/api/v1/retrievals", async (req) => {
  const b = zparse(RetrievalBody, req.body);
  const datasetId = ingestion.ensureDataset(b.dataset);
  const snap = indexService.latest(datasetId);
  if (!snap) throw new ApiError(400, "INDEX_NOT_BUILT", "该数据集尚未建立索引；先 POST /api/v1/datasets/index");
  const result = retrievalSvc.query(snap, b.query, { topK: b.topK, keyword: b.keyword, vector: b.vector, fusion: b.fusion });
  return { indexSnapshot: { id: snap.id, embeddingVersion: snap.embeddingVersion, chunkerVersion: snap.chunkerVersion }, result };
});

const WikiProposeBody = z.object({
  slug: z.string().min(1),
  title: z.string().optional(),
  body: z.string().min(1),
  claims: z
    .array(z.object({ text: z.string().min(1), evidenceChunkIds: z.array(z.string()) }))
    .default([]),
  evidenceDocRevisions: z.array(z.string()).default([]),
  author: z.string().default("local-learner"),
});
app.post("/api/v1/wiki/pages", async (req) => {
  const b = zparse(WikiProposeBody, req.body);
  const r = wikiSvc.proposeRevision(b);
  return r;
});
app.get("/api/v1/wiki/pages/:slug", async (req) => {
  const { slug } = req.params as { slug: string };
  const page = wikiSvc.getPage(slug);
  if (!page) throw new ApiError(404, "PAGE_NOT_FOUND", "页面不存在");
  return { page, revisions: wikiSvc.revisionsOf(page.id) };
});
app.post("/api/v1/wiki/revisions/:id/publish", async (req) => {
  const { id } = req.params as { id: string };
  try {
    return { page: wikiSvc.publish(id) };
  } catch (err) {
    if (String(err).includes("WIKI_CONFLICTS_UNRESOLVED")) {
      throw new ApiError(409, "WIKI_CONFLICTS_UNRESOLVED", String(err).replace("Error: ", ""));
    }
    throw err;
  }
});
app.get("/api/v1/wiki/impact/:docRevisionId", async (req) => {
  const { docRevisionId } = req.params as { docRevisionId: string };
  return wikiSvc.impactAnalysis(docRevisionId);
});

const MemoryBody = z.object({
  content: z.string().min(1),
  kind: z.enum(["episodic", "semantic", "procedural"]).default("semantic"),
  scopeKind: z.enum(["user", "project", "session"]).default("user"),
  scopeId: z.string().default("local-learner"),
});
app.post("/api/v1/memories", async (req, reply) => {
  const b = zparse(MemoryBody, req.body);
  const r = memorySvc.write({ scopeKind: b.scopeKind, scopeId: b.scopeId, kind: b.kind, content: b.content });
  reply.code(r.duplicate ? 200 : 201);
  return r;
});
app.get("/api/v1/memories", async (req) => {
  const q = req.query as { query?: string; scopeId?: string };
  const scopeId = q.scopeId ?? "local-learner";
  if (q.query) return { hits: memorySvc.recall("user", scopeId, q.query) };
  return { entries: memorySvc.listActive("user", scopeId) };
});
app.delete("/api/v1/memories/:id", async (req) => {
  const { id } = req.params as { id: string };
  const q = req.query as { scopeId?: string };
  const ok = memorySvc.forget(id, "user", q.scopeId ?? "local-learner");
  if (!ok) throw new ApiError(404, "MEMORY_NOT_FOUND", "记忆不存在");
  return { forgotten: true };
});

// ---------- 审批（T20） ----------
app.get("/api/v1/approvals/pending", async () => {
  return { approvals: approvalSvc.listPending() };
});

const DecisionBody = z.object({
  decision: z.enum(["grant", "reject"]),
  decidedBy: z.string().default("local-instructor"),
});
app.post("/api/v1/approvals/:id/decision", async (req) => {
  const { id } = req.params as { id: string };
  const b = zparse(DecisionBody, req.body);
  try {
    return { approval: approvalSvc.decide(id, b.decision, b.decidedBy) };
  } catch (err) {
    if (String(err).includes("APPROVAL_ALREADY_DECIDED")) {
      throw new ApiError(409, "APPROVAL_ALREADY_DECIDED", "该审批已有决策");
    }
    throw err;
  }
});

// ---------- 工件 ----------
app.get("/api/v1/artifacts/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!ctx.blobs.exists(id)) throw new ApiError(404, "ARTIFACT_NOT_FOUND", "工件不存在");
  const meta = ctx.blobs.meta(id);
  const content = ctx.blobs.getContentById(id);
  reply.header("content-type", meta.mediaType);
  reply.header("x-blob-sha256", meta.sha256);
  return reply.send(Buffer.from(content));
});

// ---------- 静态资源（离线优先：本地打包，无 CDN） ----------
// 相对仓库根解析（pnpm 脚本 cwd 是 apps/api，不能用 process.cwd()）
const webDist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps", "web", "dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) {
      reply.code(404).send({ code: "NOT_FOUND", message: "not found", retryable: false });
      return;
    }
    const index = join(webDist, "index.html");
    if (existsSync(index)) {
      reply.header("content-type", "text/html");
      reply.send(readFileSync(index));
      return;
    }
    reply.code(404).send({ code: "NOT_FOUND", message: "not found", retryable: false });
  });
}

// ---------- 启动 ----------
if (process.env.AGENTGLASS_SEED_FAKE === "1") {
  const existing = ctx.db.prepare("SELECT id FROM model_profiles WHERE provider = 'fake'").get();
  if (!existing) {
    const id = `mp_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = new Date().toISOString();
    ctx.db
      .prepare(
        `INSERT INTO model_profiles (id, name, provider, protocol, endpoint, model_id, secret_ref, parameters, capabilities, created_at, updated_at)
         VALUES (?, ?, 'fake', 'fake/v1', '', 'fake-deterministic', NULL, '{}', ?, ?, ?)`,
      )
      .run(
        id,
        "fake-deterministic（教学模拟，非真实模型）",
        JSON.stringify({
          streaming: true,
          nativeTools: true,
          parallelToolCalls: true,
          structuredOutput: "native_schema",
          imageInput: false,
          audioInput: false,
          outputModalities: ["text"],
          usageReporting: "stream_and_final",
          contextWindow: 32000,
          testedAt: "static-declaration",
          probeSuiteVersion: "fake-1",
        }),
        now,
        now,
      );
    console.log("[api] 已注册 fake 教学模型配置（provider=fake，运行将明确标记为模拟）");
  }
}

const invokedDirectly = process.argv[1] != null && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  app
    .listen({ port: PORT, host: "127.0.0.1" })
    .then(() => console.log(`[api] listening on http://127.0.0.1:${PORT}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

export { app, ctx };

