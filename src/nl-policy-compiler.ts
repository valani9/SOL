import Anthropic from "@anthropic-ai/sdk";
import { PolicyEngine } from "./policy-engine";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

// Well-known Solana program IDs
const KNOWN_PROGRAMS: Record<string, string> = {
  jupiter: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  raydium: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  orca: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  marinade: "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD",
  "system-program": "11111111111111111111111111111111",
  "token-program": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
};

export interface CompiledPolicy {
  cedarPolicies: string[];
  swigActions: SwigActionConfig;
  entityGroups: EntityGroupConfig[];
  explanation: string;
  nlDescription: string;
}

export interface SwigActionConfig {
  solRecurringLimit?: {
    recurringAmount: bigint;
    window: bigint;
  };
  programLimits?: string[]; // program public keys
  solLimit?: bigint;
}

export interface EntityGroupConfig {
  entityType: string;
  entityId: string;
  members: string[];
}

const SYSTEM_PROMPT = `You are a policy compiler that converts natural language rules into Cedar policies and Swig wallet configurations for Solana AI agents.

You produce JSON output with this exact structure:
{
  "cedarPolicies": ["...cedar policy text..."],
  "swigActions": {
    "solRecurringLimit": { "amount_sol": 5, "window_hours": 24 },
    "programLimits": ["jupiter", "raydium"],
    "solLimit": null
  },
  "entityGroups": [
    { "entityType": "ProgramGroup", "entityId": "approved-dexes", "members": ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"] }
  ],
  "explanation": "Human-readable summary of what was configured"
}

Cedar policy rules:
- Use Agent::"AGENT_ID" as principal (will be replaced with actual agent ID)
- Actions: "swap", "transfer", "stake", "unstake"
- Resources: Program::"<address>" for specific programs
- Context attributes: amount_sol (number), daily_total_sol (number), hour_of_day (0-23), destination (string), token_mint (string), portfolio_concentration (0-1)
- Group membership: resource in ProgramGroup::"group-name"
- Use "permit" for allow rules and "forbid" for deny rules

Known Solana programs:
- Jupiter (DEX aggregator): JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4
- Raydium (DEX): 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
- Orca (DEX): whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc
- Marinade (Staking): MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD

Important:
- Always output valid Cedar policy syntax
- For spending limits, create both a Cedar context check AND a swigActions entry
- For program restrictions, create both a Cedar ProgramGroup check AND a swigActions.programLimits entry
- Default to "forbid" for anything not explicitly permitted
- Return ONLY valid JSON, no markdown`;

export class NLPolicyCompiler {
  private anthropic: Anthropic;
  private policyEngine: PolicyEngine;

  constructor(apiKey: string, policyEngine: PolicyEngine) {
    this.anthropic = new Anthropic({ apiKey });
    this.policyEngine = policyEngine;
  }

  /**
   * Compile natural language policy description into Cedar policies + Swig config.
   */
  async compile(
    agentId: string,
    naturalLanguage: string,
    existingPolicies?: string[]
  ): Promise<CompiledPolicy> {
    const existingContext = existingPolicies?.length
      ? `\n\nExisting policies already in effect:\n${existingPolicies.join("\n---\n")}`
      : "";

    const response = await this.anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Agent ID: ${agentId}\n\nNatural language policy:\n"${naturalLanguage}"${existingContext}\n\nCompile this into Cedar policies and Swig configuration. Return ONLY the JSON.`,
        },
      ],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Parse the JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Failed to parse policy compiler output");
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Replace AGENT_ID placeholders
    const cedarPolicies = parsed.cedarPolicies.map((p: string) =>
      p.replace(/AGENT_ID/g, agentId)
    );

    // Convert Swig actions to proper types
    const swigActions: SwigActionConfig = {};
    if (parsed.swigActions.solRecurringLimit) {
      const limit = parsed.swigActions.solRecurringLimit;
      swigActions.solRecurringLimit = {
        recurringAmount: BigInt(
          Math.round((limit.amount_sol || 0) * LAMPORTS_PER_SOL)
        ),
        window: BigInt(Math.round((limit.window_hours || 24) * 900)), // ~900 slots/hour
      };
    }

    if (parsed.swigActions.programLimits) {
      swigActions.programLimits = parsed.swigActions.programLimits.map(
        (name: string) =>
          KNOWN_PROGRAMS[name.toLowerCase()] || name
      );
    }

    if (parsed.swigActions.solLimit) {
      swigActions.solLimit = BigInt(
        Math.round(parsed.swigActions.solLimit * LAMPORTS_PER_SOL)
      );
    }

    return {
      cedarPolicies,
      swigActions,
      entityGroups: parsed.entityGroups || [],
      explanation: parsed.explanation || "Policy compiled successfully",
      nlDescription: naturalLanguage,
    };
  }

  /**
   * Apply a compiled policy to the agent.
   */
  applyPolicy(agentId: string, compiled: CompiledPolicy): string[] {
    const policyIds: string[] = [];

    // Add Cedar policies
    for (const cedarText of compiled.cedarPolicies) {
      const id = this.policyEngine.addPolicy(
        agentId,
        cedarText,
        compiled.nlDescription
      );
      policyIds.push(id);
    }

    // Add entity groups
    for (const group of compiled.entityGroups) {
      this.policyEngine.addEntityGroup(
        agentId,
        group.entityType,
        group.entityId,
        group.members
      );
    }

    return policyIds;
  }

  /**
   * Generate a human-readable diff of what will change.
   */
  generateDiff(
    compiled: CompiledPolicy,
    existingPolicies: string[]
  ): string {
    const lines: string[] = [];

    lines.push("=== Policy Changes ===\n");

    if (compiled.cedarPolicies.length > 0) {
      lines.push("ADDING Cedar Rules:");
      for (const policy of compiled.cedarPolicies) {
        lines.push(`  + ${policy.split("\n")[0]}...`);
      }
      lines.push("");
    }

    if (compiled.swigActions.solRecurringLimit) {
      const sol =
        Number(compiled.swigActions.solRecurringLimit.recurringAmount) /
        LAMPORTS_PER_SOL;
      const hours =
        Number(compiled.swigActions.solRecurringLimit.window) / 900;
      lines.push(
        `SWIG On-Chain Limit: ${sol} SOL per ${hours.toFixed(0)} hours`
      );
    }

    if (compiled.swigActions.programLimits?.length) {
      lines.push(
        `SWIG Allowed Programs: ${compiled.swigActions.programLimits.join(", ")}`
      );
    }

    if (compiled.entityGroups.length > 0) {
      lines.push("\nEntity Groups:");
      for (const group of compiled.entityGroups) {
        lines.push(
          `  + ${group.entityType}::"${group.entityId}" with ${group.members.length} members`
        );
      }
    }

    lines.push(`\n${compiled.explanation}`);

    return lines.join("\n");
  }
}
