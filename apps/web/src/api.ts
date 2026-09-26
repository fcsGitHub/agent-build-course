/** API 客户端：所有前端数据经公共合同访问；本地模式单用户身份由服务端持有。 */

export interface LessonCatalogEntry {
  id: string;
  title: string;
  stage: string;
  summary: string;
  revision: string;
  prerequisites: string[];
}

export interface CaseHint {
  id: string;
  text: string;
  requires?: string[];
  observe?: string[];
}

export interface TraceEvent {
  eventId: string;
  runId: string;
  seq: number;
  type: string;
  summary: Record<string, unknown>;
  payloadRef?: { id: string; sha256: string; mediaType: string; bytes: number };
  emittedAt: string;
  conceptIds: string[];
  source?: { manifestId: string; fileId: string; symbol: string; regionId: string; startLine: number; endLine: number };
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body != null ? { "content-type": "application/json" } : undefined,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { code?: string; message?: string };
  if (!res.ok) {
    throw new Error(data.message ?? `${res.status}`);
  }
  return data;
}

export const api = {
  catalog: () => request<{ lessons: LessonCatalogEntry[] }>("GET", "/api/v1/courses"),
  lesson: (id: string, rev: string) =>
    request<{ manifest: LessonManifestDto; lessonMarkdown: string; systemPrompt: string; assets: Array<{ key: string; name: string; bytes: number }> }>(
      "GET", `/api/v1/lessons/${id}/revisions/${rev}`,
    ),
  caseHints: (id: string, rev: string) =>
    request<{ hints: CaseHint[] }>("GET", `/api/v1/lessons/${id}/revisions/${rev}/case-hints`),
  editPolicy: (id: string, rev: string) =>
    request<{ policy: unknown }>("GET", `/api/v1/lessons/${id}/revisions/${rev}/edit-policy`),

  createSession: (lessonId: string, modelProfileId?: string) =>
    request<{ sessionId: string; agentRevisionId: string; budget: Record<string, number> }>(
      "POST", "/api/v1/sessions", { lessonId, modelProfileId },
    ),
  session: (id: string) => request<{ session: SessionDto; inputs: InputDto[] }>("GET", `/api/v1/sessions/${id}`),
  submitInput: (sessionId: string, text: string, clientMessageId: string, caseHintId?: string, agentRevisionId?: string, breakpoints?: string[]) =>
    request<{ submission: InputDto; duplicate: boolean }>(
      "POST", `/api/v1/sessions/${sessionId}/inputs`,
      { text, clientMessageId, caseHintId, agentRevisionId, breakpoints },
    ),
  cancelInput: (id: string) => request<{ cancelled: boolean }>("POST", `/api/v1/inputs/${id}/cancel`),
  adoptRevision: (sessionId: string, agentRevisionId: string) =>
    request<{ adopted: string }>("POST", `/api/v1/sessions/${sessionId}/adopt-revision`, { agentRevisionId }),

  run: (id: string) =>
    request<{
      run: { id: string; mode: string; state: string; stopReason: string | null; lessonId: string; lessonRevision: string; inputPreview: string; budget: Record<string, number>; agentRevisionId: string };
      model: { provider: string; modelId: string; simulated: boolean } | null;
    }>("GET", `/api/v1/runs/${id}`),
  runEvents: (id: string, afterSeq: number) =>
    request<{ events: TraceEvent[]; nextCursor: number }>("GET", `/api/v1/runs/${id}/events?afterSeq=${afterSeq}`),
  runCommand: (id: string, command: "pause" | "cancel" | "resume") =>
    request<{ accepted: string }>("POST", `/api/v1/runs/${id}/commands`, { command }),
  runBreakpoints: (id: string) =>
    request<{ targets: string[] }>("GET", `/api/v1/runs/${id}/breakpoints`),
  setRunBreakpoints: (id: string, targets: string[]) =>
    request<{ targets: string[] }>("PUT", `/api/v1/runs/${id}/breakpoints`, { targets }),
  runOutputs: (id: string) => request<{ finalText: string }>("GET", `/api/v1/runs/${id}/outputs`),
  runContext: (id: string, callId: string) =>
    request<{
      callId: string;
      items: { messages: ContextMessageDto[]; tools?: unknown[] };
      itemDecisions: ItemDecisionDto[] | null;
      estimatedInputTokens: number | null;
    }>("GET", `/api/v1/runs/${id}/contexts/${callId}`),
  artifact: async (id: string): Promise<string> => {
    const res = await fetch(`/api/v1/artifacts/${id}`);
    return res.text();
  },
  sourceManifest: (id: string) =>
    request<{ manifest: { id: string; files: Array<{ id: string; path: string; regions: Array<{ id: string; symbol: string; startLine: number; endLine: number }> }>; contentDigest: string } & { files: Array<{ content: string }> } }>(
      "GET", `/api/v1/source-manifests/${id}`,
    ),
  history: () => request<{ runs: RunRow[] }>("GET", "/api/v1/history"),
  compare: (ids: string[]) => request<{ runs: CompareRow[] }>("GET", `/api/v1/compare?runIds=${ids.join(",")}`),
  exportRun: (id: string) => `/api/v1/runs/${id}/export`,

  profiles: () => request<{ profiles: Array<{ id: string; name: string; provider: string; endpoint: string; modelId: string; probed: boolean; secretRef: string | null; secretMasked: string | null }> }>("GET", "/api/v1/model-profiles"),
  createProfile: (body: { name: string; provider: string; endpoint: string; modelId: string; secretRef?: string }) =>
    request<{ id: string }>("POST", "/api/v1/model-profiles", body),
  probeProfile: (id: string) =>
    request<{ ok: boolean; steps: Array<{ step: string; passed: boolean; detail: string }> }>("POST", `/api/v1/model-profiles/${id}/probe`),

  pendingApprovals: () =>
    request<{ approvals: Array<{ id: string; runId: string; toolRevision: string; argsSummary: string; target: string; state: string; expiresAt: string }> }>(
      "GET", "/api/v1/approvals/pending",
    ),
  decideApproval: (id: string, decision: "grant" | "reject") =>
    request<{ approval: { id: string; state: string } }>(
      "POST", `/api/v1/approvals/${id}/decision`, { decision },
    ),

  createDraft: (lessonId: string) =>
    request<{ draft: DraftDto }>("POST", "/api/v1/agent-drafts", { lessonId }),
  draft: (id: string) => request<{ draft: DraftDto }>("GET", `/api/v1/agent-drafts/${id}`),
  saveDraft: (id: string, expectedRevision: number, files: Record<string, string>) =>
    request<{ draft: DraftDto }>("PATCH", `/api/v1/agent-drafts/${id}`, { expectedRevision, files }),
  validateDraft: (id: string) =>
    request<{ status: string; report: { safetyGates: Record<string, string>; diagnosticsRef?: { id: string } }; revisionId?: string }>(
      "POST", `/api/v1/agent-drafts/${id}/validate`,
    ),
};

export interface ContextMessageDto {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}
export interface ItemDecisionDto {
  id: string;
  kind: string;
  trust: string;
  priority: number;
  atomicGroupId: string | null;
  estimatedTokens: number;
  selected: boolean;
  decision: string;
  decisionReason: string | null;
}
export interface GraphDefinitionDto {
  id: string;
  revision: string;
  entryNodeId: string;
  exitNodeIds?: string[];
  maxNodeVisits?: number;
  maxTotalExecutions?: number;
  nodes: Array<{ id: string; kind: string; handlerId?: string }>;
  edges: Array<{ from: string; to: string; predicateId?: string }>;
}

export interface LessonManifestDto {
  id: string;
  revision: string;
  title: string;
  stage: string;
  summary: string;
  prerequisites: string[];
  runtime: {
    profile: string;
    adapter: string;
    extension_slots?: Record<string, string>;
    chain_steps?: Array<{ instruction: string; allow_tools: boolean }>;
    multi_agent?: {
      topology: "parallel" | "handoff" | "blackboard";
      workers: Array<{ id: string; goal: string; tools: string[] }>;
      handoff_chain?: string[];
    };
    recursion?: { max_depth: number; partition_chars?: number; question: string };
    rsi?: { max_generations: number; frozen_tasks: string };
    mcp_servers?: string[];
    a2a_agents?: string[];
    compaction?: string;
    reflection_on_failure?: boolean;
    graph?: GraphDefinitionDto | null;
  };
  requires?: { model?: string[]; tools?: string[]; sandbox?: string };
  editing?: { policy: string };
  limits: Record<string, number>;
}
export interface SessionDto {
  id: string;
  lesson_id: string;
  lesson_revision: string;
  agent_revision_id: string;
  model_profile_snapshot_id: string;
}
export interface InputDto {
  id: string;
  status: "queued" | "accepted" | "cancelled" | "replaced";
  contentPreview: string;
  origin: string;
  acceptedRunId: string | null;
  submittedAt: string;
  caseHintId: string | null;
}
export interface RunRow {
  id: string;
  lesson_id: string;
  lesson_revision: string;
  state: string;
  stop_reason: string | null;
  mode: string;
  input_preview: string;
  agent_revision_id: string;
  created_at: string;
}
export interface CompareRow {
  runId: string;
  state: string;
  stopReason: string | null;
  toolCalls: number;
  modelCalls: number;
  usage: { input: number; output: number };
  finalText: string;
  inputPreview: string;
}
export interface DraftDto {
  id: string;
  lessonId: string;
  revision: number;
  files: Record<string, string>;
  baseAgentRevisionId: string;
}
