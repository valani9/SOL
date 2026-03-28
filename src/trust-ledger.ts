import { getDb } from "./db";

export interface TrustTier {
  tier: number;
  name: string;
  minScore: number;
  maxSolPerTx: number;
  maxDailySol: number;
  autoApproveRiskThreshold: number;
  requiresApprovalAbove: number;
}

const TRUST_TIERS: TrustTier[] = [
  {
    tier: 0,
    name: "Training Wheels",
    minScore: 0,
    maxSolPerTx: 0.1,
    maxDailySol: 1,
    autoApproveRiskThreshold: 20,
    requiresApprovalAbove: 30,
  },
  {
    tier: 1,
    name: "Beginner",
    minScore: 10,
    maxSolPerTx: 1,
    maxDailySol: 5,
    autoApproveRiskThreshold: 30,
    requiresApprovalAbove: 50,
  },
  {
    tier: 2,
    name: "Intermediate",
    minScore: 25,
    maxSolPerTx: 5,
    maxDailySol: 25,
    autoApproveRiskThreshold: 40,
    requiresApprovalAbove: 60,
  },
  {
    tier: 3,
    name: "Advanced",
    minScore: 50,
    maxSolPerTx: 25,
    maxDailySol: 100,
    autoApproveRiskThreshold: 50,
    requiresApprovalAbove: 70,
  },
  {
    tier: 4,
    name: "Autonomous",
    minScore: 100,
    maxSolPerTx: 100,
    maxDailySol: 500,
    autoApproveRiskThreshold: 60,
    requiresApprovalAbove: 80,
  },
];

export interface TrustUpgradeProposal {
  agentId: string;
  currentTier: TrustTier;
  proposedTier: TrustTier;
  currentScore: number;
  message: string;
}

export class TrustLedger {
  /**
   * Record a successful transaction, increment trust score.
   */
  recordSuccess(agentId: string, details?: string): number {
    return this.updateScore(agentId, 1, "tx_success", details);
  }

  /**
   * Record a policy violation, decrement trust score.
   */
  recordViolation(agentId: string, details?: string): number {
    return this.updateScore(agentId, -3, "policy_violation", details);
  }

  /**
   * Record a blocked transaction (not as severe as a violation).
   */
  recordBlocked(agentId: string, details?: string): number {
    return this.updateScore(agentId, -1, "tx_blocked", details);
  }

  /**
   * Record a trust tier upgrade.
   */
  recordUpgrade(agentId: string, newTier: number): number {
    const db = getDb();
    db.prepare("UPDATE agents SET trust_tier = ? WHERE id = ?").run(
      newTier,
      agentId
    );
    return this.updateScore(agentId, 0, "trust_upgrade", `Upgraded to tier ${newTier}`);
  }

  private updateScore(
    agentId: string,
    delta: number,
    eventType: string,
    details?: string
  ): number {
    const db = getDb();

    // Get current score
    const agent = db
      .prepare("SELECT trust_score FROM agents WHERE id = ?")
      .get(agentId) as { trust_score: number } | undefined;

    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const newScore = Math.max(0, agent.trust_score + delta);

    // Update agent score
    db.prepare("UPDATE agents SET trust_score = ? WHERE id = ?").run(
      newScore,
      agentId
    );

    // Log the event
    db.prepare(
      "INSERT INTO trust_log (agent_id, event_type, details, trust_delta, trust_total) VALUES (?, ?, ?, ?, ?)"
    ).run(agentId, eventType, details ?? null, delta, newScore);

    return newScore;
  }

  /**
   * Get the current trust tier for an agent.
   */
  getCurrentTier(agentId: string): TrustTier {
    const db = getDb();
    const agent = db
      .prepare("SELECT trust_score, trust_tier FROM agents WHERE id = ?")
      .get(agentId) as
      | { trust_score: number; trust_tier: number }
      | undefined;

    if (!agent) throw new Error(`Agent ${agentId} not found`);

    return TRUST_TIERS[agent.trust_tier] || TRUST_TIERS[0];
  }

  /**
   * Get the agent's trust score.
   */
  getScore(agentId: string): number {
    const db = getDb();
    const agent = db
      .prepare("SELECT trust_score FROM agents WHERE id = ?")
      .get(agentId) as { trust_score: number } | undefined;

    if (!agent) throw new Error(`Agent ${agentId} not found`);
    return agent.trust_score;
  }

  /**
   * Check if the agent qualifies for a tier upgrade.
   */
  checkUpgradeEligibility(agentId: string): TrustUpgradeProposal | null {
    const db = getDb();
    const agent = db
      .prepare("SELECT trust_score, trust_tier FROM agents WHERE id = ?")
      .get(agentId) as
      | { trust_score: number; trust_tier: number }
      | undefined;

    if (!agent) return null;

    const currentTier = TRUST_TIERS[agent.trust_tier] || TRUST_TIERS[0];
    const nextTierIndex = agent.trust_tier + 1;

    if (nextTierIndex >= TRUST_TIERS.length) return null;

    const nextTier = TRUST_TIERS[nextTierIndex];

    if (agent.trust_score >= nextTier.minScore) {
      // Check recent violations - don't upgrade if there were violations in last 24h
      const recentViolations = db
        .prepare(
          "SELECT COUNT(*) as count FROM trust_log WHERE agent_id = ? AND event_type = 'policy_violation' AND timestamp > unixepoch() - 86400"
        )
        .get(agentId) as { count: number };

      if (recentViolations.count > 0) return null;

      return {
        agentId,
        currentTier,
        proposedTier: nextTier,
        currentScore: agent.trust_score,
        message: `Agent has earned ${agent.trust_score} trust points with no violations in the last 24 hours. ` +
          `Proposal: upgrade from "${currentTier.name}" (${currentTier.maxSolPerTx} SOL/tx, ${currentTier.maxDailySol} SOL/day) ` +
          `to "${nextTier.name}" (${nextTier.maxSolPerTx} SOL/tx, ${nextTier.maxDailySol} SOL/day).`,
      };
    }

    return null;
  }

  /**
   * Get recent trust log entries.
   */
  getRecentLog(
    agentId: string,
    limit: number = 20
  ): Array<{
    event_type: string;
    details: string | null;
    trust_delta: number;
    trust_total: number;
    timestamp: number;
  }> {
    const db = getDb();
    return db
      .prepare(
        "SELECT event_type, details, trust_delta, trust_total, timestamp FROM trust_log WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?"
      )
      .all(agentId, limit) as any[];
  }

  /**
   * Get all trust tier definitions.
   */
  getTiers(): TrustTier[] {
    return [...TRUST_TIERS];
  }
}
