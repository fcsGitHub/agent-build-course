/**
 * verify:source-bindings —— 源码绑定检查（T07/T40）。
 * 数据库中登记的每个 AgentRevision：bundle 文件存在、源码清单完整、摘要一致。
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { openDatabase } from "../packages/db/src/database.js";

const dataDir = process.env.AGENTGLASS_DATA ?? join(process.cwd(), "data");
const dbFile = join(dataDir, "agentglass.db");
if (!existsSync(dbFile)) {
  console.log(`[verify:source-bindings] 无数据库（${dbFile}），跳过（尚无运行记录）`);
  process.exit(0);
}
const db = openDatabase({ file: dbFile });
const blobsDir = join(dataDir, "blobs");
const rows = db.prepare("SELECT id, bundle_path, source_manifest_id, source_digest FROM agent_revisions").all() as Array<{
  id: string;
  bundle_path: string;
  source_manifest_id: string;
  source_digest: string;
}>;

let failures = 0;
for (const row of rows) {
  if (!existsSync(row.bundle_path)) {
    console.error(`✗ [${row.id}] bundle 文件缺失: ${row.bundle_path}`);
    failures += 1;
    continue;
  }
  const manifestRow = db.prepare("SELECT files FROM source_manifests WHERE id = ?").get(row.source_manifest_id) as
    | { files: string }
    | undefined;
  if (!manifestRow) {
    console.error(`✗ [${row.id}] 源码清单缺失: ${row.source_manifest_id}`);
    failures += 1;
    continue;
  }
  const files = JSON.parse(manifestRow.files) as Array<{ path: string; contentDigest: string; blobId: string }>;
  const fileRow = db.prepare("SELECT path, sha256 FROM blobs WHERE id = ?").get(files[0]?.blobId ?? "") as { sha256: string } | undefined;
  void fileRow;
  for (const f of files) {
    const blobRow = db.prepare("SELECT path, sha256 FROM blobs WHERE id = ?").get(f.blobId) as
      | { path: string; sha256: string }
      | undefined;
    if (!blobRow || !existsSync(blobRow.path)) {
      console.error(`✗ [${row.id}] 源文件 blob 缺失: ${f.path}`);
      failures += 1;
      continue;
    }
    const content = readFileSync(blobRow.path);
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== f.contentDigest) {
      console.error(`✗ [${row.id}] 源文件摘要不符: ${f.path}`);
      failures += 1;
    }
  }
  void row.source_digest;
}

if (failures > 0) {
  console.error(`[verify:source-bindings] 失败：${failures} 处绑定损坏`);
  process.exit(1);
}
console.log(`[verify:source-bindings] 通过：${rows.length} 个 AgentRevision 的源码绑定完整`);
