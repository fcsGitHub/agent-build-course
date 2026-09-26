/**
 * T35 故障/恢复测试：数据库与 blob 成对备份与恢复。
 * - 正常路径：备份 → 删除原目录 → 恢复 → integrity ok、runs/events 计数一致、blob 文本可读；
 * - 篡改路径：备份中任一文件被改 → 恢复拒绝（DIGEST_MISMATCH），不产出半恢复状态；
 * - 不完整路径：缺 blob 目录（只有 db）→ 恢复拒绝（成对约束）。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, backupDataDir, restoreDataDir, openBackupDatabase } from "@agentglass/db";
import { BlobStore, EventStore } from "@agentglass/events";

function buildData(): { dataDir: string; db: ReturnType<typeof openDatabase>; blobTexts: string[] } {
  const dataDir = mkdtempSync(join(tmpdir(), "ag-bak-"));
  const db = openDatabase({ file: join(dataDir, "agentglass.db") });
  const blobs = new BlobStore(db, join(dataDir, "blobs"));
  const events = new EventStore(db);
  db.prepare(
    "INSERT INTO runs (id, session_id, lesson_id, lesson_revision, agent_revision_id, state, mode, experiment_version, runtime_snapshot_id, model_profile_snapshot_id, asset_snapshot_id, policy_snapshot_id, input_ref, input_preview, budget, output_refs, created_at) VALUES (?, 's1', 'L00', '1.0.0', 'r1', 'completed', 'live', 'v1', 'rt', 'mp', 'as', 'po', 'input:x', 'demo', '{}', '[]', '2026-01-01T00:00:00Z')",
  ).run("run_backup_demo");
  const texts: string[] = [];
  for (let i = 0; i < 5; i++) {
    const ref = blobs.putText(`副作用工件 #${i}：这是备份恢复测试的真实 blob 内容。`);
    texts.push(blobs.getText(ref.id));
    events.transact(() => {
      events.append("run_backup_demo", [
        { type: "artifact.created", summary: { index: i }, payloadRef: ref, conceptIds: ["backup"] },
      ]);
    });
  }
  return { dataDir, db, blobTexts: texts };
}

describe("T35 备份/恢复（成对）", () => {
  it("备份 → 删除原目录 → 恢复：计数一致、blob 可读、integrity ok", () => {
    const { dataDir, db, blobTexts } = buildData();
    const backupRoot = mkdtempSync(join(tmpdir(), "ag-bak-root-"));
    const result = backupDataDir({ dataDir, db, backupRoot, label: "t35" });
    expect(result.fileCount).toBeGreaterThan(5); // db + 5 blobs + MANIFEST
    expect(result.manifest.counts.runs).toBe(1);
    expect(result.manifest.counts.events).toBe(5);

    // 恢复到新目录（模拟原目录彻底丢失）
    const target = join(mkdtempSync(join(tmpdir(), "ag-bak-restore-")), "restored");
    const restored = restoreDataDir({ backupDir: result.backupDir, targetDir: target });
    expect(restored.integrity).toBe("ok");
    expect(restored.counts).toEqual({ runs: 1, events: 5 });

    // 恢复后的库与 blob 成对可用
    const restoredDb = openDatabase({ file: join(target, "agentglass.db") });
    const restoredEvents = new EventStore(restoredDb);
    const restoredBlobs = new BlobStore(restoredDb, join(target, "blobs"));
    const all = restoredEvents.readRange("run_backup_demo", 0, restoredEvents.maxSeq("run_backup_demo"));
    expect(all).toHaveLength(5);
    const text = restoredBlobs.getText(all[0]!.payloadRef!.id);
    expect(text).toBe(blobTexts[0]);

    // 备份目录抽查只读打开
    const probe = openBackupDatabase(result.backupDir);
    expect((probe.prepare("SELECT COUNT(*) AS n FROM trace_events").get() as { n: number }).n).toBe(5);
    probe.close();
    restoredDb.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(backupRoot, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  it("备份内文件被篡改 → 恢复拒绝且不写入目标目录", () => {
    const { dataDir, db } = buildData();
    const backupRoot = mkdtempSync(join(tmpdir(), "ag-bak-root-"));
    const result = backupDataDir({ dataDir, db, backupRoot });
    const target = join(mkdtempSync(join(tmpdir(), "ag-bak-restore-")), "restored");

    // 篡改一个 blob 文件
    const blobFile = result.manifest.files.find((f) => f.path.startsWith("blobs/"))!;
    writeFileSync(join(result.backupDir, blobFile.path), "tampered内容", "utf8");

    expect(() => restoreDataDir({ backupDir: result.backupDir, targetDir: target })).toThrow(/DIGEST_MISMATCH/);
    expect(existsSync(target)).toBe(false); // 校验失败不产出半恢复状态

    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(backupRoot, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  it("备份缺 blob（只有 db）→ 恢复拒绝（成对约束）", () => {
    const { dataDir, db } = buildData();
    const backupRoot = mkdtempSync(join(tmpdir(), "ag-bak-root-"));
    const result = backupDataDir({ dataDir, db, backupRoot });
    // 从备份中删除 blob 文件并同步清单 → 模拟"只备了库没备 blob"的错误姿势
    for (const f of result.manifest.files.filter((f) => f.path.startsWith("blobs/"))) {
      rmSync(join(result.backupDir, f.path));
    }
    const manifestPath = join(result.backupDir, "MANIFEST.json");
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    m.files = m.files.filter((f: { path: string }) => !f.path.startsWith("blobs/"));
    writeFileSync(manifestPath, JSON.stringify(m), "utf8");
    const target = join(mkdtempSync(join(tmpdir(), "ag-bak-restore-")), "restored");
    mkdirSync(target, { recursive: true });

    expect(() => restoreDataDir({ backupDir: result.backupDir, targetDir: target })).toThrow(/成对/);

    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(backupRoot, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });
});
