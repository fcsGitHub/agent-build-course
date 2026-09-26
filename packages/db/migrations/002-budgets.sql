-- 预算账本：共享原子预算（并发子任务从同一行扣减，禁止各自拿到完整额度）。
CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  limits TEXT NOT NULL,
  reserved_turns INTEGER NOT NULL DEFAULT 0,
  used_turns INTEGER NOT NULL DEFAULT 0,
  reserved_model_calls INTEGER NOT NULL DEFAULT 0,
  used_model_calls INTEGER NOT NULL DEFAULT 0,
  reserved_tool_calls INTEGER NOT NULL DEFAULT 0,
  used_tool_calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  wall_deadline_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id)
);

CREATE TABLE IF NOT EXISTS budget_reservations (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  granted INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
