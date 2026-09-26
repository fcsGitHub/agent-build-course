/**
 * 共享原子预算账本（T06）。依据设计文档 v1.1 第 8.5 节。
 * 预算在发起调用前预留，完成后按实际用量结算；并发子任务共享父预算原子计数。
 * SQLite 单写者 + BEGIN IMMEDIATE 提供跨进程原子性（用例 6 的持久账本要求）。
 */
import type { Database } from "@agentglass/db";
import { newId, nowIso } from "@agentglass/db";
import type { BudgetLimit } from "@agentglass/contracts";

export interface Reservation {
  granted: boolean;
  owner: string;
  kind: "turn" | "model_call" | "tool_call";
  amount: number;
}

interface BudgetRow {
  id: string;
  run_id: string;
  limits: string;
  reserved_turns: number;
  used_turns: number;
  reserved_model_calls: number;
  used_model_calls: number;
  reserved_tool_calls: number;
  used_tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  wall_deadline_at: string;
}

export class BudgetExhaustedError extends Error {
  constructor(public readonly kind: string) {
    super(`预算耗尽: ${kind}`);
    this.name = "BudgetExhaustedError";
  }
}

export class BudgetLedger {
  constructor(private readonly db: Database) {}

  open(runId: string, limits: BudgetLimit): string {
    const id = newId("bud");
    const deadline = new Date(Date.now() + limits.maxWallTimeMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO budgets (id, run_id, limits, wall_deadline_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, runId, JSON.stringify(limits), deadline, nowIso(), nowIso());
    return id;
  }

  private getRow(budgetId: string): BudgetRow {
    const row = this.db.prepare("SELECT * FROM budgets WHERE id = ?").get(budgetId) as
      | BudgetRow
      | undefined;
    if (!row) throw new Error(`BUDGET_NOT_FOUND: ${budgetId}`);
    return row;
  }

  /** 原子预留；amount<=0 无操作。失败返回 granted:false（不抛错，由调用方决定停止）。 */
  reserve(
    budgetId: string,
    kind: "turn" | "model_call" | "tool_call",
    owner: string,
    amount = 1,
  ): Reservation {
    const column =
      kind === "turn" ? "reserved_turns" : kind === "model_call" ? "reserved_model_calls" : "reserved_tool_calls";
    const limitColumn =
      kind === "turn" ? "maxTurns" : kind === "model_call" ? "maxModelCalls" : "maxToolCalls";
    return this.dbTransaction(() => {
      const row = this.getRow(budgetId);
      const limits = JSON.parse(row.limits) as BudgetLimit;
      const already = row[column as keyof BudgetRow] as number;
      const cap = limits[limitColumn as keyof BudgetLimit] as number;
      const granted = already + amount <= cap;
      this.db
        .prepare(
          `INSERT INTO budget_reservations (id, budget_id, owner, kind, amount, granted, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(newId("res"), budgetId, owner, kind, amount, granted ? 1 : 0, nowIso());
      if (granted) {
        this.db
          .prepare(`UPDATE budgets SET ${column} = ${column} + ?, updated_at = ? WHERE id = ?`)
          .run(amount, nowIso(), budgetId);
      }
      return { granted, owner, kind, amount };
    });
  }

  /** 预留成功后调用：记为实际使用（可与预留合并，这里保留两步以贴近 reserve/settle 合同）。 */
  settleUse(
    budgetId: string,
    kind: "turn" | "model_call" | "tool_call",
    amount = 1,
    usage?: { inputTokens?: number; outputTokens?: number },
  ): void {
    const usedColumn =
      kind === "turn" ? "used_turns" : kind === "model_call" ? "used_model_calls" : "used_tool_calls";
    this.dbTransaction(() => {
      this.db
        .prepare(`UPDATE budgets SET ${usedColumn} = ${usedColumn} + ?, updated_at = ? WHERE id = ?`)
        .run(amount, nowIso(), budgetId);
      if (usage?.inputTokens) {
        this.db
          .prepare("UPDATE budgets SET input_tokens = input_tokens + ?, updated_at = ? WHERE id = ?")
          .run(usage.inputTokens, nowIso(), budgetId);
      }
      if (usage?.outputTokens) {
        this.db
          .prepare("UPDATE budgets SET output_tokens = output_tokens + ?, updated_at = ? WHERE id = ?")
          .run(usage.outputTokens, nowIso(), budgetId);
      }
    });
  }

  /** 宿主侧硬检查：即使学生策略要求继续，也必须停。 */
  hardCheck(budgetId: string, kind: "turn" | "model_call" | "tool_call"): boolean {
    const row = this.getRow(budgetId);
    const limits = JSON.parse(row.limits) as BudgetLimit;
    const now = new Date();
    if (now.toISOString() > row.wall_deadline_at) return false;
    if (
      kind === "turn" &&
      row.reserved_turns >= limits.maxTurns
    )
      return false;
    if (
      kind === "model_call" &&
      row.reserved_model_calls >= limits.maxModelCalls
    )
      return false;
    if (
      kind === "tool_call" &&
      row.reserved_tool_calls >= limits.maxToolCalls
    )
      return false;
    return true;
  }

  wallDeadlineExceeded(budgetId: string): boolean {
    const row = this.getRow(budgetId);
    return new Date().toISOString() > row.wall_deadline_at;
  }

  /**
   * 驻留豁免：暂停/断点驻留是人类检视时间，不应消耗执行墙钟（否则单步调试
   * 几分钟就会以 budget_wall_time_exhausted 杀死运行）。恢复驻留时按驻留
   * 时长顺延 wall_deadline_at；驻留事实仍以 run.paused/run.resumed 事件入账。
   * budget 行 id 是 bud_*（open 时生成），按 run_id 定位该运行最新一条预算。
   */
  extendWallDeadlineByRun(runId: string, extraMs: number): void {
    if (!Number.isFinite(extraMs) || extraMs <= 0) return;
    const row = this.db
      .prepare("SELECT * FROM budgets WHERE run_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(runId) as BudgetRow | undefined;
    if (!row) return; // 运行尚未 open 预算（理论上不发生）：不伪造顺延事实
    const base = Date.parse(row.wall_deadline_at);
    if (Number.isNaN(base)) return;
    const next = new Date(base + Math.floor(extraMs)).toISOString();
    this.db
      .prepare("UPDATE budgets SET wall_deadline_at = ?, updated_at = ? WHERE id = ?")
      .run(next, nowIso(), row.id);
  }

  snapshot(budgetId: string): {
    limits: BudgetLimit;
    used: { turns: number; modelCalls: number; toolCalls: number };
    inputTokens: number;
    outputTokens: number;
    wallDeadlineAt: string;
  } {
    const row = this.getRow(budgetId);
    return {
      limits: JSON.parse(row.limits) as BudgetLimit,
      used: {
        turns: row.used_turns,
        modelCalls: row.used_model_calls,
        toolCalls: row.used_tool_calls,
      },
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      wallDeadlineAt: row.wall_deadline_at,
    };
  }

  private dbTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
