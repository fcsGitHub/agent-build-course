/**
 * 本地实验版数据库：node:sqlite（内嵌，零安装）。
 * 设计文档 v1.1 第 7.2 节基线为 PostgreSQL；本地单机模式以同一 schema 合同使用
 * SQLite，多人课堂版再切换 PG 适配器（见 docs/adr/0003-sqlite-local-mode.md）。
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

export interface DatabaseOptions {
  /** 数据库文件路径；":memory:" 用于测试 */
  file: string;
}

export type Database = DatabaseSync;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export function openDatabase(options: DatabaseOptions): Database {
  if (options.file !== ":memory:") {
    mkdirSync(dirname(options.file), { recursive: true });
  }
  const db = new DatabaseSync(options.file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);",
  );
  const applied = new Set(
    db
      .prepare("SELECT name FROM schema_migrations")
      .all()
      .map((r) => (r as { name: string }).name),
  );
  const files = ["001-init.sql", "002-budgets.sql", "003-knowledge.sql", "004-skills-graph.sql", "005-run-breakpoints.sql", "006-input-breakpoints.sql"];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
        file,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  const uuid = globalThis.crypto.randomUUID();
  return `${prefix}_${uuid.replace(/-/g, "").slice(0, 20)}`;
}
