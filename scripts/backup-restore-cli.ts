/**
 * T35 备份/恢复 CLI。
 * 用法：
 *   pnpm backup                          # 备份默认 data/ 到 backups/
 *   pnpm backup -- --data-dir X --out Y  # 指定数据目录与输出目录
 *   pnpm restore -- --from backups/t35_... [--to data]   # 摘要校验后成对恢复
 */
import { backupDataDir, restoreDataDir } from "@agentglass/db";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const mode = process.argv[2] ?? "backup";

if (mode === "backup") {
  const dataDir = arg("data-dir") ?? join(process.cwd(), "data");
  const out = arg("out") ?? join(process.cwd(), "backups");
  mkdirSync(out, { recursive: true });
  const { openDatabase } = await import("@agentglass/db");
  const db = openDatabase({ file: join(dataDir, "agentglass.db") });
  const result = backupDataDir({ dataDir, db, backupRoot: out });
  db.close();
  console.log(`[backup] 完成：${result.backupDir}`);
  console.log(`[backup] 文件 ${result.fileCount} 个，共 ${(result.totalBytes / 1024).toFixed(0)} KB；runs=${result.manifest.counts.runs}, events=${result.manifest.counts.events}`);
} else if (mode === "restore") {
  const from = arg("from");
  if (!from) {
    console.error("用法：pnpm restore -- --from <备份目录> [--to <目标数据目录>]");
    process.exit(1);
  }
  const to = arg("to") ?? join(process.cwd(), "data");
  const result = restoreDataDir({ backupDir: from, targetDir: to });
  console.log(`[restore] 完成：恢复 ${result.restoredFiles} 个文件到 ${to}`);
  console.log(`[restore] integrity=${result.integrity}, runs=${result.counts.runs}, events=${result.counts.events}`);
} else {
  console.error("用法：tsx scripts/backup-restore-cli.ts [backup|restore] [--key value]");
  process.exit(1);
}
