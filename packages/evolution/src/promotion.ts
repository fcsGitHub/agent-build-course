/**
 * T31：Wiki—技能—Harness 演进门控。
 * 候选（技能修订）必须依次通过：
 *   1) 证据门：引用的证据块存在、且所属文档版本未被取代（旧证据 → 拒绝）；
 *   2) 安全回归：候选正文不含禁用构造、不触碰保护路径；
 *   3) 冻结验证集：EvaluationService 冻结切分上成功率 ≥ 门槛（候选不可改 grader）；
 *   4) 并发版本检查：晋级时技能当前版本与候选基线一致（乐观锁），否则拒绝。
 * 通过 → 技能新版本发布；任一门拒绝 → 保留失败记录，不发布。
 * 依据设计文档 v1.1 §17.2—§17.4、§9.8；安全测试对应 candidate-evaluation。
 */
import type { Database } from "@agentglass/db";
import { nowIso } from "@agentglass/db";
import type { BlobStore, EventStore } from "@agentglass/events";
import type { EvaluationService, CaseRunner } from "@agentglass/evaluation";
import type { EvalCase } from "@agentglass/contracts";
import type { SkillRegistry } from "@agentglass/skills";
import type { IngestionService } from "@agentglass/knowledge";

export const PROMOTION_GATE_VERSION = "promotion-gate-1";

/** 安全回归禁用构造（与 code-lab 同源；候选正文是技能文档/配置，标准更严） */
const FORBIDDEN = /\b(eval|Function|require|process|globalThis|__dirname|__filename)\b|\bimport\s*\(/;
const PROTECTED_PATH_HINTS = /packages\/(policy|provider-gateway|events)|graders|hidden[-_]?tests|approval/i;

export interface SkillCandidate {
  candidateId: string;
  skillSlug: string;
  /** 候选基线版本（并发检查用） */
  baseVersion: string;
  newBody: string;
  /** 证据块（应来自最新文档版本） */
  evidenceChunkIds: string[];
  proposedBy: string;
}

export interface GateOutcome {
  gate: "evidence" | "safety" | "frozen_eval" | "concurrency";
  passed: boolean;
  detail: string;
}

export interface PromotionDecision {
  promoted: boolean;
  candidateId: string;
  gates: GateOutcome[];
  newVersion?: string;
  rejectedReason?: string;
}

export class CandidateService {
  constructor(
    private readonly db: Database,
    private readonly blobs: BlobStore,
    private readonly events: EventStore,
    private readonly skills: SkillRegistry,
    private readonly ingestion: IngestionService,
    private readonly evaluation: EvaluationService,
  ) {}

  /**
   * 完整门控流程。evalCases/runner 由平台提供（冻结验证集）；runner 在服务内执行，
   * 候选提交者无权指定 grader 或隐藏用例。
   */
  async evaluateAndPromote(input: {
    candidate: SkillCandidate;
    evalCases: EvalCase[];
    runner: CaseRunner;
    minSuccessRate: number;
  }): Promise<PromotionDecision> {
    const gates: GateOutcome[] = [];
    const reject = async (gate: GateOutcome): Promise<PromotionDecision> => {
      gates.push(gate);
      await this.recordCandidate(input.candidate, gates, false, gate.detail);
      this.events.transact(() => {
        this.events.append(input.candidate.candidateId, [
          { type: "candidate.rejected", summary: { candidateId: input.candidate.candidateId, gate: gate.gate, detail: gate.detail } },
        ]);
      });
      return { promoted: false, candidateId: input.candidate.candidateId, gates, rejectedReason: `${gate.gate}: ${gate.detail}` };
    };

    // —— 门 1：证据（块存在 + 所属文档版本未被取代） ——
    for (const chunkId of input.candidate.evidenceChunkIds) {
      const row = this.db.prepare("SELECT doc_revision_id FROM chunks WHERE id = ?").get(chunkId) as
        | { doc_revision_id: string }
        | undefined;
      if (!row) {
        return await reject({ gate: "evidence", passed: false, detail: `证据块不存在: ${chunkId}` });
      }
      const rev = this.ingestion.getRevision(row.doc_revision_id);
      if (rev?.supersededBy) {
        return await reject({
          gate: "evidence",
          passed: false,
          detail: `证据来自已取代版本 ${rev.path}@${rev.version}；必须基于最新版复核`,
        });
      }
    }
    gates.push({ gate: "evidence", passed: true, detail: `证据块 ${input.candidate.evidenceChunkIds.length} 条全部来自当前版本` });

    // —— 门 2：安全回归（禁用构造 + 保护路径） ——
    if (FORBIDDEN.test(input.candidate.newBody)) {
      return await reject({ gate: "safety", passed: false, detail: "候选包含禁用构造（eval/require/process 等）" });
    }
    if (PROTECTED_PATH_HINTS.test(input.candidate.newBody)) {
      return await reject({ gate: "safety", passed: false, detail: "候选引用了保护路径/隐藏测试（安全策略不可被候选触碰）" });
    }
    gates.push({ gate: "safety", passed: true, detail: "安全回归通过" });

    // —— 门 3：冻结验证集 ——
    const frozen = this.evaluation.freeze(input.evalCases);
    const suite = await this.evaluation.runSuite(input.runner);
    const rate = suite.summary.successRate;
    gates.push({
      gate: "frozen_eval",
      passed: rate >= input.minSuccessRate && suite.summary.applicable > 0,
      detail: `冻结集 ${suite.summary.applicable}/${suite.summary.total} 可适用，成功率 ${rate.toFixed(2)}（门槛 ${input.minSuccessRate}）`,
    });
    if (rate < input.minSuccessRate || suite.summary.applicable === 0) {
      return await reject({ gate: "frozen_eval", passed: false, detail: `冻结验证集未达门槛：${rate.toFixed(2)} < ${input.minSuccessRate}` });
    }

    // —— 门 4：并发版本检查 ——
    const skill = this.skills.get(input.candidate.skillSlug);
    if (!skill) {
      return await reject({ gate: "concurrency", passed: false, detail: `技能不存在: ${input.candidate.skillSlug}` });
    }
    if (skill.version !== input.candidate.baseVersion) {
      return await reject({
        gate: "concurrency",
        passed: false,
        detail: `基线版本已变化（${input.candidate.baseVersion} → ${skill.version}）；候选需基于最新版本重新提出`,
      });
    }

    // —— 晋级：技能新版本（minor +1）——
    const newVersion = bumpMinor(skill.version);
    this.skills.updateBody(input.candidate.skillSlug, input.candidate.newBody, newVersion);
    gates.push({ gate: "concurrency", passed: true, detail: `并发版本检查通过，晋级为 ${newVersion}` });
    await this.recordCandidate(input.candidate, gates, true, `晋级 ${newVersion}`);
    this.events.transact(() => {
      this.events.append(input.candidate.candidateId, [
        { type: "candidate.promoted", summary: { candidateId: input.candidate.candidateId, slug: input.candidate.skillSlug, newVersion } },
      ]);
    });
    return { promoted: true, candidateId: input.candidate.candidateId, gates, newVersion };
  }

  private async recordCandidate(
    candidate: SkillCandidate,
    gates: GateOutcome[],
    promoted: boolean,
    detail: string,
  ): Promise<void> {
    const ref = this.blobs.putJson({ candidate, gates, promoted, detail, evaluatedAt: nowIso() });
    this.events.transact(() => {
      this.events.append(candidate.candidateId, [
        {
          type: "candidate.evaluated",
          summary: {
            candidateId: candidate.candidateId,
            slug: candidate.skillSlug,
            promoted,
            detail: detail.slice(0, 160),
            recordRef: ref.id,
            gateVersion: PROMOTION_GATE_VERSION,
          },
          conceptIds: ["evolution"],
        },
      ]);
    });
  }
}

function bumpMinor(version: string): string {
  const parts = version.split(".");
  if (parts.length === 3) {
    return `${parts[0]}.${parts[1]}.${Number(parts[2]) + 1}`;
  }
  return `${version}.1`;
}
