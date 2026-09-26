-- AgentGlass R0 数据库初始化（SQLite 方言；本地实验版）。
-- 设计文档 v1.1 第 19 节数据域的 R0 子集：身份/配置/会话输入/运行/事件/模型/工具/源码/代码实验/工件/检查点/审批。
-- 关键约束：trace_events (run_id, seq) 与 event_id 唯一；input_submissions (session_id, client_message_id) 唯一。

CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  media_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  storage TEXT NOT NULL DEFAULT 'file',
  path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blobs_sha ON blobs(sha256);

CREATE TABLE IF NOT EXISTS trace_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  causation_event_ids TEXT NOT NULL DEFAULT '[]',
  emitted_at TEXT NOT NULL,
  monotonic_offset_ms INTEGER,
  concept_ids TEXT NOT NULL DEFAULT '[]',
  source_manifest_id TEXT,
  source_file_id TEXT,
  source_symbol TEXT,
  source_region_id TEXT,
  source_start_line INTEGER,
  source_end_line INTEGER,
  data_class TEXT NOT NULL DEFAULT 'public',
  summary TEXT NOT NULL,
  payload_ref TEXT,
  UNIQUE (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_run ON trace_events(run_id, seq);

CREATE TABLE IF NOT EXISTS event_outbox (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_unpublished ON event_outbox(published, created_at);

CREATE TABLE IF NOT EXISTS model_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  protocol TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  model_id TEXT NOT NULL,
  secret_ref TEXT,
  parameters TEXT NOT NULL DEFAULT '{}',
  capabilities TEXT NOT NULL,
  price_table_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS model_profile_snapshots (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  lesson_revision TEXT NOT NULL,
  agent_revision_id TEXT NOT NULL,
  model_profile_snapshot_id TEXT NOT NULL,
  runtime_snapshot_id TEXT NOT NULL,
  asset_snapshot_id TEXT NOT NULL,
  policy_snapshot_id TEXT NOT NULL,
  budget TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS input_submissions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  origin TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  user_confirmed_at TEXT,
  case_hint_id TEXT,
  case_hint_revision TEXT,
  content_sha256 TEXT NOT NULL,
  content_ref TEXT NOT NULL,
  attachment_refs TEXT NOT NULL DEFAULT '[]',
  lesson_version TEXT NOT NULL,
  agent_revision_id TEXT NOT NULL,
  runtime_snapshot_id TEXT NOT NULL,
  model_profile_snapshot_id TEXT NOT NULL,
  asset_snapshot_id TEXT NOT NULL,
  policy_snapshot_id TEXT NOT NULL,
  budget TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  replaces_submission_id TEXT,
  accepted_run_id TEXT,
  content_preview TEXT NOT NULL DEFAULT '',
  UNIQUE (session_id, client_message_id)
);
CREATE INDEX IF NOT EXISTS idx_inputs_session ON input_submissions(session_id, submitted_at);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'created',
  experiment_version TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  lesson_revision TEXT NOT NULL,
  runtime_snapshot_id TEXT NOT NULL,
  model_profile_snapshot_id TEXT NOT NULL,
  source_manifest_id TEXT,
  agent_revision_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  input_submission_id TEXT,
  conversation_snapshot_id TEXT,
  asset_snapshot_id TEXT NOT NULL,
  policy_snapshot_id TEXT NOT NULL,
  input_ref TEXT NOT NULL,
  input_preview TEXT NOT NULL DEFAULT '',
  budget TEXT NOT NULL,
  lineage TEXT,
  stop_reason TEXT,
  error_code TEXT,
  output_refs TEXT NOT NULL DEFAULT '[]',
  attempt_id TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  worker_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_queue ON runs(state, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, created_at);

CREATE TABLE IF NOT EXISTS run_commands (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  command TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT,
  actor_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  at_seq INTEGER NOT NULL,
  boundary TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  agent_revision_id TEXT NOT NULL,
  source_manifest_id TEXT,
  state_schema_version TEXT NOT NULL,
  state_ref TEXT NOT NULL,
  workspace_snapshot_id TEXT,
  asset_snapshot_id TEXT NOT NULL,
  pending_effect_ids TEXT NOT NULL DEFAULT '[]',
  resumable INTEGER NOT NULL DEFAULT 1,
  incompatible_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_run ON checkpoints(run_id, at_seq);

CREATE TABLE IF NOT EXISTS source_manifests (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1,
  repository_origin TEXT NOT NULL,
  git_commit TEXT,
  dirty_patch_digest TEXT NOT NULL,
  build_digest TEXT NOT NULL,
  agent_revision_id TEXT,
  base_manifest_id TEXT,
  edit_policy_digest TEXT,
  validation_report_id TEXT,
  lockfile_digest TEXT,
  files TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_files (
  id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  regions TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_source_files_manifest ON source_files(manifest_id, path);

CREATE TABLE IF NOT EXISTS agent_drafts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  lesson_version TEXT NOT NULL,
  base_agent_revision_id TEXT NOT NULL,
  edit_policy_digest TEXT NOT NULL,
  revision INTEGER NOT NULL,
  source_digest TEXT NOT NULL,
  files TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_owner ON agent_drafts(owner_id, lesson_id);

CREATE TABLE IF NOT EXISTS code_builds (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  draft_revision INTEGER NOT NULL,
  source_digest TEXT NOT NULL,
  base_manifest_id TEXT NOT NULL,
  edit_policy_digest TEXT NOT NULL,
  toolchain_digest TEXT NOT NULL,
  test_suite_digest TEXT NOT NULL,
  bundle_ref TEXT,
  bundle_digest TEXT,
  safety_gates TEXT NOT NULL,
  learning_checks TEXT NOT NULL DEFAULT '[]',
  diagnostics TEXT NOT NULL DEFAULT '{}',
  preview_allowed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_revisions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  lesson_version TEXT NOT NULL,
  base_agent_revision_id TEXT,
  source_manifest_id TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  bundle_ref TEXT NOT NULL,
  bundle_path TEXT NOT NULL,
  edit_policy_digest TEXT NOT NULL,
  toolchain_digest TEXT NOT NULL,
  test_suite_digest TEXT NOT NULL,
  validation_report_id TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  author_actor_id TEXT NOT NULL,
  state_schema_version TEXT NOT NULL DEFAULT 'lesson-state-v1',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  tool_revision TEXT NOT NULL,
  args_digest TEXT NOT NULL,
  args_summary TEXT NOT NULL,
  policy_revision TEXT NOT NULL,
  target TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS effect_intents (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  tool_revision TEXT NOT NULL,
  args_digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'prepared',
  result_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lesson_progress (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  lesson_revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress',
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, lesson_id)
);

CREATE TABLE IF NOT EXISTS config_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
