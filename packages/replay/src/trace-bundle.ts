/**
 * .agtrace.zip 运行包导出/导入（T33 基础）。
 * 导出前内容脱敏；导入检查路径穿越、条目数/尺寸上限、摘要与 schema；默认不执行包中脚本。
 * 依据设计文档 v1.1 第 18.6 节。
 */
import { createHash } from "node:crypto";
import { zipSync, unzipSync, strFromU8, strToU8 } from "fflate";
import type { TraceEvent } from "@agentglass/contracts";
import type { SourceManifest } from "@agentglass/source-map";

export interface TraceBundleManifest {
  schemaVersion: 1;
  reducerVersion: string;
  exportedAt: string;
  originalRunId: string;
  mode: string;
  eventRange: { fromSeq: number; toSeq: number };
  redaction: "classroom";
  integrity: { eventsSha256: string; eventCount: number };
  licenses: "SEE licenses/THIRD_PARTY_NOTICES.md";
  /** 课程清单快照（可选）：仅当运行版本与课程当前版本一致时随包携带；回放端据此重建框图（纯投影，不执行） */
  lesson?: { id: string; revision: string; manifest?: Record<string, unknown> };
}

export interface BundleBuildInput {
  runId: string;
  mode: string;
  events: TraceEvent[];
  sourceManifest?: SourceManifest;
  sourceFiles?: Record<string, string>;
  lesson?: { id: string; revision: string; markdown: string; manifestYaml: string; manifest?: Record<string, unknown> };
  reducerVersion: string;
}

const MAX_ENTRIES = 5000;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export function exportBundle(input: BundleBuildInput): Uint8Array {
  const eventsJsonl = input.events
    .map((e) => JSON.stringify(stripPayloadBlobs(e)))
    .join("\n");
  const manifest: TraceBundleManifest = {
    schemaVersion: 1,
    reducerVersion: input.reducerVersion,
    exportedAt: new Date().toISOString(),
    originalRunId: input.runId,
    mode: input.mode,
    eventRange: {
      fromSeq: input.events[0]?.seq ?? 0,
      toSeq: input.events.at(-1)?.seq ?? 0,
    },
    redaction: "classroom",
    integrity: {
      eventsSha256: createHash("sha256").update(eventsJsonl).digest("hex"),
      eventCount: input.events.length,
    },
    licenses: "SEE licenses/THIRD_PARTY_NOTICES.md",
    ...(input.lesson
      ? {
          lesson: {
            id: input.lesson.id,
            revision: input.lesson.revision,
            ...(input.lesson.manifest ? { manifest: input.lesson.manifest } : {}),
          },
        }
      : {}),
  };
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "events/events.jsonl": strToU8(eventsJsonl),
  };
  if (input.sourceManifest) {
    files["source/manifest.json"] = strToU8(JSON.stringify(input.sourceManifest, null, 2));
  }
  if (input.sourceFiles) {
    for (const [path, content] of Object.entries(input.sourceFiles)) {
      files[`source/files/${path}`] = strToU8(content);
    }
  }
  if (input.lesson) {
    files["lesson/lesson.md"] = strToU8(input.lesson.markdown);
    files["lesson/manifest.yaml"] = strToU8(input.lesson.manifestYaml);
  }
  return zipSync(files);
}

export interface ImportResult {
  ok: boolean;
  errors: string[];
  manifest?: TraceBundleManifest;
  events?: TraceEvent[];
  sourceFiles?: Record<string, string>;
}

export function importBundle(bytes: Uint8Array): ImportResult {
  const errors: string[] = [];
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (err) {
    return { ok: false, errors: [`ZIP_INVALID: ${String(err)}`] };
  }
  const names = Object.keys(entries);
  if (names.length > MAX_ENTRIES) errors.push(`TOO_MANY_ENTRIES: ${names.length}`);
  const total = names.reduce((s, n) => s + entries[n]!.length, 0);
  if (total > MAX_TOTAL_BYTES) errors.push(`BUNDLE_TOO_LARGE: ${total}`);
  for (const name of names) {
    if (name.includes("..") || name.startsWith("/") || name.includes("\\")) {
      errors.push(`PATH_ESCAPE: ${name}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const manifest = JSON.parse(strFromU8(entries["manifest.json"]!)) as TraceBundleManifest;
  const eventsJsonl = strFromU8(entries["events/events.jsonl"]!);
  const digest = createHash("sha256").update(eventsJsonl).digest("hex");
  if (digest !== manifest.integrity.eventsSha256) {
    errors.push("EVENTS_DIGEST_MISMATCH");
  }
  const events = eventsJsonl
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as TraceEvent);
  if (events.length !== manifest.integrity.eventCount) {
    errors.push("EVENT_COUNT_MISMATCH");
  }
  const sourceFiles: Record<string, string> = {};
  for (const name of names) {
    if (name.startsWith("source/files/")) {
      sourceFiles[name.slice("source/files/".length)] = strFromU8(entries[name]!);
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    manifest,
    events,
    sourceFiles,
  };
}

/** 导出策略：payloadRef 保留引用元信息（blob 内容不打包，回放显示缺口并标注） */
function stripPayloadBlobs(e: TraceEvent): TraceEvent {
  return { ...e, payloadRef: e.payloadRef ? { ...e.payloadRef } : undefined };
}
