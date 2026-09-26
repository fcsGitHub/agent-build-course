/**
 * 长期任务状态（T23）。task-progress 工件：模型可读，持久事实以数据库/事件账本为准。
 * progress 记录存 blob + 事件（task.progress_updated）；恢复时以最新工件 + 事件重建。
 * 依据设计文档 v1.1 §15.5。
 */
import type { Database } from "@agentglass/db";
import { newId, nowIso } from "@agentglass/db";
import type { BlobStore } from "@agentglass/events";

export interface TaskProgress {
  runId: string;
  steps: Array<{ id: string; title: string; status: "pending" | "done" | "blocked"; updatedAt: string }>;
  updatedAt: string;
}

export class TaskProgressStore {
  constructor(
    private readonly db: Database,
    private readonly blobs: BlobStore,
  ) {}

  /** 更新进展：写工件 blob + 事件（调用方负责事件追加，此处返回摘要） */
  update(
    runId: string,
    steps: Array<{ id: string; title: string; status: TaskProgress["steps"][number]["status"] }>,
  ): {
    progressRef: string;
    done: number;
    total: number;
  } {
    const progress: TaskProgress = {
      runId,
      steps: steps.map((s) => ({ ...s, updatedAt: nowIso() })),
      updatedAt: nowIso(),
    };
    const ref = this.blobs.putJson(progress);
    return { progressRef: ref.id, done: steps.filter((s) => s.status === "done").length, total: steps.length };
  }

  load(progressRef: string): TaskProgress {
    return this.blobs.getJson<TaskProgress>(progressRef);
  }

  /** 新建进展记录行（长期状态以 DB 行为权威引用，blob 存内容） */
  record(runId: string, progressRef: string): string {
    const id = newId("prog");
    this.db
      .prepare(
        "INSERT INTO config_kv (key, value, updated_at) VALUES (?, ?, ?)",
      )
      .run(`task_progress:${id}`, JSON.stringify({ runId, progressRef }), nowIso());
    return id;
  }
}
