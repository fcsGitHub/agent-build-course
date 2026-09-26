-- R1 知识层（T14—T18）：数据集/文档版本/切块/索引快照/向量、Wiki、记忆。
CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  license TEXT NOT NULL DEFAULT 'course-internal',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS document_revisions (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  version TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  content_ref TEXT NOT NULL,
  published_at TEXT NOT NULL,
  superseded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_docrev_dataset ON document_revisions(dataset_id, path);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  doc_revision_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  heading TEXT,
  text_sha256 TEXT NOT NULL,
  text_ref TEXT NOT NULL,
  chunker_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_revision_id, seq);

CREATE TABLE IF NOT EXISTS index_snapshots (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  embedding_profile TEXT NOT NULL,
  embedding_version TEXT NOT NULL,
  chunker_version TEXT NOT NULL,
  vector_dim INTEGER NOT NULL,
  doc_revision_ids TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idxsnap_dataset ON index_snapshots(dataset_id, created_at);

CREATE TABLE IF NOT EXISTS chunk_vectors (
  index_snapshot_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY (index_snapshot_id, chunk_id)
);

CREATE TABLE IF NOT EXISTS wiki_pages (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  current_revision TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wiki_revisions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL,
  body TEXT NOT NULL,
  claims TEXT NOT NULL DEFAULT '[]',
  evidence_chunk_ids TEXT NOT NULL DEFAULT '[]',
  evidence_doc_revisions TEXT NOT NULL DEFAULT '[]',
  conflicts TEXT NOT NULL DEFAULT '[]',
  author TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  UNIQUE (page_id, revision_no)
);

CREATE TABLE IF NOT EXISTS wiki_links (
  from_page TEXT NOT NULL,
  to_page TEXT NOT NULL,
  PRIMARY KEY (from_page, to_page)
);

CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  previous_id TEXT,
  source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  forgotten_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_entries(scope_kind, scope_id, status);
