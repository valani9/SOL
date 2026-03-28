import { getDb } from "./db";
import { v4 as uuidv4 } from "uuid";
import { TrustLedger, type TrustTier } from "./trust-ledger";

export interface TransactionIntent {
  type: string; // "swap", "transfer", "stake"
  programId: string;
  amountSol: number;
  destination?: string;
  tokenMint?: string;
  description: string;
  rawInstructions?: any; // serialized instructions for execution
}

export interface QueuedTransaction {
  id: string;
  agentId: string;
  intent: TransactionIntent;
  riskScore: number;
  status: "pending" | "approved" | "rejected" | "expired" | "executed";
  createdAt: number;
  resolvedAt: number | null;
  resolution: string | null;
}

export type ApprovalRoute = "auto_approve" | "delayed" | "requires_approval";

export interface RiskAssessment {
  score: number;
  route: ApprovalRoute;
  factors: RiskFactor[];
}

export interface RiskFactor {
  name: string;
  score: number;
  weight: number;
  detail: string;
}

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DELAYED_EXECUTION_MS = 60 * 1000; // 60 seconds

export class TxQueue {
  private trustLedger: TrustLedger;

  constructor(trustLedger: TrustLedger) {
    this.trustLedger = trustLedger;
  }

  /**
   * Calculate risk score for a transaction intent.
   */
  assessRisk(agentId: string, intent: TransactionIntent): RiskAssessment {
    const tier = this.trustLedger.getCurrentTier(agentId);
    const factors: RiskFactor[] = [];

    // Factor 1: Amount relative to limit (30% weight)
    const amountRatio = intent.amountSol / tier.maxSolPerTx;
    const amountScore = Math.min(100, Math.round(amountRatio * 100));
    factors.push({
      name: "amount_ratio",
      score: amountScore,
      weight: 0.3,
      detail: `${intent.amountSol} SOL / ${tier.maxSolPerTx} SOL limit = ${(amountRatio * 100).toFixed(0)}%`,
    });

    // Factor 2: Daily budget usage (25% weight)
    const dailyTotal = this.getDailySpending(agentId);
    const dailyRatio = (dailyTotal + intent.amountSol) / tier.maxDailySol;
    const dailyScore = Math.min(100, Math.round(dailyRatio * 100));
    factors.push({
      name: "daily_budget",
      score: dailyScore,
      weight: 0.25,
      detail: `${(dailyTotal + intent.amountSol).toFixed(2)} SOL / ${tier.maxDailySol} SOL daily = ${(dailyRatio * 100).toFixed(0)}%`,
    });

    // Factor 3: Transaction type risk (20% weight)
    const typeScores: Record<string, number> = {
      swap: 20,
      transfer: 60,
      stake: 30,
      unstake: 40,
      unknown: 80,
    };
    const typeScore = typeScores[intent.type] ?? typeScores.unknown;
    factors.push({
      name: "tx_type",
      score: typeScore,
      weight: 0.2,
      detail: `Transaction type "${intent.type}" base risk: ${typeScore}`,
    });

    // Factor 4: Time-of-day deviation (10% weight)
    const hour = new Date().getHours();
    const isOffHours = hour < 6 || hour > 22;
    const timeScore = isOffHours ? 70 : 10;
    factors.push({
      name: "time_of_day",
      score: timeScore,
      weight: 0.1,
      detail: isOffHours
        ? `Off-hours trading (${hour}:00)`
        : `Normal hours (${hour}:00)`,
    });

    // Factor 5: Recent failure rate (15% weight)
    const recentFailures = this.getRecentFailureRate(agentId);
    const failureScore = Math.min(100, Math.round(recentFailures * 200));
    factors.push({
      name: "failure_rate",
      score: failureScore,
      weight: 0.15,
      detail: `Recent failure rate: ${(recentFailures * 100).toFixed(0)}%`,
    });

    // Calculate weighted total
    const totalScore = Math.round(
      factors.reduce((sum, f) => sum + f.score * f.weight, 0)
    );

    // Determine routing based on tier thresholds
    let route: ApprovalRoute;
    if (totalScore < tier.autoApproveRiskThreshold) {
      route = "auto_approve";
    } else if (totalScore < tier.requiresApprovalAbove) {
      route = "delayed";
    } else {
      route = "requires_approval";
    }

    return { score: totalScore, route, factors };
  }

  /**
   * Queue a transaction for approval.
   */
  enqueue(
    agentId: string,
    intent: TransactionIntent,
    riskScore: number
  ): string {
    const id = uuidv4();
    const db = getDb();
    db.prepare(
      "INSERT INTO tx_queue (id, agent_id, intent, risk_score, status) VALUES (?, ?, ?, ?, 'pending')"
    ).run(id, agentId, JSON.stringify(intent), riskScore);
    return id;
  }

  /**
   * Approve a queued transaction.
   */
  approve(txId: string): QueuedTransaction | null {
    const db = getDb();
    db.prepare(
      "UPDATE tx_queue SET status = 'approved', resolved_at = unixepoch(), resolution = 'human_approved' WHERE id = ? AND status = 'pending'"
    ).run(txId);
    return this.getTransaction(txId);
  }

  /**
   * Reject a queued transaction.
   */
  reject(txId: string, reason?: string): void {
    const db = getDb();
    db.prepare(
      "UPDATE tx_queue SET status = 'rejected', resolved_at = unixepoch(), resolution = ? WHERE id = ? AND status = 'pending'"
    ).run(reason ?? "human_rejected", txId);
  }

  /**
   * Mark a transaction as executed.
   */
  markExecuted(txId: string, txSignature: string): void {
    const db = getDb();
    db.prepare(
      "UPDATE tx_queue SET status = 'executed', resolved_at = unixepoch(), resolution = ? WHERE id = ?"
    ).run(`executed:${txSignature}`, txId);
  }

  /**
   * Expire old pending transactions.
   */
  expireOld(): number {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - APPROVAL_TIMEOUT_MS / 1000;
    const result = db
      .prepare(
        "UPDATE tx_queue SET status = 'expired', resolved_at = unixepoch(), resolution = 'timeout' WHERE status = 'pending' AND created_at < ?"
      )
      .run(cutoff);
    return result.changes;
  }

  /**
   * Get a specific transaction.
   */
  getTransaction(txId: string): QueuedTransaction | null {
    const db = getDb();
    const row = db.prepare("SELECT * FROM tx_queue WHERE id = ?").get(txId) as
      | any
      | undefined;
    if (!row) return null;
    return {
      ...row,
      intent: JSON.parse(row.intent),
    };
  }

  /**
   * Get all pending transactions for an agent.
   */
  getPending(agentId: string): QueuedTransaction[] {
    const db = getDb();
    const rows = db
      .prepare(
        "SELECT * FROM tx_queue WHERE agent_id = ? AND status = 'pending' ORDER BY created_at DESC"
      )
      .all(agentId) as any[];
    return rows.map((r) => ({ ...r, intent: JSON.parse(r.intent) }));
  }

  /**
   * Get daily SOL spending for today.
   */
  private getDailySpending(agentId: string): number {
    const db = getDb();
    const today = new Date().toISOString().split("T")[0];
    const row = db
      .prepare(
        "SELECT total_lamports FROM daily_spending WHERE agent_id = ? AND date = ?"
      )
      .get(agentId, today) as { total_lamports: number } | undefined;
    return row ? row.total_lamports / 1_000_000_000 : 0;
  }

  /**
   * Record spending for today.
   */
  recordSpending(agentId: string, lamports: number): void {
    const db = getDb();
    const today = new Date().toISOString().split("T")[0];
    db.prepare(
      `INSERT INTO daily_spending (agent_id, date, total_lamports, tx_count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(agent_id, date) DO UPDATE SET
       total_lamports = total_lamports + excluded.total_lamports,
       tx_count = tx_count + 1`
    ).run(agentId, today, lamports);
  }

  /**
   * Get recent failure rate (last 24h).
   */
  private getRecentFailureRate(agentId: string): number {
    const db = getDb();
    const stats = db
      .prepare(
        `SELECT
          COUNT(*) as total,
          SUM(CASE WHEN event_type IN ('tx_blocked', 'policy_violation') THEN 1 ELSE 0 END) as failures
        FROM trust_log
        WHERE agent_id = ? AND timestamp > unixepoch() - 86400`
      )
      .get(agentId) as { total: number; failures: number };

    if (stats.total === 0) return 0;
    return stats.failures / stats.total;
  }
}
