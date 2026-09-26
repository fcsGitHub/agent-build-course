/**
 * 备份与恢复（T35）：数据库与 blob **成对**备份、摘要清单、恢复前校验。
 * - 备份：WAL checkpoint（TRUNCATE）后复制 db 文件 + blobs/ + revisions/ + exports/；
 *   MANIFEST.json 记录每个文件的 sha256 与字节量，以及 runs/events 计数。
 * - 恢复：先全量校验摘要（任何不匹配 → DIGEST_MISMATCH，拒绝恢复），
 *   再复制到目标目录，并打开新库执行 PRAGMA integrity_check 与计数核对。
 * 依据设计文档 v1.1 §24 T35（验证数据库与 blob 成对恢复）。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { openDatabase, type Database } from "./database";

export const BACKUP_MANIFEST = "MANIFEST.json";

export interface BackupManifest {
  schemaVersion: 1;
  createdAt: string;
  sourceDir: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
  counts: { runs: number; events: number };
}

export interface BackupResult {
  backupDir: string;
  fileCount: number;
  totalBytes: number;
  manifest: BackupManifest;
}

function sha256File(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

/** 找到数据目录中的 SQLite 主文件（排除 -wal/-shm） */
function dbFileIn(dataDir: string): string | null {
  const direct = join(dataDir, "agentglass.db");
  if (existsSync(direct)) return direct;
  const found = readdirSync(dataDir).find((f) => f.endsWith(".db"));
  return found ? join(dataDir, found) : null;
}

/** 备份：db 与 blob 成对打包；返回清单供恢复校验 */
export function backupDataDir(input: { dataDir: string; db: Database; backupRoot: string; label?: string }): BackupResult {
  const { dataDir, db, backupRoot } = input;
  const dbPath = dbFileIn(dataDir);
  if (!dbPath) throw new Error(`BACKUP_DB_NOT_FOUND: ${dataDir} 下没有 .db 主文件`);
  // WAL checkpoint：把 -wal 收进主文件，保证拷贝一致
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(backupRoot, `${input.label ?? "backup"}_${stamp}`);
  mkdirSync(backupDir, { recursive: true });

  const files: BackupManifest["files"] = [];
  const sources = [dbPath, join(dataDir, "blobs"), join(dataDir, "revisions"), join(dataDir, "exports")];
  for (const src of sources) {
    if (!existsSync(src)) continue;
    const rel = relative(dataDir, src);
    const targets = statSync(src).isDirectory() ? listFiles(src) : [src];
    for (const f of targets) {
      const relFile = relative(dataDir, f);
      const dest = join(backupDir, relFile);
      mkdirSync(join(dest, ".."), { recursive: true });
      copyFileSync(f, dest);
      files.push({ path: relFile.split("\\").join("/"), sha256: sha256File(dest), bytes: statSync(dest).size });
    }
    void rel;
  }

  const counts = {
    runs: (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n,
    events: (db.prepare("SELECT COUNT(*) AS n FROM trace_events").get() as { n: number }).n,
  };
  const manifest: BackupManifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceDir: dataDir,
    files,
    counts,
  };
  writeFileSync(join(backupDir, BACKUP_MANIFEST), JSON.stringify(manifest, null, 2), "utf8");
  return {
    backupDir,
    fileCount: files.length,
    totalBytes: files.reduce((a, f) => a + f.bytes, 0),
    manifest,
  };
}

export interface RestoreResult {
  restoredFiles: number;
  integrity: string;
  counts: { runs: number; events: number };
}

/** 恢复：先校验全部摘要（不匹配即拒绝），再复制并打开新库核对 */
export function restoreDataDir(input: { backupDir: string; targetDir: string }): RestoreResult {
  const { backupDir, targetDir } = input;
  const manifest = JSON.parse(readFileSync(join(backupDir, BACKUP_MANIFEST), "utf8")) as BackupManifest;

  // 1) 全量摘要校验：数据库与 blob 缺一不可、被篡改即拒绝
  for (const f of manifest.files) {
    const p = join(backupDir, f.path);
    if (!existsSync(p)) throw new Error(`DIGEST_MISMATCH: 备份缺少文件 ${f.path}`);
    const digest = sha256File(p);
    if (digest !== f.sha256) {
      throw new Error(`DIGEST_MISMATCH: ${f.path} 摘要不匹配（备份损坏或被篡改）`);
    }
  }
  const hasDb = manifest.files.some((f) => /\.db$/.test(f.path));
  const hasBlobs = manifest.files.some((f) => f.path.startsWith("blobs/"));
  if (!hasDb || !hasBlobs) throw new Error("DIGEST_MISMATCH: 备份不完整（数据库与 blob 必须成对）");

  // 2) 复制到目标目录（已存在则先移除，避免半恢复状态）
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  for (const f of manifest.files) {
    const dest = join(targetDir, f.path);
    mkdirSync(join(dest, ".."), { recursive: true });
    copyFileSync(join(backupDir, f.path), dest);
  }

  // 3) 打开恢复后的库：完整性与计数核对
  const dbName = manifest.files.find((f) => /\.db$/.test(f.path))!.path.split("/").pop()!;
  const restored = openDatabase({ file: join(targetDir, dbName) });
  const integrity = (restored.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
  const counts = {
    runs: (restored.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n,
    events: (restored.prepare("SELECT COUNT(*) AS n FROM trace_events").get() as { n: number }).n,
  };
  restored.close();
  if (counts.runs !== manifest.counts.runs || counts.events !== manifest.counts.events) {
    // 计数不一致也拒绝（成对恢复的最终核对）
    throw new Error("RESTORE_COUNT_MISMATCH: runs/events 与清单不符");
  }
  return { restoredFiles: manifest.files.length, integrity, counts: { runs: counts.runs, events: counts.events } };
}

/** 便捷：以只读方式打开备份目录中的库做抽查（不触碰原目录） */
export function openBackupDatabase(backupDir: string): Database {
  const manifest = JSON.parse(readFileSync(join(backupDir, BACKUP_MANIFEST), "utf8")) as BackupManifest;
  const dbName = manifest.files.find((f) => /\.db$/.test(f.path))!.path.split("/").pop()!;
  return openDatabase({ file: join(backupDir, dbName) });
}

export { basename };
