/**
 * 运行协调器（T06/T11/T40 本地模式实现）。
 * - 轮询排队输入 → 无活动 run 时接纳并创建 run（冻结会话前缀）；
 * - 租约 + 逐 tick 处理控制命令（pause/cancel/resume）；
 * - 装配课程运行时输入（提示词、工具白名单、run 专属工作区）；
 * - 通过隔离客体执行学习者代码；可信宿主写回终态。
 */
import { mkdirSync, writeFileSync, copyFileSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  BudgetLimit,
  ModelProfileSnapshot,
  RunSpec,
  RuntimeContext,
} from "@agentglass/contracts";
import { DEFAULT_BUDGET } from "@agentglass/contracts";
import type { Database } from "@agentglass/db";
import { newId, nowIso } from "@agentglass/db";
import { BlobStore, EventStore } from "@agentglass/events";
import { BudgetLedger } from "@agentglass/policy";
import { ModelGateway } from "@agentglass/provider-gateway";
import { ToolBroker } from "@agentglass/tools";
import type { EffectLedger } from "@agentglass/tools";
import type { ToolHandler, ToolSpecForModel } from "@agentglass/contracts";
import { knowledgeToolHandlers, skillToolHandlers, WRITE_FILE_TOOL, RUN_TEST_TOOL, httpFetchTool } from "@agentglass/tools";
import { SkillRegistry } from "@agentglass/skills";
import { McpClient, mcpToolHandlers } from "@agentglass/mcp";
import { ReflectionService } from "@agentglass/evolution";
import { HookRegistry, toolAuditHook, teachingAnnotationHook, TaskProgressStore } from "@agentglass/harness";
import { ApprovalService } from "@agentglass/policy";
import { GraphRuntime } from "@agentglass/runtime-graph";
import { MultiAgentCoordinator, BoundedRecursionRunner } from "@agentglass/multi-agent";
import type { WorkerDef } from "@agentglass/multi-agent";
import { A2aClient, a2aToolHandler, startCourseAgentBridge } from "@agentglass/a2a";
import type { CourseAgentBridge } from "@agentglass/a2a";
import type { GraphDefinition } from "@agentglass/contracts";
import { IngestionService, IndexService, RetrievalService, MemoryService, WikiService } from "@agentglass/knowledge";
import {
  ReferenceRuntime,
  RsiLoopRunner,
  type LessonRuntimeInput,
  type RsiFrozenTask,
  type RsiInput,
  STATE_SCHEMA_VERSION,
} from "@agentglass/runtime-reference";
import type { LessonExtensionHost } from "@agentglass/runtime-reference";
import { GuestProcessHost } from "@agentglass/learner-runtime";
import { SessionService } from "@agentglass/conversation";
import { LessonRegistry } from "@agentglass/lessons";
import { SourceManifestBuilder, sha256 } from "@agentglass/source-map";
import { sha256Text } from "@agentglass/code-lab";
import { InProcessExtensionHost } from "@agentglass/runtime-reference";
import type { ContextCandidate } from "@agentglass/context";
import { build } from "esbuild";

export interface WorkerOptions {
  db: Database;
  dataDir: string;
  lessons: LessonRegistry;
  pollIntervalMs?: number;
  /** 单 tick 最多处理的运行数 */
  concurrency?: number;
}

const ACTIVE_STATES = "('created','queued','running','pause_requested','paused','awaiting_approval','cancel_requested','reconciliation_required')";

export class RunCoordinator {
  readonly sessions: SessionService;
  readonly events: EventStore;
  readonly blobs: BlobStore;
  readonly budgets: BudgetLedger;
  readonly gateway: ModelGateway;
  readonly lessons: LessonRegistry;
  private runtime: ReferenceRuntime;
  private broker: ToolBroker;
  private sourceManifests: SourceManifestBuilder;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private activeRuns = new Map<string, { abort: AbortController; leaseEpoch: number; awaitingApproval: boolean }>();

  private ingestion: IngestionService;
  private indexService: IndexService;
  private retrievalSvc: RetrievalService;
  private memorySvc: MemoryService;
  private skillRegistry: SkillRegistry;
  private approvals: ApprovalService;
  private runSkillSlugs = new Map<string, string[]>();
  private runMcpClients = new Map<string, McpClient>();
  private runMcpTools = new Map<string, ToolSpecForModel[]>();
  private runA2aBridges = new Map<string, CourseAgentBridge[]>();
  private hooks: HookRegistry;
  private taskProgress: TaskProgressStore;
  private reflectionSvc: ReflectionService;
  private runDatasets = new Map<string, string[]>();

  constructor(private readonly opts: WorkerOptions) {
    this.sessions = new SessionService(opts.db, this.blobsInstance());
    this.blobs = this.blobsInstance();
    this.events = new EventStore(opts.db);
    this.budgets = new BudgetLedger(opts.db);
    this.gateway = new ModelGateway(this.blobs);
    this.lessons = opts.lessons;
    this.sourceManifests = new SourceManifestBuilder(opts.db, this.blobs);
    this.ingestion = new IngestionService(opts.db, this.blobs);
    this.indexService = new IndexService(opts.db, this.blobs, this.ingestion);
    this.retrievalSvc = new RetrievalService(opts.db, this.blobs, this.ingestion);
    this.memorySvc = new MemoryService(opts.db);
    this.skillRegistry = new SkillRegistry(opts.db, this.blobs);
    this.approvals = new ApprovalService(opts.db);
    this.hooks = new HookRegistry();
    this.hooks.register(toolAuditHook.decl, toolAuditHook.impl);
    this.hooks.register(teachingAnnotationHook.decl, teachingAnnotationHook.impl);
    this.taskProgress = new TaskProgressStore(opts.db, this.blobs);
    this.reflectionSvc = new ReflectionService(this.events, this.blobs);
    const registryHandlers = [READ_TEXT_HANDLER, CALCULATOR_HANDLER];
    this.broker = ToolBroker.fromRegistry(registryHandlers, this.createEffectLedger());
    this.runtime = new ReferenceRuntime({
      events: this.events,
      blobs: this.blobs,
      budget: this.budgets,
      gateway: this.gateway,
      broker: this.broker,
      extensions: new InProcessExtensionHost({}),
      modelSnapshot: FAKE_SNAPSHOT,
      pollCommands: () => ({ pauseRequested: false, cancelRequested: false }),
    });
  }

  private blobsDir(): string {
    return join(this.opts.dataDir, "blobs");
  }
  private blobsInstance(): BlobStore {
    return new BlobStore(this.opts.db, this.blobsDir());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async (): Promise<void> => {
      try {
        await this.processCommands();
        await this.admitQueuedInputs();
        await this.pickAndRun();
      } catch (err) {
        // 协调器崩溃不能丢账本事实；错误仅记录
        console.error("[coordinator] tick error:", err);
      }
    };
    const loop = (): void => {
      if (!this.running) return;
      void tick().finally(() => {
        this.timer = setTimeout(loop, this.opts.pollIntervalMs ?? 400);
      });
    };
    loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    for (const [, entry] of this.activeRuns) entry.abort.abort();
  }

  // ---- 控制命令 ----
  private async processCommands(): Promise<void> {
    const rows = this.opts.db
      .prepare(
        "SELECT * FROM run_commands WHERE state = 'pending' ORDER BY created_at ASC LIMIT 50",
      )
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const runId = String(row.run_id);
      const command = String(row.command);
      const active = this.activeRuns.get(runId);
      const run = this.getRun(runId);
      if (!run) {
        this.dbPrepare("UPDATE run_commands SET state = 'rejected', applied_at = ? WHERE id = ?").run(
          nowIso(),
          String(row.id),
        );
        continue;
      }
      if (command === "cancel") {
        // 终态运行不接受控制命令（防僵尸状态：completed 被改成 cancel_requested）
        if (!["completed", "failed", "cancelled"].includes(String(run.state))) {
          if (active) {
            active.abort.abort();
          }
          this.setRunState(runId, "cancel_requested");
        }
      } else if (command === "pause") {
        if (["queued", "running", "awaiting_approval", "pause_requested"].includes(String(run.state))) {
          this.setRunState(runId, "pause_requested");
        }
      } else if (command === "resume") {
        if (String(run.state) === "paused") {
          this.setRunState(runId, "running");
          // resumeEpoch 推进：控制门据此放行驻留（断点与手动暂停共用）
          this.resumeEpochs.set(runId, (this.resumeEpochs.get(runId) ?? 0) + 1);
        }
      }
      this.dbPrepare("UPDATE run_commands SET state = 'applied', applied_at = ? WHERE id = ?").run(
        nowIso(),
        String(row.id),
      );
    }
  }

  private dbPrepare(sql: string) {
    return this.opts.db.prepare(sql);
  }

  /**
   * 控制状态（含断点）：边界轮询直接读库消费命令，不依赖 tick 循环。
   * 断点存于 run_breakpoints（UI 按运行设置）；target 为边界名或 node:<id>。
   * resumeEpoch 随 resume 命令递增，是驻留放行的唯一信号（驻留中 run 状态已是 paused）。
   */
  private readonly resumeEpochs = new Map<string, number>();

  private controlState(runId: string): {
    pauseRequested: boolean;
    cancelRequested: boolean;
    breakpoints: string[];
    resumeEpoch: number;
  } {
    const pending = this.dbPrepare(
      "SELECT command FROM run_commands WHERE run_id = ? AND state = 'pending' ORDER BY created_at DESC LIMIT 1",
    ).get(runId) as { command: string } | undefined;
    if (pending?.command === "cancel") return { pauseRequested: false, cancelRequested: true, breakpoints: [], resumeEpoch: this.resumeEpochs.get(runId) ?? 0 };
    if (pending?.command === "pause") return { pauseRequested: true, cancelRequested: false, breakpoints: [], resumeEpoch: this.resumeEpochs.get(runId) ?? 0 };
    const r = this.getRun(runId);
    const breakpoints = (
      this.dbPrepare("SELECT target FROM run_breakpoints WHERE run_id = ?").all(runId) as Array<
        { target: string }
      >
    ).map((row) => row.target);
    return {
      pauseRequested: String(r?.state ?? "") === "pause_requested",
      cancelRequested: String(r?.state ?? "") === "cancel_requested",
      breakpoints,
      resumeEpoch: this.resumeEpochs.get(runId) ?? 0,
    };
  }

  private getRun(runId: string): Record<string, unknown> | undefined {
    return this.dbPrepare("SELECT * FROM runs WHERE id = ?").get(runId) as
      | Record<string, unknown>
      | undefined;
  }

  private setRunState(runId: string, state: string): void {
    this.dbPrepare("UPDATE runs SET state = ? WHERE id = ?").run(state, runId);
  }

  // ---- 输入接纳 → run 创建 ----
  private admitQueuedInputs(): void {
    const sessions = this.opts.db
      .prepare(
        `SELECT DISTINCT s.id FROM sessions s JOIN input_submissions i ON i.session_id = s.id
         WHERE i.status = 'queued'`,
      )
      .all() as Array<{ id: string }>;
    for (const { id: sessionId } of sessions) {
      // A01：无有效模型配置时不能发起标为实时的运行（输入保持排队，不接纳）
      const sessionRow = this.sessions.getSession(sessionId);
      if (sessionRow) {
        const snapId = String(sessionRow.model_profile_snapshot_id);
        const snap = this.dbPrepare(
          "SELECT id FROM model_profile_snapshots WHERE id = ?",
        ).get(snapId);
        if (!snap) continue;
      }
      const accepted = this.sessions.acceptNextInput(sessionId);
      if (!accepted) continue;
      const runId = String(accepted.input.acceptedRunId);
      const session = this.sessions.getSession(sessionId)!;
      // 输入提交时冻结的代码/配置选择（排队后修改会话默认版本不影响本输入）
      const inputRow = this.dbPrepare(
        "SELECT agent_revision_id, model_profile_snapshot_id, breakpoints FROM input_submissions WHERE id = ?",
      ).get(accepted.input.id) as { agent_revision_id: string; model_profile_snapshot_id: string; breakpoints: string };
      this.events.transact(() => {
        this.dbPrepare(
          `INSERT INTO runs (id, mode, state, experiment_version, lesson_id, lesson_revision,
            runtime_snapshot_id, model_profile_snapshot_id, agent_revision_id, session_id,
            input_submission_id, conversation_snapshot_id, asset_snapshot_id, policy_snapshot_id,
            input_ref, input_preview, budget, created_at)
           VALUES (?, 'live', 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          runId,
          `${String(session.lesson_id)}@${String(session.lesson_revision)}`,
          String(session.lesson_id),
          String(session.lesson_revision),
          String(session.runtime_snapshot_id),
          inputRow.model_profile_snapshot_id,
          inputRow.agent_revision_id,
          sessionId,
          accepted.input.id,
          accepted.conversationSnapshotId,
          String(session.asset_snapshot_id),
          String(session.policy_snapshot_id),
          `input:${accepted.input.id}`,
          accepted.input.contentPreview,
          String(session.budget),
          nowIso(),
        );
        this.events.append(runId, [
          { type: "input.accepted", summary: { inputId: accepted.input.id, origin: accepted.input.origin } },
          { type: "run.created", summary: { lessonId: String(session.lesson_id), mode: "live" } },
        ]);
        // 断点继承：同会话上一运行的断点复制到新运行（UI 的 PUT 可能晚于短运行完成；
        // 服务端继承保证调试连续性；用户在图上显式取消才移除）
        this.dbPrepare(
          `INSERT OR IGNORE INTO run_breakpoints (run_id, target, created_at)
           SELECT ?, target, ?
           FROM run_breakpoints
           WHERE run_id = (
             SELECT r2.id FROM runs r2
             WHERE r2.session_id = ? AND r2.id != ?
             ORDER BY r2.created_at DESC LIMIT 1
           )`,
        ).run(runId, nowIso(), sessionId, runId);
        // 输入携带的断点：首运行没有继承来源，提交时随输入冻结的断点在此播种（同事务，无竞态）
        const carried = JSON.parse(inputRow.breakpoints || "[]") as unknown;
        if (Array.isArray(carried)) {
          const seed = this.dbPrepare(
            "INSERT OR IGNORE INTO run_breakpoints (run_id, target, created_at) VALUES (?, ?, ?)",
          );
          for (const target of carried) {
            if (typeof target === "string" && target.length > 0) seed.run(runId, target, nowIso());
          }
        }
      });
    }
  }

  // ---- 运行执行 ----
  private async pickAndRun(): Promise<void> {
    const maxConcurrent = this.opts.concurrency ?? 2;
    // 审批驻留的运行不在执行，不占并发槽位；否则一个等决策的运行会阻塞其他会话的输入接纳（队头阻塞）
    let executing = 0;
    for (const entry of this.activeRuns.values()) if (!entry.awaitingApproval) executing += 1;
    if (executing >= maxConcurrent) return;
    const rows = this.dbPrepare(
      `SELECT id FROM runs WHERE state = 'queued' ORDER BY created_at ASC LIMIT ?`,
    ).all(maxConcurrent - executing) as Array<{ id: string }>;
    for (const { id } of rows) {
      // 不 await：审批驻留/长流式运行不得阻塞 tick（acceptNextInput 依赖周期性执行）
      void this.executeRun(id).catch((err) => {
        console.error("[coordinator] executeRun error:", err);
      });
    }
  }

  async executeRun(runId: string): Promise<void> {
    const run = this.getRun(runId);
    if (!run) return;
    const leaseEpoch = Number(run.lease_epoch) + 1;
    const workerId = `worker-${process.pid}`;
    const leaseExpiry = new Date(Date.now() + 10 * 60_000).toISOString();
    const updated = this.dbPrepare(
      `UPDATE runs SET state = 'running', attempt_id = ?, lease_epoch = ?, lease_expires_at = ?, worker_id = ?, started_at = ?
       WHERE id = ? AND state = 'queued'`,
    ).run(newId("att"), leaseEpoch, leaseExpiry, workerId, nowIso(), runId);
    if (Number(updated.changes) !== 1) return; // 其他 worker 已取走

    const abort = new AbortController();
    this.activeRuns.set(runId, { abort, leaseEpoch, awaitingApproval: false });

    try {
      const input = await this.assembleLessonInput(runId, run);
      const spec = this.buildRunSpec(runId, run, input.budget);
      const ctx: RuntimeContext = {
        runId,
        attemptId: newId("att"),
        leaseEpoch,
        workspaceId: input.workspaceRoot,
        secretScopeId: "lesson",
      };
      // 扩展宿主：有冻结构建时使用隔离客体；否则进程内空绑定
      const extensions: LessonExtensionHost = input.revisionBundlePath
        ? new GuestProcessHost(input.revisionBundlePath, { callTimeoutMs: 2000 })
        : new InProcessExtensionHost({});

      // 每 run 的工具代理：通用工具 + 知识工具（数据集白名单按本次运行装配）
      const datasetIds = this.runDatasets.get(runId) ?? [];
      const knowledgeHandlers: ToolHandler[] = knowledgeToolHandlers({
        indexService: this.indexService,
        retrieval: this.retrievalSvc,
        wiki: this.wikiSvc(),
        memory: this.memorySvc,
        datasetIdsFor: () => datasetIds,
        memoryScope: { kind: "user", id: "local-learner" },
      });
      const skillHandlers: ToolHandler[] = skillToolHandlers({
        registry: this.skillRegistry,
        allowedSlugs: this.runSkillSlugs.get(runId) ?? [],
        onLoaded: (slug, version, chars) => {
          this.events.transact(() => {
            this.events.append(runId, [
              { type: "skill.loaded", summary: { slug, version, chars } },
            ]);
          });
        },
      });
      // T21：课程声明 mcp_servers 时启动本地课程 server 并映射其工具（白名单仍由课程/宿主决定）
      const manifest = this.lessons.manifest(String(run.lesson_id));
      let mcpHandlers: ToolHandler[] = [];
      let a2aHandlers: ToolHandler[] = [];
      let mcpToolsForModel: ToolSpecForModel[] = [];
      const mcpServerIds = manifest.runtime.mcp_servers ?? [];
      if (mcpServerIds.length > 0) {
        const serverScript = join(process.cwd(), "packages", "mcp", "src", "course-server.mjs");
        for (const serverId of mcpServerIds) {
          const client = new McpClient({ serverName: serverId, onProtocolEvent: (e) => {
            this.events.transact(() => {
              this.events.append(runId, [
                {
                  type: "mcp.protocol_event",
                  summary: { dir: e.direction, kind: e.kind, method: e.method ?? null, server: serverId, bytes: e.summary.bytes ?? null },
                  conceptIds: ["mcp"],
                },
              ]);
            });
          } });
          await client.connect(serverScript);
          this.runMcpClients.set(runId, client);
          this.events.transact(() => {
            this.events.append(runId, [
              {
                type: "mcp.server_connected",
                summary: {
                  serverId,
                  protocolVersion: client.connectedServer?.protocolVersion ?? null,
                  serverName: client.connectedServer?.serverInfo.name ?? null,
                },
                conceptIds: ["mcp"],
              },
            ]);
          });
          const tools = await client.listTools();
          mcpHandlers.push(...mcpToolHandlers(client, tools, serverId));
          mcpToolsForModel.push(
            ...tools.map((t) => ({ name: `mcp_${serverId}_${t.name}`, description: t.description ?? "", parameters: t.inputSchema as import("@agentglass/contracts").JsonValue })),
          );
        }
      }
      // T28：课程声明 a2a_agents 时启动本地课程 agent 桥并映射为受控工具（策略/白名单不变）
      const a2aAgentIds = manifest.runtime.a2a_agents ?? [];
      if (a2aAgentIds.length > 0) {
        const bridges: CourseAgentBridge[] = [];
        for (const agentId of a2aAgentIds) {
          const bridge = await startCourseAgentBridge();
          bridges.push(bridge);
          this.runA2aBridges.set(runId, bridges);
          const client = new A2aClient({ baseUrl: bridge.baseUrl, allowPrivateNetwork: true });
          const card = await client.fetchAgentCard() as { name?: string; description?: string };
          this.events.transact(() => {
            this.events.append(runId, [
              {
                type: "a2a.agent_connected",
                summary: { agentId, agentName: card.name ?? agentId, url: bridge.baseUrl, note: "本地课程 agent 桥（回环地址）；远端输出为待验证信息" },
                conceptIds: ["a2a"],
              },
            ]);
          });
          const mapped = a2aToolHandler({ client, agentName: agentId });
          a2aHandlers.push(mapped);
        }
      }
      const broker = ToolBroker.fromRegistry(
        [...GENERIC_TOOL_HANDLERS, ...knowledgeHandlers, WRITE_FILE_TOOL, RUN_TEST_TOOL, HTTP_FETCH_TOOL, ...skillHandlers, ...mcpHandlers, ...a2aHandlers],
        this.createEffectLedger(),
      );

      // 驻留/放行钩子（参考循环与 RSI 循环共用）：断点/手动暂停 → run.breakpoint_hit + run.paused
      const gateHooks: import("@agentglass/runtime-reference").ControlGateEvents = {
        onPaused: (boundary, reason, at): void => {
          this.setRunState(runId, "paused");
          this.events.transact(() => {
            if (reason === "breakpoint") {
              this.events.append(runId, [
                {
                  type: "run.breakpoint_hit",
                  summary: { boundary, node: at ?? null, target: at != null ? `node:${at}` : boundary },
                  conceptIds: ["control"],
                },
              ]);
            }
            this.events.append(runId, [
              { type: "run.paused", summary: { boundary, reason, node: at ?? null } },
            ]);
          });
        },
        onResumed: (): void => {
          this.setRunState(runId, "running");
          // 驻留时长豁免墙钟：人类检视（暂停/断点）不消耗执行预算；豁免时长入账保持可观测
          const lastPaused = this.events
            .readRange(runId, 0, this.events.maxSeq(runId))
            .filter((e) => e.type === "run.paused")
            .at(-1);
          const dwellMs = lastPaused ? Math.max(0, Date.now() - Date.parse(lastPaused.emittedAt)) : 0;
          this.budgets.extendWallDeadlineByRun(runId, dwellMs);
          this.events.transact(() => {
            this.events.append(runId, [{ type: "run.resumed", summary: { dwellMs } }]);
          });
        },
      };

      const runtime = new ReferenceRuntime({
        events: this.events,
        blobs: this.blobs,
        budget: this.budgets,
        gateway: this.gateway,
        broker,
        extensions,
        modelSnapshot: input.modelSnapshot,
        approval: input.approval,
        hooks: this.hooks,
        reflection: this.reflectionSvc,
        pollCommands: () => this.controlState(runId),
        gateHooks,
      });

      this.events.transact(() => {
        this.events.append(runId, [
          { type: "agent.revision_bound", summary: { agentRevisionId: String(run.agent_revision_id) } },
        ]);
      });

      this.runMcpTools.set(runId, mcpToolsForModel);
      let result;
      if (input.multiAgent) {
        const maRuntime = new MultiAgentCoordinator({
          events: this.events,
          blobs: this.blobs,
          budget: this.budgets,
          gateway: this.gateway,
          broker,
          modelSnapshot: input.modelSnapshot,
          pollCommands: () => this.controlState(runId),
        });
        result = await maRuntime.execute(spec, {
          topology: input.multiAgent.topology,
          systemPrompt: input.lessonInput.systemPrompt,
          taskText: input.lessonInput.taskText,
          workers: input.multiAgent.workers,
          handoffChain: input.multiAgent.handoffChain,
          tools: input.lessonInput.tools,
          allowedToolIds: input.lessonInput.allowedToolIds,
          budget: input.lessonInput.budget,
          workspaceRoot: input.lessonInput.workspaceRoot,
          forceConflictKey: input.multiAgent.forceConflictKey,
        }, abort.signal);
      } else if (input.recursion) {
        // T29：有界递归（L35）。深度上限服务端双重约束；节点子调用从父预算原子预留
        const recRuntime = new BoundedRecursionRunner({
          events: this.events,
          blobs: this.blobs,
          budget: this.budgets,
          gateway: this.gateway,
          modelSnapshot: input.modelSnapshot,
          pollCommands: () => this.controlState(runId),
        });
        result = await recRuntime.execute(spec, {
          systemPrompt: input.lessonInput.systemPrompt,
          rootText: input.recursion.rootText,
          question: input.recursion.question,
          maxDepth: input.recursion.maxDepth,
          partitionChars: input.recursion.partitionChars,
          budget: input.lessonInput.budget,
        }, abort.signal);
      } else if (input.rsi) {
        // L45：有界 RSI 循环（DGM 教学骨架）。冻结集/评分/预算在平台侧；before_model 边界可断点
        const rsiRuntime = new RsiLoopRunner({
          events: this.events,
          blobs: this.blobs,
          budget: this.budgets,
          gateway: this.gateway,
          modelSnapshot: input.modelSnapshot,
          pollCommands: () => this.controlState(runId),
          gateHooks,
        });
        result = await rsiRuntime.execute(spec, input.rsi, abort.signal);
      } else if (input.graphDefinition) {
        const graphRuntime = new GraphRuntime({
          events: this.events,
          blobs: this.blobs,
          budget: this.budgets,
          gateway: this.gateway,
          broker,
          modelSnapshot: input.modelSnapshot,
          pollCommands: () => this.controlState(runId),
        });
        result = await graphRuntime.execute(spec, input.graphDefinition, {
          systemPrompt: input.lessonInput.systemPrompt,
          taskText: input.lessonInput.taskText,
          tools: input.lessonInput.tools,
          allowedToolIds: input.lessonInput.allowedToolIds,
          budget: input.lessonInput.budget,
          workspaceRoot: input.lessonInput.workspaceRoot,
        }, abort.signal);
      } else {
        result = await runtime.start(spec, ctx, abort.signal, input.lessonInput);
      }
      // T23 长期任务状态：run 终态时写入进展工件（数据库/事件为准）
      try {
        const prog = this.taskProgress.update(runId, [
          { id: "run", title: `运行 ${result.reasonCode}`, status: result.state === "completed" ? "done" : "blocked" },
        ]);
        this.events.transact(() => {
          this.events.append(runId, [
            { type: "task.progress_updated", summary: { progressRef: prog.progressRef, done: prog.done, total: prog.total } },
          ]);
        });
      } catch { /* 进展工件失败不改变运行终态 */ }
      const mcpClient = this.runMcpClients.get(runId);
      if (mcpClient) {
        await mcpClient.close();
        this.runMcpClients.delete(runId);
        this.events.transact(() => {
          this.events.append(runId, [{ type: "mcp.server_closed", summary: {} }]);
        });
      }
      await this.closeA2aBridges(runId);
      this.applyTerminalState(runId, result.state, result.reasonCode, result.outputRefs);
    } catch (err) {
      await this.closeA2aBridges(runId);
      this.events.transact(() => {
        this.events.append(runId, [
          { type: "run.failed", summary: { error: String(err).slice(0, 400) } },
        ]);
      });
      this.applyTerminalState(runId, "failed", "coordinator_error", []);
    } finally {
      this.activeRuns.delete(runId);
    }
  }

  /** A2A 桥生命周期：成功与失败路径都关闭本地 agent 子进程与 http 桥 */
  private async closeA2aBridges(runId: string): Promise<void> {
    const bridges = this.runA2aBridges.get(runId);
    if (!bridges) return;
    this.runA2aBridges.delete(runId);
    for (const b of bridges) {
      try {
        await b.close();
      } catch { /* 清理失败不影响运行终态 */ }
    }
  }

  private applyTerminalState(
    runId: string,
    state: string,
    reasonCode: string,
    outputRefs: unknown[],
  ): void {
    const runState =
      state === "completed" && reasonCode === "paused"
        ? "paused"
        : state === "cancelled"
          ? "cancelled"
          : state === "failed"
            ? "failed"
            : "completed";
    this.dbPrepare(
      `UPDATE runs SET state = ?, stop_reason = ?, output_refs = ?, finished_at = ? WHERE id = ?`,
    ).run(runState, reasonCode, JSON.stringify(outputRefs), nowIso(), runId);
    this.events.transact(() => {
      this.events.append(runId, [
        {
          type: `run.${runState === "completed" ? "completed" : runState}`,
          summary: { reasonCode },
        },
      ]);
    });
    // 真终态后 outbox 不再有实时投递意义；paused 只是驻留，恢复后仍会产生新事件
    if (runState !== "paused") {
      this.events.markRunPublished(runId);
    }
  }

  // ---- 装配 ----
  private async assembleLessonInput(
    runId: string,
    run: Record<string, unknown>,
  ): Promise<{
    lessonInput: LessonRuntimeInput;
    modelSnapshot: ModelProfileSnapshot;
    revisionBundlePath?: string;
    workspaceRoot: string;
    budget: BudgetLimit;
    approval: {
      gatedToolIds: string[];
      request(runId: string, toolId: string, toolRevision: string, args: Record<string, unknown>): string;
      verify(approvalId: string, args: Record<string, unknown>): { valid: boolean; reason?: string };
      waitDecision(approvalId: string, signal: AbortSignal): Promise<"granted" | "rejected">;
      onStateChange(state: "awaiting_approval" | "running"): void;
    };
    graphDefinition?: GraphDefinition;
    multiAgent?: {
      topology: "parallel" | "handoff" | "blackboard";
      workers: WorkerDef[];
      handoffChain?: string[];
      forceConflictKey?: string;
    };
    recursion?: {
      maxDepth: number;
      partitionChars: number;
      question: string;
      rootText: string;
    };
    rsi?: RsiInput;
  }> {
    const lessonId = String(run.lesson_id);
    const lesson = this.lessons;
    const manifest = lesson.manifest(lessonId);
    const modelSnapshot = this.loadModelSnapshot(String(run.model_profile_snapshot_id));
    const budget = JSON.parse(String(run.budget)) as BudgetLimit;

    // 工作区：run 专属；复制课程数据集（只读素材的副本）
    const workspaceRoot = join(this.opts.dataDir, "workspaces", runId);
    mkdirSync(workspaceRoot, { recursive: true });
    for (const ds of lesson.allDatasets(lessonId)) {
      writeFileSync(join(workspaceRoot, basename(ds.name)), ds.content, "utf8");
    }
    void copyFileSync;

    // 冻结的 AgentRevision（课程基线或学习者个人变体）
    const revisionId = String(run.agent_revision_id);
    const { bundlePath, systemPrompt } = this.resolveRevisionAssets(revisionId, lessonId);

    // R2 技能装配：课程 assets 中 skill_* 指向技能目录 → 幂等安装；白名单记录
    const skillSlugs: string[] = [];
    for (const [key, rel] of Object.entries(manifest.assets)) {
      if (!key.startsWith("skill_")) continue;
      const dir = join(this.lessons.lessonDir(lessonId), rel);
      if (!existsSync(dir)) continue;
      const skill = this.skillRegistry.installFromDir(dir);
      if (!skillSlugs.includes(skill.slug)) skillSlugs.push(skill.slug);
    }
    this.runSkillSlugs.set(runId, skillSlugs);

    // 知识装配：课程声明的文档资产 → 幂等摄取 + fake-embedding 索引（记录版本）
    const datasetIds: string[] = [];
    for (const [key, rel] of Object.entries(manifest.assets)) {
      if (!key.startsWith("docs_") || !rel.endsWith(".md")) continue;
      const content = this.lessons.dataset(lessonId, key)?.content;
      if (content == null) continue;
      const datasetId = this.ingestion.ensureDataset(`lesson-${lessonId}`);
      const version = sha256Text(content).slice(0, 8);
      this.ingestion.ingestDocument({
        datasetId,
        path: rel.split("/").pop() ?? key,
        title: key.replace(/^docs_/, ""),
        version,
        content,
      });
      await this.indexService.buildIndex(datasetId, { provider: "fake-embedding" }, { chunkerVersion: "chunker-1" });
      if (!datasetIds.includes(datasetId)) datasetIds.push(datasetId);
    }
    this.runDatasets.set(runId, datasetIds);

    // 工具白名单：课程声明 ∩ 平台注册（R0 通用工具 + R1 知识工具）
    const registered = new Map<string, ToolRevision>([
      ["read_text", READ_TEXT_REVISION],
      ["calculator", CALCULATOR_REVISION],
      ["search_documents", SEARCH_REVISION],
      ["read_wiki_page", WIKI_READ_REVISION],
      ["remember", REMEMBER_REVISION],
      ["recall", RECALL_REVISION],
      ["write_file", WRITE_FILE_TOOL.revision],
      ["run_test", RUN_TEST_TOOL.revision],
      ["http_fetch", HTTP_FETCH_REVISION],
      ["list_skills", SKILL_REV_QUERY[0]!],
      ["load_skill", SKILL_REV_QUERY[1]!],
    ]);
    const allowedToolIds = (manifest.requires.tools ?? []).filter((t) => registered.has(t) || t.startsWith("mcp_") || t.startsWith("a2a_"));
    const tools = allowedToolIds.map((t): ToolRevision => registered.get(t) ?? {
      toolId: t,
      revision: t.startsWith("a2a_") ? "a2a" : "mcp",
      title: t,
      description: t.startsWith("a2a_")
        ? `A2A 远程 Agent 工具 ${t}（agent-as-tool；结果为待验证信息）`
        : `MCP 工具 ${t}（发现于课程 server）`,
      riskLevel: "readonly_pure",
      parametersSchema: t.startsWith("a2a_")
        ? { type: "object", properties: { task: { type: "string", description: "委派给远程 Agent 的任务描述" } }, required: ["task"] }
        : { type: "object", properties: { model: { type: "string" } }, required: [] },
      idempotent: true,
      supportsStatusQuery: false,
    });

    // 会话前缀候选（同一 session 既有 run 的对话）
    const priorCandidates = this.loadPriorCandidates(String(run.session_id), String(run.conversation_snapshot_id));

    let graphDefinition: GraphDefinition | undefined;
    if (manifest.runtime.profile === "graph") {
      const graphFile = join(this.lessons.lessonDir(lessonId), manifest.runtime.graph_file ?? "graph.json");
      graphDefinition = JSON.parse(readFileSync(graphFile, "utf8")) as GraphDefinition;
    }

    // 审批集成（T20）：workspace_write 工具走具体效果审批
    const approval = {
      gatedToolIds: ["write_file"],
      request: (rid: string, toolId: string, toolRevision: string, args: Record<string, unknown>): string => {
        const row = this.approvals.request({
          runId: rid,
          actorId: "local-learner",
          toolRevision,
          args,
          policyRevision: "course-policy@1",
          target: `workspace:${toolId}`,
        });
        this.events.transact(() => {
          this.events.append(rid, [
            {
              type: "approval.requested",
              summary: { approvalId: row.id, toolId, toolRevision, argsSummary: row.argsSummary, target: row.target, expiresAt: row.expiresAt },
              conceptIds: ["approval"],
            },
          ]);
        });
        return row.id;
      },
      verify: (approvalId: string, args: Record<string, unknown>) =>
        this.approvals.verifyForDispatch(
          approvalId,
          { actorId: "local-learner", runId: runId, toolRevision: "1.0.0", args, policyRevision: "course-policy@1", target: `workspace:write_file` },
          new Date().toISOString(),
        ),
      waitDecision: async (approvalId: string, sig: AbortSignal): Promise<"granted" | "rejected"> => {
        // 驻留等待决策；运行取消时以 rejected 返回（拒绝写入，不静默成功）
        // 审批驻留豁免墙钟：人类思考审批的时间不消耗执行预算（与 gate 驻留同一语义，
        // 否则 L21 这类审批课思考超过 maxWallTimeMs 后批准，运行会被墙钟预算杀死）
        const waitStart = Date.now();
        try {
          for (;;) {
            if (sig.aborted) return "rejected";
            const cmd = this.dbPrepare(
              "SELECT command FROM run_commands WHERE run_id = ? AND state = 'pending' ORDER BY created_at DESC LIMIT 1",
            ).get(runId) as { command: string } | undefined;
            if (cmd?.command === "cancel") return "rejected";
            const row = this.approvals.get(approvalId);
            if (row?.state === "granted") return "granted";
            if (row?.state === "rejected" || row?.state === "invalidated") return "rejected";
            await new Promise((r) => setTimeout(r, 250));
          }
        } finally {
          this.budgets.extendWallDeadlineByRun(runId, Math.max(0, Date.now() - waitStart));
        }
      },
      onStateChange: (st: "awaiting_approval" | "running"): void => {
        const entry = this.activeRuns.get(runId);
        if (entry) entry.awaitingApproval = st === "awaiting_approval";
        this.setRunState(runId, st);
      },
    };
    const lessonInput: LessonRuntimeInput = {
      profile: manifest.runtime.profile,
      systemPrompt,
      priorCandidates,
      taskText: this.loadInputText(run),
      tools: tools.map((t) => ({
        name: t.toolId,
        description: t.description,
        parameters: t.parametersSchema,
      })),
      allowedToolIds,
      budget,
      workspaceRoot,
      stream: true,
      maxToolResultChars: 4000,
      chainSteps: manifest.runtime.chain_steps?.map((s) => ({
        instruction: s.instruction,
        allowTools: s.allow_tools,
      })),
      compaction: manifest.runtime.compaction ?? "none",
      reflectionOnFailure: manifest.runtime.reflection_on_failure === true,
    };
    const multiAgent = manifest.runtime.multi_agent
      ? {
          topology: manifest.runtime.multi_agent.topology,
          workers: manifest.runtime.multi_agent.workers as unknown as WorkerDef[],
          handoffChain: manifest.runtime.multi_agent.handoff_chain,
          forceConflictKey: manifest.runtime.multi_agent.force_conflict_key,
        }
      : undefined;
    // T29：有界递归配置；长输入外部化——优先课程 long_input 数据集资产，缺省用用户输入文本
    const recursion = manifest.runtime.recursion
      ? {
          maxDepth: manifest.runtime.recursion.max_depth,
          partitionChars: manifest.runtime.recursion.partition_chars ?? 1200,
          question: manifest.runtime.recursion.question,
          rootText: this.lessons.dataset(lessonId, "long_input")?.content ?? lessonInput.taskText,
        }
      : undefined;
    // L45：有界 RSI 配置；冻结验证集为平台持有资产（候选不可见/不可改），代数再套服务端绝对上限
    let rsi: RsiInput | undefined;
    if (manifest.runtime.rsi) {
      const frozenAsset = this.lessons.dataset(lessonId, manifest.runtime.rsi.frozen_tasks);
      if (!frozenAsset) throw new Error(`RSI_FROZEN_TASKS_MISSING: ${manifest.runtime.rsi.frozen_tasks}`);
      const parsed = JSON.parse(frozenAsset.content) as { tasks?: RsiFrozenTask[] };
      rsi = {
        systemPrompt,
        improvementGoal: lessonInput.taskText,
        frozenTasks: parsed.tasks ?? [],
        maxGenerations: manifest.runtime.rsi.max_generations,
        budget,
      };
    }
    return { lessonInput, modelSnapshot, revisionBundlePath: bundlePath, workspaceRoot, budget, approval, graphDefinition, multiAgent, recursion, rsi };
  }

  private loadInputText(run: Record<string, unknown>): string {
    const inputRef = String(run.input_ref ?? "");
    if (!inputRef.startsWith("input:")) return String(run.input_preview ?? "");
    const row = this.dbPrepare("SELECT content_ref FROM input_submissions WHERE id = ?").get(
      inputRef.slice(6),
    ) as { content_ref: string } | undefined;
    return row ? this.blobs.getText(row.content_ref) : "";
  }

  private loadPriorCandidates(sessionId: string, conversationSnapshotId: string): ContextCandidate[] {
    // R0：会话快照记录前序正文；后续 run 将前序 user 消息作为候选
    if (!conversationSnapshotId) return [];
    let snapshot: { parts?: string[] };
    try {
      snapshot = this.blobs.getJson<{ parts?: string[] }>(conversationSnapshotId);
    } catch {
      return [];
    }
    const parts = snapshot.parts ?? [];
    // 全部历史正文（含当前输入）；当前输入由运行时单独加入，这里取前 n-1 条
    return parts.slice(0, -1).map((text, i) => ({
      id: `prior:${i}`,
      role: "user" as const,
      content: text,
    }));
  }

  private resolveRevisionAssets(
    revisionId: string,
    lessonId: string,
  ): { bundlePath?: string; systemPrompt: string } {
    const row = this.dbPrepare("SELECT * FROM agent_revisions WHERE id = ?").get(revisionId) as
      | Record<string, unknown>
      | undefined;
    let systemPrompt = this.lessons.systemPrompt(lessonId);
    let bundlePath: string | undefined;
    if (row) {
      bundlePath = (row.bundle_path as string) || undefined;
      const manifestId = row.source_manifest_id as string;
      if (manifestId) {
        const manifest = this.sourceManifests.get(manifestId);
        const promptFile = manifest?.files.find((f) => f.path.endsWith("system.md"));
        if (promptFile) systemPrompt = this.blobs.getText(promptFile.blobId);
      }
    }
    return { bundlePath, systemPrompt };
  }

  private loadModelSnapshot(snapshotId: string): ModelProfileSnapshot {
    const row = this.dbPrepare(
      "SELECT snapshot FROM model_profile_snapshots WHERE id = ?",
    ).get(snapshotId) as { snapshot: string } | undefined;
    if (!row) throw new Error(`MODEL_SNAPSHOT_NOT_FOUND: ${snapshotId}（未配置模型时不能发起实时运行）`);
    return JSON.parse(row.snapshot) as ModelProfileSnapshot;
  }

  private buildRunSpec(runId: string, run: Record<string, unknown>, budget: BudgetLimit): RunSpec {
    void budget;
    return {
      id: runId,
      mode: "live",
      experimentVersion: String(run.experiment_version),
      runtimeSnapshotId: String(run.runtime_snapshot_id),
      modelProfileSnapshotId: String(run.model_profile_snapshot_id),
      sourceManifestId: String(run.source_manifest_id ?? ""),
      agentRevisionId: String(run.agent_revision_id),
      sessionId: String(run.session_id),
      inputSubmissionId: String(run.input_submission_id ?? ""),
      conversationSnapshotId: String(run.conversation_snapshot_id ?? ""),
      assetSnapshotId: String(run.asset_snapshot_id),
      policySnapshotId: String(run.policy_snapshot_id),
      input: {
        id: String(run.input_ref),
        sha256: sha256(String(run.input_preview)),
        mediaType: "text/plain",
        bytes: String(run.input_preview).length,
      },
      budget: JSON.parse(String(run.budget)) as BudgetLimit,
    };
  }

  private createEffectLedger(): EffectLedger {
    const db = this.opts.db;
    const events = this.events;
    return {
      prepare(intent) {
        const id = newId("fx");
        db.prepare(
          `INSERT INTO effect_intents (id, run_id, idempotency_key, tool_revision, args_digest, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?)`,
        ).run(id, intent.runId, intent.idempotencyKey, intent.toolRevision, intent.argsDigest, nowIso(), nowIso());
        events.transact(() => {
          events.append(intent.runId, [
            { type: "effect.prepared", summary: { toolRevision: intent.toolRevision, intentId: id } },
          ]);
        });
        return id;
      },
      dispatch(intentId) {
        const row = db.prepare("SELECT run_id FROM effect_intents WHERE id = ?").get(intentId) as
          | { run_id: string }
          | undefined;
        db.prepare("UPDATE effect_intents SET state = 'dispatched', updated_at = ? WHERE id = ?").run(nowIso(), intentId);
        if (row) {
          events.transact(() => {
            events.append(row.run_id, [{ type: "effect.dispatched", summary: { intentId } }]);
          });
        }
      },
      mark(intentId, state, reasonCode, detail) {
        const row = db.prepare("SELECT run_id FROM effect_intents WHERE id = ?").get(intentId) as
          | { run_id: string }
          | undefined;
        db.prepare("UPDATE effect_intents SET state = ?, updated_at = ? WHERE id = ?").run(state, nowIso(), intentId);
        if (row) {
          events.transact(() => {
            events.append(row.run_id, [
              {
                type: state === "succeeded" ? "effect.succeeded" : "effect.failed",
                summary: { intentId, reasonCode: reasonCode ?? null, detail: detail ?? null },
              },
            ]);
          });
        }
      },
      markUnknown(intentId, reason) {
        const row = db.prepare("SELECT run_id FROM effect_intents WHERE id = ?").get(intentId) as
          | { run_id: string }
          | undefined;
        db.prepare("UPDATE effect_intents SET state = 'unknown', updated_at = ? WHERE id = ?").run(nowIso(), intentId);
        if (row) {
          events.transact(() => {
            events.append(row.run_id, [{ type: "effect.unknown", summary: { intentId, reason } }]);
          });
        }
      },
    };
  }

  wikiSvc(): WikiService {
    return new WikiService(this.opts.db, this.ingestion);
  }

  manifests(): SourceManifestBuilder {
    return this.sourceManifests;
  }

  /** 为课程基线构建（或复用）课程作者身份的不可变 revision */
  async ensureCourseRevision(lessonId: string): Promise<string> {
    const manifest = this.lessons.manifest(lessonId);
    const lessonVersion = `${lessonId}@${manifest.revision}`;
    const existing = this.dbPrepare(
      "SELECT id FROM agent_revisions WHERE author_kind = 'course' AND lesson_version = ?",
    ).get(lessonVersion) as { id: string } | undefined;
    if (existing) return existing.id;

    // 课程基线：审核过的可信基线，仍走同一构建管线（esbuild 冻结构建）
    const policy = this.lessons.editPolicy(lessonId);
    const baselineFiles = this.lessons.baselineFiles(lessonId);
    const revisionId = `rev_course_${lessonId.toLowerCase()}${manifest.revision.replace(/\./g, "")}`;
    const revDir = join(this.opts.dataDir, "revisions", revisionId);
    mkdirSync(revDir, { recursive: true });
    const entryLines = ["const out = {};"];
    const slots = manifest.runtime.extension_slots ?? {};
    // 按扩展槽名导出：宿主通过槽名调用（loop_continue → shouldContinue）
    for (const [slot, ref] of Object.entries(slots)) {
      const hashIndex = ref.indexOf("#");
      const path = hashIndex >= 0 ? ref.slice(0, hashIndex) : ref;
      const symbol = hashIndex >= 0 ? ref.slice(hashIndex + 1) : slot;
      entryLines.push(`{ const m = require(${JSON.stringify(`./${path}`)});`);
      entryLines.push(`  out[${JSON.stringify(slot)}] = m[${JSON.stringify(symbol)}];`);
      entryLines.push(`  for (const k of Object.keys(m)) { if (!(k in out)) out[k] = m[k]; } }`);
    }
    for (const path of Object.keys(baselineFiles)) {
      if (path.endsWith(".ts") && !Object.values(slots).some((r) => r.startsWith(path))) {
        entryLines.push(`{ const m = require(${JSON.stringify(`./${path}`)}); for (const k of Object.keys(m)) { if (!(k in out)) out[k] = m[k]; } }`);
      }
    }
    entryLines.push("module.exports = out;");
    const result = await build({
      stdin: { contents: entryLines.join("\n"), resolveDir: "/", sourcefile: "entry.ts", loader: "ts" },
      bundle: true,
      write: false,
      format: "cjs",
      platform: "node",
      target: "node18",
      logLevel: "silent",
      plugins: [
        {
          name: "lesson-baseline",
          setup(b) {
            b.onResolve({ filter: /^\.\// }, (args) => ({ path: args.path, namespace: "baseline" }));
            b.onLoad({ filter: /.*/, namespace: "baseline" }, (args) => ({
              contents: baselineFiles[args.path.replace(/^\.\//, "")] ?? "",
              loader: "ts",
              resolveDir: "/",
            }));
          },
        },
      ],
    });
    if (result.errors.length > 0) throw new Error(`COURSE_BASELINE_BUILD_FAILED: ` + result.errors.map(e => e.text).join("; "));
    const code = result.outputFiles?.[0]?.text ?? "module.exports = {};";
    const bundlePath = join(revDir, "bundle.cjs");
    writeFileSync(bundlePath, code, "utf8");
    // 冻结文件清单（含 prompt 等非代码区域）
    const files = Object.entries(baselineFiles).map(([path, content]) => ({
      path,
      content,
      regions: [],
    }));
    const manifestRow = this.sourceManifests.build({
      repositoryOrigin: "agentglass-lessons",
      files,
      buildDigest: sha256Text(code),
      agentRevisionId: revisionId,
      dirtyPatchDigest: "clean",
    });
    try {
    this.dbPrepare(
      `INSERT INTO agent_revisions (id, owner_id, project_id, lesson_id, lesson_version,
        base_agent_revision_id, source_manifest_id, source_digest, bundle_ref, bundle_path,
        edit_policy_digest, toolchain_digest, test_suite_digest, validation_report_id,
        author_kind, author_actor_id, state_schema_version, created_at)
       VALUES (?, 'system', 'local-project', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'course-baseline', 'system', 'lesson-state-v1', ?)`,
    ).run(
      revisionId,
      lessonId,
      lessonVersion,
      manifestRow.id,
      sha256(JSON.stringify(baselineFiles)),
      this.blobs.putText(code, "text/javascript").id,
      bundlePath,
      policy?.digest ?? "none",
      "baseline",
      "suite-baseline",
      "course-baseline",
      nowIso(),
    );
    } catch {
      // 并发构建同一课程基线：另一进程已登记，复用既有行（幂等）
      const existingRow = this.dbPrepare(
        "SELECT id FROM agent_revisions WHERE author_kind = 'course' AND lesson_version = ?",
      ).get(lessonVersion) as { id: string } | undefined;
      if (existingRow) return existingRow.id;
    }
    return revisionId;
  }
}

// ---- 工具注册（worker 侧） ----
import { READ_TEXT_TOOL, CALCULATOR_TOOL } from "@agentglass/tools";
import type { ToolRevision } from "@agentglass/contracts";

const READ_TEXT_REVISION: ToolRevision = READ_TEXT_TOOL.revision;
const CALCULATOR_REVISION: ToolRevision = CALCULATOR_TOOL.revision;
const READ_TEXT_HANDLER = READ_TEXT_TOOL;
const CALCULATOR_HANDLER = CALCULATOR_TOOL;

const GENERIC_TOOL_HANDLERS: ToolHandler[] = [READ_TEXT_HANDLER, CALCULATOR_HANDLER];

const HTTP_FETCH_TOOL = httpFetchTool({
  // 课程数据集域名白名单（默认全拒绝）；L27 课内允许 example.com 做演示
  allowedHosts: ["example.com", "www.example.com"],
  maxBytes: 64 * 1024,
});
const HTTP_FETCH_REVISION = HTTP_FETCH_TOOL.revision;

const SKILL_REV_QUERY = skillToolHandlers({
  registry: null as never,
  allowedSlugs: [],
}).map((h) => h.revision);

/** 知识工具声明（模型 schema 用）；revision 由 knowledgeToolHandlers 生成 */
const KNOWLEDGE_REV_QUERY = knowledgeToolHandlers({
  indexService: null as never,
  retrieval: null as never,
  wiki: null as never,
  memory: null as never,
  datasetIdsFor: () => [],
  memoryScope: { kind: "user", id: "local-learner" },
}).map((h) => h.revision);
const SEARCH_REVISION = KNOWLEDGE_REV_QUERY[0]!;
const WIKI_READ_REVISION = KNOWLEDGE_REV_QUERY[1]!;
const REMEMBER_REVISION = KNOWLEDGE_REV_QUERY[2]!;
const RECALL_REVISION = KNOWLEDGE_REV_QUERY[3]!;

const FAKE_SNAPSHOT: ModelProfileSnapshot = {
  id: "snap-fake-fallback",
  provider: "fake",
  protocol: "fake/v1",
  endpointId: "fake",
  modelId: "fake-deterministic",
  parameters: {},
  capabilities: {
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
  },
};

export function newAttemptId(): string {
  return `att_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export { DEFAULT_BUDGET, STATE_SCHEMA_VERSION };
