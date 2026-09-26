-- R2：技能包（T18）与状态图（T19）。
CREATE TABLE IF NOT EXISTS skill_packages (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  version TEXT NOT NULL,
  body_ref TEXT NOT NULL,
  scripts TEXT NOT NULL DEFAULT '[]',
  required_capabilities TEXT NOT NULL DEFAULT '[]',
  allowed_tools TEXT NOT NULL DEFAULT '[]',
  source_path TEXT,
  installed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_definitions (
  id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  definition TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (id, revision)
);
