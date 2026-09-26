/**
 * T32 子集：诚实训练接口（L40）。
 * - 数据集导出：仅纳入 real 运行；fake/synthetic 运行显式排除并可见（不给"真数据"假象）；
 * - 训练任务：本地模式无真实训练后端 → 任务诚实停在 unsupported，**不可标记为训练完成**；
 *   只有配置了真实后端且其回报权重工件摘要时，completed 才可达成（含权重摘要绑定）。
 * 依据设计文档 v1.1 §4.8 L40、§17.6（只有发生权重更新才能标注为训练完成）。
 */
import { createHash } from "node:crypto";
import { nowIso } from "@agentglass/db";
import type { BlobStore, EventStore } from "@agentglass/events";

export const TRAINING_INTERFACE_VERSION = "training-interface-1";

export type TrainingMethod = "sft" | "dpo" | "rl";
export type TrainingJobState = "unsupported" | "queued" | "running" | "completed" | "failed";

/** 真实训练后端合同（本交付不含实现；接入时实现此接口并注入） */
export interface TrainingBackend {
  readonly kind: string;
  start(job: { method: TrainingMethod; datasetVersion: string; baseModel: string }): Promise<{ externalId: string }>;
  /** 返回权重工件摘要（无真实权重更新时不得返回 completed） */
  poll(externalId: string): Promise<{ state: "running" | "completed" | "failed"; weightsDigest?: string; metrics?: Record<string, number> }>;
}

export interface TrainingRunRecord {
  runId: string;
  provider: string;
  /** 该运行是否为真实模型产生（fake/模拟 = false） */
  real: boolean;
}

export interface ExportedDataset {
  datasetVersion: string;
  included: string[];
  excluded: Array<{ runId: string; reason: string }>;
}

export interface TrainingJob {
  id: string;
  method: TrainingMethod;
  datasetVersion: string;
  baseModel: string;
  state: TrainingJobState;
  reason: string | null;
  externalId: string | null;
  weightsDigest: string | null;
  metrics: Record<string, number> | null;
  createdAt: string;
}

let jobSeq = 0;

export class TrainingJobService {
  private jobs = new Map<string, TrainingJob>();

  constructor(
    private readonly blobs: BlobStore,
    private readonly events: EventStore,
    private readonly backend: TrainingBackend | null,
  ) {}

  /** 数据集导出：synthetic（fake/模拟）运行显式排除；版本为纳入集内容哈希 */
  exportDataset(records: TrainingRunRecord[]): ExportedDataset {
    const included = records.filter((r) => r.real).map((r) => r.runId);
    const excluded = records
      .filter((r) => !r.real)
      .map((r) => ({ runId: r.runId, reason: `synthetic：provider=${r.provider} 为模拟运行，不进入训练集` }));
    const datasetVersion = createHash("sha256").update(JSON.stringify(included)).digest("hex");
    this.events.transact(() => {
      this.events.append(`training-ds-${datasetVersion.slice(0, 10)}`, [
        { type: "training.dataset_exported", summary: { datasetVersion: datasetVersion.slice(0, 12), included: included.length, excluded: excluded.length, note: "synthetic 运行被排除" }, conceptIds: ["evolution"] },
      ]);
    });
    return { datasetVersion, included, excluded };
  }

  /** 登记训练任务：无后端 → unsupported（诚实）；不可后续补标完成 */
  createJob(input: { method: TrainingMethod; dataset: ExportedDataset; baseModel: string }): TrainingJob {
    jobSeq += 1;
    const job: TrainingJob = this.backend
      ? { id: `tjob_${jobSeq}`, method: input.method, datasetVersion: input.dataset.datasetVersion, baseModel: input.baseModel, state: "queued", reason: null, externalId: null, weightsDigest: null, metrics: null, createdAt: nowIso() }
      : { id: `tjob_${jobSeq}`, method: input.method, datasetVersion: input.dataset.datasetVersion, baseModel: input.baseModel, state: "unsupported", reason: "TRAINING_BACKEND_UNCONFIGURED: 本地模式未配置真实训练后端；只能讲解数据流程或回放已有记录，不能标注为本次训练完成", externalId: null, weightsDigest: null, metrics: null, createdAt: nowIso() };
    this.jobs.set(job.id, job);
    const ref = this.blobs.putJson({ job, interfaceVersion: TRAINING_INTERFACE_VERSION });
    this.events.transact(() => {
      this.events.append(job.id, [
        { type: "training.job_created", summary: { jobId: job.id, method: job.method, state: job.state, datasetVersion: job.datasetVersion.slice(0, 12), recordRef: ref.id }, conceptIds: ["evolution"] },
      ]);
    });
    return job;
  }

  /**
   * 标记完成：仅当配置了真实后端、任务在跑、且后端回报了权重工件摘要。
   * 没有发生权重更新就绝不允许 completed（诚实边界）。
   */
  async pollJob(jobId: string): Promise<TrainingJob> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`TRAINING_JOB_NOT_FOUND: ${jobId}`);
    if (job.state === "unsupported") return job; // 终态：不可补标
    if (job.state === "queued" && this.backend) {
      const started = await this.backend.start({ method: job.method, datasetVersion: job.datasetVersion, baseModel: job.baseModel });
      job.externalId = started.externalId;
      job.state = "running";
      return job;
    }
    if (job.state === "running" && this.backend && job.externalId) {
      const status = await this.backend.poll(job.externalId);
      if (status.state === "completed") {
        if (!status.weightsDigest) {
          job.state = "failed";
          job.reason = "后端报告完成但未提供权重工件摘要；拒绝标注训练完成";
          return job;
        }
        job.state = "completed";
        job.weightsDigest = status.weightsDigest;
        job.metrics = status.metrics ?? null;
      } else if (status.state === "failed") {
        job.state = "failed";
        job.reason = "后端报告失败";
      }
      return job;
    }
    return job;
  }

  get(jobId: string): TrainingJob | undefined {
    return this.jobs.get(jobId);
  }
}
