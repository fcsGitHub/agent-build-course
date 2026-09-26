/**
 * 知识工具（R1：T15/T16/T17 的工具面）。
 * search_documents：经过 IndexService 的受控检索（命中含块 ID，供引用校验）；
 * read_wiki_page：只读已发布 Wiki；
 * remember / recall：作用域受限于当前 run 的用户（记忆写入不做身份提升）。
 * 工具权限仍由 ToolBroker 白名单 + 课程 manifest 决定。
 */
import type { JsonValue, ToolExecutionContext, ToolExecutionResult, ToolHandler } from "@agentglass/contracts";
import type { IndexService, RetrievalService, WikiService, MemoryService } from "@agentglass/knowledge";

export interface KnowledgeToolDeps {
  indexService: IndexService;
  retrieval: RetrievalService;
  wiki: WikiService;
  memory: MemoryService;
  /** 本 run 允许检索的数据集 ID（课程白名单） */
  datasetIdsFor: (ctx: ToolExecutionContext) => string[];
  /** 记忆作用域（本地模式：user/local-learner） */
  memoryScope: { kind: "user" | "project" | "session"; id: string };
}

export function knowledgeToolHandlers(deps: KnowledgeToolDeps): ToolHandler[] {
  const searchDocuments: ToolHandler = {
    revision: {
      toolId: "search_documents",
      revision: "1.0.0",
      title: "检索课程资料",
      description: "在课程数据集上做关键词+向量融合检索，返回最相关的资料块（含块 ID，可用于引用标注【c:块ID】）。",
      riskLevel: "readonly_pure",
      parametersSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索查询" },
          top_k: { type: "integer", description: "返回条数（默认 3）" },
        },
        required: ["query"],
      },
      idempotent: true,
      supportsStatusQuery: false,
    },
    async execute(args, ctx): Promise<ToolExecutionResult> {
      const a = args as { query?: unknown; top_k?: unknown };
      if (typeof a.query !== "string" || a.query.trim().length === 0) {
        return { status: "failed", reasonCode: "INVALID_ARGUMENTS", errorMessage: "query 必填" };
      }
      const datasetIds = deps.datasetIdsFor(ctx);
      if (datasetIds.length === 0) {
        return { status: "failed", reasonCode: "NO_DATASET", errorMessage: "当前运行未装配课程资料索引" };
      }
      const topK = Math.min(typeof a.top_k === "number" ? a.top_k : 3, 8);
      const allHits = [];
      for (const datasetId of datasetIds) {
        const snap = deps.indexService.latest(datasetId);
        if (!snap) continue;
        const r = deps.retrieval.query(snap, a.query, { topK });
        allHits.push(...r.hits.map((h) => ({ ...h, datasetId })));
      }
      allHits.sort((x, y) => y.score - x.score);
      const hits = allHits.slice(0, topK);
      const summary: JsonValue = {
        query: a.query,
        hits: hits.map((h) => ({
          chunk_id: h.chunkId,
          dataset: h.datasetId,
          heading: h.heading,
          snippet: h.snippet.slice(0, 300),
          score: Number(h.score.toFixed(4)),
          cite: `【c:${h.chunkId}】`,
        })),
        hit_count: hits.length,
      };
      return { status: "succeeded", outputSummary: summary };
    },
  };

  const readWikiPage: ToolHandler = {
    revision: {
      toolId: "read_wiki_page",
      revision: "1.0.0",
      title: "读取 Wiki 页面",
      description: "读取已发布的 Wiki 页面正文（只读；草稿与冲突状态不返回）。",
      riskLevel: "readonly_pure",
      parametersSchema: {
        type: "object",
        properties: { slug: { type: "string" } },
        required: ["slug"],
      },
      idempotent: true,
      supportsStatusQuery: false,
    },
    async execute(args): Promise<ToolExecutionResult> {
      const a = args as { slug?: unknown };
      if (typeof a.slug !== "string") {
        return { status: "failed", reasonCode: "INVALID_ARGUMENTS", errorMessage: "slug 必填" };
      }
      const page = deps.wiki.getPage(a.slug);
      if (!page) {
        return { status: "failed", reasonCode: "PAGE_NOT_FOUND", errorMessage: `页面不存在: ${a.slug}` };
      }
      if (page.status !== "published" || !page.currentRevisionId) {
        return {
          status: "failed",
          reasonCode: "PAGE_NOT_PUBLISHED",
          errorMessage: `页面状态为 ${page.status}；只有已发布页面可读`,
        };
      }
      const rev = deps.wiki.getRevision(page.currentRevisionId)!;
      const summary: JsonValue = {
        slug: page.slug,
        title: page.title,
        revision: rev.revisionNo,
        body: rev.body.slice(0, 1500),
        claims: rev.claims as unknown as import("@agentglass/contracts").JsonValue,
      };
      return { status: "succeeded", outputSummary: summary };
    },
  };

  const remember: ToolHandler = {
    revision: {
      toolId: "remember",
      revision: "1.0.0",
      title: "写入长期记忆",
      description: "把用户明确表达的偏好或事实写入当前用户的长期记忆（不允许写入他人作用域）。",
      riskLevel: "workspace_write",
      parametersSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "要记住的内容" },
          kind: { type: "string", enum: ["episodic", "semantic", "procedural"] },
        },
        required: ["content"],
      },
      idempotent: true,
      supportsStatusQuery: false,
    },
    async execute(args): Promise<ToolExecutionResult> {
      const a = args as { content?: unknown; kind?: unknown };
      if (typeof a.content !== "string" || a.content.trim().length === 0) {
        return { status: "failed", reasonCode: "INVALID_ARGUMENTS", errorMessage: "content 必填" };
      }
      const kind =
        a.kind === "episodic" || a.kind === "procedural" ? a.kind : ("semantic" as const);
      const { entry, duplicate } = deps.memory.write({
        scopeKind: deps.memoryScope.kind,
        scopeId: deps.memoryScope.id,
        kind,
        content: a.content,
      });
      const summary: JsonValue = {
        memory_id: entry.id,
        version: entry.version,
        scope: `${deps.memoryScope.kind}:${deps.memoryScope.id}`,
        duplicate,
        note: "写入的是待确认记忆；作用域限定当前用户，他人不可见",
      };
      return { status: "succeeded", outputSummary: summary };
    },
  };

  const recall: ToolHandler = {
    revision: {
      toolId: "recall",
      revision: "1.0.0",
      title: "检索长期记忆",
      description: "按查询检索当前用户的长期记忆（遗忘的记忆不会返回）。",
      riskLevel: "readonly_pure",
      parametersSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      idempotent: true,
      supportsStatusQuery: false,
    },
    async execute(args): Promise<ToolExecutionResult> {
      const a = args as { query?: unknown };
      if (typeof a.query !== "string") {
        return { status: "failed", reasonCode: "INVALID_ARGUMENTS", errorMessage: "query 必填" };
      }
      const hits = deps.memory.recall(deps.memoryScope.kind, deps.memoryScope.id, a.query);
      const summary: JsonValue = {
        hits: hits.map((h) => ({ memory_id: h.entry.id, content: h.entry.content, score: Number(h.score.toFixed(3)) })),
        hit_count: hits.length,
      };
      return { status: "succeeded", outputSummary: summary };
    },
  };

  return [searchDocuments, readWikiPage, remember, recall];
}
