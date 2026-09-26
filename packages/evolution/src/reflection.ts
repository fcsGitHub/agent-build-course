/**
 * T30：反思重试与反馈来源对照。
 * 失败 → 结构化反思（带反馈来源标签）→ 注入下一次尝试；
 * 对照模式：同等额外调用但**不注入反思**（source: none），用于区分
 * "反馈本身带来的改进"与"单纯多算一次"。
 * 依据设计文档 v1.1 §17.3 反思重试。
 */
import type { Database } from "@agentglass/db";
import { nowIso } from "@agentglass/db";
import type { BlobStore, EventStore } from "@agentglass/events";
import { shaLike } from "@agentglass/knowledge";

export type FeedbackSource = "tool_error" | "test_failure" | "human" | "none" | "unknown";

export interface FailureInput {
  stage: string;
  toolId?: string;
  errorText: string;
  attemptedPath?: string;
  attemptedExpression?: string;
}

export interface ReflectionRecord {
  id: string;
  runId: string;
  source: FeedbackSource;
  summary: string;
  retryHint: string;
  causeDigest: string;
  createdAt: string;
}

export class ReflectionService {
  constructor(
    private readonly events: EventStore,
    private readonly blobs: BlobStore,
  ) {}

  /** 失败 → 结构化反思。来源标签由确定性规则给出（可解释，非模型自评）。 */
  analyzeFailure(runId: string, input: FailureInput): ReflectionRecord {
    const source = this.classify(input);
    const summary = this.summarize(input, source);
    const retryHint = this.retryHint(input, source);
    const record: ReflectionRecord = {
      id: `refl_${shaLike(runId + input.errorText + nowIso())}`,
      runId,
      source,
      summary,
      retryHint,
      causeDigest: shaLike(input.errorText),
      createdAt: nowIso(),
    };
    return record;
  }

  /** 记录反思：blob 存正文 + reflection.recorded 事件（summary 只放结构性字段）。 */
  record(runId: string, record: ReflectionRecord): void {
    const ref = this.blobs.putJson(record);
    this.events.transact(() => {
      this.events.append(runId, [
        {
          type: "reflection.recorded",
          summary: {
            reflectionId: record.id,
            source: record.source,
            summary: record.summary,
            retryHint: record.retryHint.slice(0, 160),
            recordRef: ref.id,
          },
          conceptIds: ["reflection"],
        },
      ]);
    });
  }

  /**
   * 反思注入上下文：包装为 host 侧前缀（与反馈来源一起可见，教学可对照）。
   * source=none 时返回空串——对照运行"多算一次但不给反思"。
   */
  injectReflection(record: ReflectionRecord | null): string {
    if (!record || record.source === "none") return "";
    return `【上一次尝试的失败反思（来源：${record.source}）】${record.summary} 下一步建议：${record.retryHint}`;
  }

  private classify(input: FailureInput): FeedbackSource {
    const e = input.errorText;
    if (/ENOENT|READ_FAILED|路径不存在|未知资源/i.test(e)) return "tool_error";
    if (/TEST_FAILED|CHECK\(S\) FAILED|退出码 1|assert/i.test(e)) return "test_failure";
    if (input.toolId != null) return "tool_error";
    return "unknown";
  }

  private summarize(input: FailureInput, source: FeedbackSource): string {
    const where = input.stage ? `（${input.stage}）` : "";
    const what = truncate(input.errorText, 120);
    if (source === "tool_error" && input.attemptedPath) {
      return `工具 ${input.toolId ?? "?"} 在读取 ${input.attemptedPath} 时失败${where}：${what}`;
    }
    if (source === "tool_error" && input.attemptedExpression) {
      return `计算表达式 "${truncate(input.attemptedExpression, 60)}" 失败${where}：${what}`;
    }
    return `失败${where}：${what}`;
  }

  private retryHint(input: FailureInput, source: FeedbackSource): string {
    if (source === "tool_error" && input.attemptedPath) {
      return `确认文件是否存在；若 ${input.attemptedPath} 不存在，改用任务数据中实际存在的文件重试`;
    }
    if (source === "test_failure") {
      return "阅读失败断言，修改实现而非修改测试期望";
    }
    return "检查输入假设后换一种方式重试";
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
