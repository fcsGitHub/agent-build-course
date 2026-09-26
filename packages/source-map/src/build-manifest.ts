/**
 * 源码清单与执行绑定（T07）。
 * 每次运行冻结 SourceManifest：文件内容摘要 + 概念锚点区域；
 * 代码修改后旧运行仍定位旧内容；禁止用当前 HEAD 替代历史源工件。
 * 依据设计文档 v1.1 第 9.4 节。
 */
import { createHash } from "node:crypto";
import type { BlobStore } from "@agentglass/events";
import type { Database } from "@agentglass/db";
import { newId, nowIso } from "@agentglass/db";

export interface SourceRegion {
  id: string;
  symbol: string;
  startLine: number;
  endLine: number;
  conceptIds: string[];
}

export interface SourceFileEntry {
  id: string;
  path: string;
  contentDigest: string;
  blobId: string;
  regions: SourceRegion[];
}

export interface SourceManifest {
  schemaVersion: 1;
  id: string;
  repositoryOrigin: string;
  commit: string | null;
  dirtyPatchDigest: string;
  buildDigest: string;
  agentRevisionId: string | null;
  baseManifestId: string | null;
  editPolicyDigest: string | null;
  validationReportId: string | null;
  lockfileDigest: string | null;
  files: SourceFileEntry[];
  createdAt: string;
}

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface ManifestInput {
  repositoryOrigin: string;
  files: Array<{
    path: string;
    content: string;
    regions?: SourceRegion[];
  }>;
  buildDigest: string;
  agentRevisionId?: string;
  baseManifestId?: string;
  editPolicyDigest?: string;
  validationReportId?: string;
  dirtyPatchDigest?: string;
  commit?: string;
}

export class SourceManifestBuilder {
  constructor(
    private readonly db: Database,
    private readonly blobs: BlobStore,
  ) {}

  build(input: ManifestInput): SourceManifest {
    const id = newId("srcman");
    const files: SourceFileEntry[] = input.files.map((f) => {
      const ref = this.blobs.putText(f.content, "text/plain; charset=utf-8");
      return {
        id: `file_${stableFileId(f.path)}`,
        path: f.path,
        contentDigest: sha256(f.content),
        blobId: ref.id,
        regions: f.regions ?? [],
      };
    });
    const manifest: SourceManifest = {
      schemaVersion: 1,
      id,
      repositoryOrigin: input.repositoryOrigin,
      commit: input.commit ?? null,
      dirtyPatchDigest: input.dirtyPatchDigest ?? "clean",
      buildDigest: input.buildDigest,
      agentRevisionId: input.agentRevisionId ?? null,
      baseManifestId: input.baseManifestId ?? null,
      editPolicyDigest: input.editPolicyDigest ?? null,
      validationReportId: input.validationReportId ?? null,
      lockfileDigest: null,
      files,
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO source_manifests (id, schema_version, repository_origin, git_commit, dirty_patch_digest, build_digest, agent_revision_id, base_manifest_id, edit_policy_digest, validation_report_id, lockfile_digest, files, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        manifest.id,
        1,
        manifest.repositoryOrigin,
        manifest.commit,
        manifest.dirtyPatchDigest,
        manifest.buildDigest,
        manifest.agentRevisionId,
        manifest.baseManifestId,
        manifest.editPolicyDigest,
        manifest.validationReportId,
        manifest.lockfileDigest,
        JSON.stringify(manifest.files),
        manifest.createdAt,
      );
    return manifest;
  }

  get(id: string): SourceManifest | undefined {
    const row = this.db.prepare("SELECT * FROM source_manifests WHERE id = ?").get(id) as
      | { files: string; [k: string]: unknown }
      | undefined;
    if (!row) return undefined;
    return {
      schemaVersion: 1,
      id: row.id as string,
      repositoryOrigin: row.repository_origin as string,
      commit: (row.git_commit as string | null) ?? null,
      dirtyPatchDigest: row.dirty_patch_digest as string,
      buildDigest: row.build_digest as string,
      agentRevisionId: (row.agent_revision_id as string | null) ?? null,
      baseManifestId: (row.base_manifest_id as string | null) ?? null,
      editPolicyDigest: (row.edit_policy_digest as string | null) ?? null,
      validationReportId: (row.validation_report_id as string | null) ?? null,
      lockfileDigest: (row.lockfile_digest as string | null) ?? null,
      files: JSON.parse(row.files as string) as SourceFileEntry[],
      createdAt: row.created_at as string,
    };
  }

  /** 读取冻结文件内容（历史版本不会被当前草稿覆盖） */
  fileContent(manifestId: string, fileId: string): string {
    const manifest = this.get(manifestId);
    if (!manifest) throw new Error(`MANIFEST_NOT_FOUND: ${manifestId}`);
    const file = manifest.files.find((f) => f.id === fileId);
    if (!file) throw new Error(`SOURCE_FILE_NOT_FOUND: ${fileId}`);
    return this.blobs.getText(file.blobId);
  }
}

function stableFileId(path: string): string {
  return sha256(path).slice(0, 16);
}

/** 解析锚点：给定 manifest 与 regionId 返回文件内容与行号范围（行号为冻结文件中的派生显示信息） */
export function resolveAnchor(
  manifest: SourceManifest,
  fileId: string,
  regionId: string,
): { path: string; content: string; region: SourceRegion } | { error: string } {
  const file = manifest.files.find((f) => f.id === fileId);
  if (!file) return { error: `SOURCE_FILE_NOT_FOUND: ${fileId}` };
  const region = file.regions.find((r) => r.id === regionId);
  if (!region) return { error: `REGION_NOT_FOUND: ${regionId}` };
  return { path: file.path, content: "", region };
}
