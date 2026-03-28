import { getDb } from "./db";
import { v4 as uuidv4 } from "uuid";

// Cedar WASM types (synchronous API)
interface CedarAuthorizationCall {
  principal: { type: string; id: string };
  action: { type: string; id: string };
  resource: { type: string; id: string };
  context: Record<string, any>;
  policies: { staticPolicies: string };
  entities: Array<{
    uid: { type: string; id: string };
    attrs: Record<string, any>;
    parents: Array<{ type: string; id: string }>;
  }>;
}

interface CedarAuthorizationResult {
  type: "success" | "failure";
  response?: {
    decision: "allow" | "deny";
    diagnostics: {
      reason: string[];
      errors: Array<{ message: string }>;
    };
  };
  errors?: Array<{ message: string }>;
  warnings?: Array<{ message: string }>;
}

export interface PolicyEvalRequest {
  agentId: string;
  actionType: string; // "swap", "transfer", "stake", etc.
  programId: string;
  destination?: string;
  amountSol: number;
  tokenMint?: string;
  hourOfDay?: number;
  dailyTotalSol?: number;
  portfolioConcentration?: number;
}

export interface PolicyEvalResult {
  decision: "allow" | "deny";
  reasons: string[];
  matchedPolicies: string[];
}

export interface PolicyRecord {
  id: string;
  agent_id: string;
  cedar_text: string;
  nl_description: string | null;
  created_at: number;
  active: number;
}

export class PolicyEngine {
  private cedar: any = null;

  async initialize(): Promise<void> {
    // Dynamic import for ESM cedar-wasm
    this.cedar = await import("@cedar-policy/cedar-wasm");
  }

  /**
   * Evaluate a transaction request against all active policies for an agent.
   */
  evaluate(request: PolicyEvalRequest): PolicyEvalResult {
    if (!this.cedar) {
      throw new Error("PolicyEngine not initialized. Call initialize() first.");
    }

    const db = getDb();

    // Load all active policies for this agent
    const policies = db
      .prepare(
        "SELECT id, cedar_text FROM policies WHERE agent_id = ? AND active = 1"
      )
      .all(request.agentId) as Array<{ id: string; cedar_text: string }>;

    if (policies.length === 0) {
      // No policies = deny by default (fail-safe)
      return {
        decision: "deny",
        reasons: ["No active policies found. Default deny."],
        matchedPolicies: [],
      };
    }

    // Combine all policy texts
    const policyText = policies.map((p) => p.cedar_text).join("\n\n");

    // Load entity groups (program groups, address groups)
    const entityGroups = db
      .prepare(
        "SELECT entity_type, entity_id, members FROM policy_entities WHERE agent_id = ?"
      )
      .all(request.agentId) as Array<{
      entity_type: string;
      entity_id: string;
      members: string;
    }>;

    // Build Cedar entities
    const entities = this.buildEntities(request, entityGroups);

    // Build the context
    const context: Record<string, any> = {
      amount_sol: request.amountSol,
      daily_total_sol: request.dailyTotalSol ?? 0,
      hour_of_day: request.hourOfDay ?? new Date().getHours(),
      destination: request.destination ?? "",
      token_mint: request.tokenMint ?? "",
      portfolio_concentration: request.portfolioConcentration ?? 0,
    };

    const call: CedarAuthorizationCall = {
      principal: { type: "Agent", id: request.agentId },
      action: { type: "Action", id: request.actionType },
      resource: { type: "Program", id: request.programId },
      context,
      policies: { staticPolicies: policyText },
      entities,
    };

    const result: CedarAuthorizationResult = this.cedar.isAuthorized(call);

    if (result.type === "failure") {
      const errorMsgs =
        result.errors?.map((e) => e.message) ?? ["Unknown policy error"];
      return {
        decision: "deny",
        reasons: [`Policy evaluation error: ${errorMsgs.join("; ")}`],
        matchedPolicies: [],
      };
    }

    const decision = result.response!.decision;
    const matchedPolicies = result.response!.diagnostics.reason;
    const reasons: string[] = [];

    if (decision === "deny") {
      reasons.push(
        `Transaction denied by policy. Matched policies: ${matchedPolicies.join(", ") || "default deny"}`
      );
    }

    return {
      decision,
      reasons,
      matchedPolicies,
    };
  }

  /**
   * Build Cedar entities from policy_entities table.
   */
  private buildEntities(
    request: PolicyEvalRequest,
    entityGroups: Array<{
      entity_type: string;
      entity_id: string;
      members: string;
    }>
  ): CedarAuthorizationCall["entities"] {
    const entities: CedarAuthorizationCall["entities"] = [];

    // Add the agent entity
    entities.push({
      uid: { type: "Agent", id: request.agentId },
      attrs: {},
      parents: [],
    });

    // Add the action entity
    entities.push({
      uid: { type: "Action", id: request.actionType },
      attrs: {},
      parents: [],
    });

    // Add the program entity
    entities.push({
      uid: { type: "Program", id: request.programId },
      attrs: {},
      parents: entityGroups
        .filter((g) => {
          const members: string[] = JSON.parse(g.members);
          return members.includes(request.programId);
        })
        .map((g) => ({ type: g.entity_type, id: g.entity_id })),
    });

    // Add destination as entity if provided
    if (request.destination) {
      entities.push({
        uid: { type: "Address", id: request.destination },
        attrs: {},
        parents: entityGroups
          .filter((g) => {
            const members: string[] = JSON.parse(g.members);
            return members.includes(request.destination!);
          })
          .map((g) => ({ type: g.entity_type, id: g.entity_id })),
      });
    }

    // Add group entities
    for (const group of entityGroups) {
      entities.push({
        uid: { type: group.entity_type, id: group.entity_id },
        attrs: {
          members: JSON.parse(group.members),
        },
        parents: [],
      });
    }

    return entities;
  }

  /**
   * Add a Cedar policy for an agent.
   */
  addPolicy(
    agentId: string,
    cedarText: string,
    nlDescription?: string
  ): string {
    const id = uuidv4();
    const db = getDb();
    db.prepare(
      "INSERT INTO policies (id, agent_id, cedar_text, nl_description) VALUES (?, ?, ?, ?)"
    ).run(id, agentId, cedarText, nlDescription ?? null);
    return id;
  }

  /**
   * Add an entity group (e.g., ProgramGroup, AddressGroup).
   */
  addEntityGroup(
    agentId: string,
    entityType: string,
    entityId: string,
    members: string[]
  ): void {
    const db = getDb();
    db.prepare(
      "INSERT INTO policy_entities (agent_id, entity_type, entity_id, members) VALUES (?, ?, ?, ?)"
    ).run(agentId, entityType, entityId, JSON.stringify(members));
  }

  /**
   * Deactivate a policy.
   */
  deactivatePolicy(policyId: string): void {
    const db = getDb();
    db.prepare("UPDATE policies SET active = 0 WHERE id = ?").run(policyId);
  }

  /**
   * List active policies for an agent.
   */
  listPolicies(agentId: string): PolicyRecord[] {
    const db = getDb();
    return db
      .prepare("SELECT * FROM policies WHERE agent_id = ? AND active = 1")
      .all(agentId) as PolicyRecord[];
  }

  /**
   * Deactivate all policies for an agent.
   */
  clearPolicies(agentId: string): void {
    const db = getDb();
    db.prepare("UPDATE policies SET active = 0 WHERE agent_id = ?").run(
      agentId
    );
    db.prepare("DELETE FROM policy_entities WHERE agent_id = ?").run(agentId);
  }

  /**
   * Generate default "training wheels" policies for a new agent.
   */
  addDefaultPolicies(agentId: string): void {
    // Permit small swaps
    this.addPolicy(
      agentId,
      `permit(
  principal == Agent::"${agentId}",
  action == Action::"swap",
  resource
) when {
  context.amount_sol <= 0.1 &&
  context.daily_total_sol <= 1.0
};`,
      "Training wheels: allow swaps up to 0.1 SOL, 1 SOL/day"
    );

    // Deny all transfers by default
    this.addPolicy(
      agentId,
      `forbid(
  principal == Agent::"${agentId}",
  action == Action::"transfer",
  resource
);`,
      "Default: block all direct transfers"
    );

    // Deny outside business hours
    this.addPolicy(
      agentId,
      `forbid(
  principal == Agent::"${agentId}",
  action,
  resource
) when {
  context.hour_of_day < 6 || context.hour_of_day > 23
};`,
      "Default: no activity between midnight and 6 AM"
    );
  }
}
