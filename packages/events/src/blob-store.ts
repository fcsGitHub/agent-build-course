/**
 * 内容寻址工件存储（T07 基础）。
 * 先写临时内容并校验，再提交可用引用；数据库行与文件内容成对出现。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BlobRef } from "@agentglass/contracts";
import type { Database } from "@agentglass/db";
import { nowIso } from "@agentglass/db";

export class BlobStore {
  constructor(
    private readonly db: Database,
    private readonly rootDir: string,
  ) {
    mkdirSync(this.rootDir, { recursive: true });
  }

  put(content: Uint8Array, mediaType: string): BlobRef {
    const sha256 = createHash("sha256").update(content).digest("hex");
    const existing = this.db
      .prepare("SELECT id, sha256, media_type, bytes FROM blobs WHERE sha256 = ? AND media_type = ?")
      .get(sha256, mediaType) as
      | { id: string; sha256: string; media_type: string; bytes: number }
      | undefined;
    if (existing) {
      return {
        id: existing.id,
        sha256: existing.sha256,
        mediaType: existing.media_type,
        bytes: existing.bytes,
      };
    }
    const id = `blob_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const finalPath = join(this.rootDir, sha256);
    const tmpPath = join(this.rootDir, `.tmp-${randomUUID()}`);
    writeFileSync(tmpPath, content);
    renameSync(tmpPath, finalPath);
    this.db
      .prepare(
        "INSERT INTO blobs (id, sha256, media_type, bytes, created_at, storage, path) VALUES (?, ?, ?, ?, ?, 'file', ?)",
      )
      .run(id, sha256, mediaType, content.byteLength, nowIso(), finalPath);
    return { id, sha256, mediaType, bytes: content.byteLength };
  }

  putText(text: string, mediaType = "text/plain; charset=utf-8"): BlobRef {
    return this.put(new TextEncoder().encode(text), mediaType);
  }

  putJson(value: unknown): BlobRef {
    return this.putText(JSON.stringify(value, null, 2), "application/json");
  }

  getBytes(ref: BlobRef): Uint8Array {
    return this.getContentById(ref.id);
  }

  getContentById(id: string): Uint8Array {
    const row = this.db.prepare("SELECT path, sha256 FROM blobs WHERE id = ?").get(id) as
      | { path: string; sha256: string }
      | undefined;
    if (!row) throw new Error(`BLOB_NOT_FOUND: ${id}`);
    const content = readFileSync(row.path);
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (sha256 !== row.sha256) {
      throw new Error(`BLOB_DIGEST_MISMATCH: ${id}`);
    }
    return new Uint8Array(content);
  }

  getText(id: string): string {
    return new TextDecoder().decode(this.getContentById(id));
  }

  getJson<T>(id: string): T {
    return JSON.parse(this.getText(id)) as T;
  }

  exists(id: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM blobs WHERE id = ?").get(id) !== undefined
    );
  }

  meta(id: string): BlobRef {
    const row = this.db
      .prepare("SELECT id, sha256, media_type, bytes FROM blobs WHERE id = ?")
      .get(id) as { id: string; sha256: string; media_type: string; bytes: number } | undefined;
    if (!row) throw new Error(`BLOB_NOT_FOUND: ${id}`);
    return { id: row.id, sha256: row.sha256, mediaType: row.media_type, bytes: row.bytes };
  }

  /** 删除前校验无引用是调用方责任；此处只做物理删除与行删除 */
  delete(id: string): void {
    const row = this.db.prepare("SELECT path FROM blobs WHERE id = ?").get(id) as
      | { path: string }
      | undefined;
    if (!row) return;
    try {
      rmSync(row.path, { force: true });
    } catch {
      // 文件已不存在则忽略
    }
    this.db.prepare("DELETE FROM blobs WHERE id = ?").run(id);
  }

  totalBytes(): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(bytes), 0) AS total FROM blobs").get() as {
      total: number;
    };
    return row.total;
  }

  verifyAll(): { ok: boolean; broken: string[] } {
    const rows = this.db.prepare("SELECT id, path, sha256 FROM blobs").all() as Array<{
      id: string;
      path: string;
      sha256: string;
    }>;
    const broken: string[] = [];
    for (const row of rows) {
      try {
        const content = readFileSync(row.path);
        const digest = createHash("sha256").update(content).digest("hex");
        if (digest !== row.sha256) broken.push(row.id);
      } catch {
        broken.push(row.id);
      }
    }
    return { ok: broken.length === 0, broken };
  }

  statPath(id: string): number {
    const row = this.db.prepare("SELECT path FROM blobs WHERE id = ?").get(id) as
      | { path: string }
      | undefined;
    if (!row) throw new Error(`BLOB_NOT_FOUND: ${id}`);
    return statSync(row.path).size;
  }
}
