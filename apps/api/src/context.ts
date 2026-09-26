/**
 * API 应用上下文：数据库、blob、事件、课程注册表与协调器（不启动轮询循环）。
 */
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Database } from "@agentglass/db";
import { openDatabase } from "@agentglass/db";
import { BlobStore, EventStore } from "@agentglass/events";
import { LessonRegistry } from "@agentglass/lessons";
import { RunCoordinator } from "@agentglass/worker";
import { EnvSecretStore } from "@agentglass/policy";

export interface AppContext {
  db: Database;
  blobs: BlobStore;
  events: EventStore;
  lessons: LessonRegistry;
  coordinator: RunCoordinator;
  dataDir: string;
  secrets: EnvSecretStore;
}

export function createContext(opts?: { dataDir?: string; lessonsDir?: string; dbFile?: string }): AppContext {
  // pnpm 脚本以包目录（apps/api）为 cwd，默认目录相对本文件上溯到仓库根（tsx 直跑 src 与 esbuild 打包 dist 两种布局均成立）；环境变量可覆盖。
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const dataDir = opts?.dataDir ?? process.env.AGENTGLASS_DATA ?? join(repoRoot, "data");
  const lessonsDir = opts?.lessonsDir ?? process.env.AGENTGLASS_LESSONS ?? join(repoRoot, "lessons");
  mkdirSync(join(dataDir, "blobs"), { recursive: true });
  mkdirSync(join(dataDir, "workspaces"), { recursive: true });
  mkdirSync(join(dataDir, "revisions"), { recursive: true });
  const db = openDatabase({ file: opts?.dbFile ?? join(dataDir, "agentglass.db") });
  const blobs = new BlobStore(db, join(dataDir, "blobs"));
  const events = new EventStore(db);
  const lessons = new LessonRegistry(lessonsDir);
  const coordinator = new RunCoordinator({ db, dataDir, lessons });
  return { db, blobs, events, lessons, coordinator, dataDir, secrets: new EnvSecretStore() };
}
