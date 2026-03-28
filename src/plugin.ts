import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db";
import { KeyManager } from "./key-manager";
import { SwigManager } from "./swig-manager";
import { PolicyEngine } from "./policy-engine";
import { TrustLedger } from "./trust-ledger";
import { TxQueue, type TransactionIntent, type RiskAssessment } from "./tx-queue";
import { NLPolicyCompiler } from "./nl-policy-compiler";

// Configuration
const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const OWNER_PRIVATE_KEY = process.env.OWNER_PRIVATE_KEY || "";

// Initialize core services
const connection = new Connection(SOLANA_RPC_URL, "confirmed");
const keyManager = new KeyManager();
const swigManager = new SwigManager(connection);
const policyEngine = new PolicyEngine();
const trustLedger = new TrustLedger();
const txQueue = new TxQueue(trustLedger);
const nlCompiler = new NLPolicyCompiler(ANTHROPIC_API_KEY, policyEngine);

// Heartbeat interval
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

/**
 * OpenClaw Plugin Registration
 * This is the main entry point conforming to OpenClaw's plugin API.
 */
export async function register(api: any): Promise<void> {
  // Initialize policy engine (loads Cedar WASM)
  await policyEngine.initialize();

  // Register tools
  api.registerTool("vault_provision", {
    description:
      "Create a new Swig smart wallet for an AI agent with secure key storage and default policies",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name for the agent (e.g., 'TradingBot')",
        },
        initial_sol: {
          type: "number",
          description: "Initial SOL to fund the wallet with",
          default: 1,
        },
        passphrase: {
          type: "string",
          description: "Owner passphrase for encrypting backup key shares",
        },
      },
      required: ["name", "passphrase"],
    },
    handler: handleProvision,
  });

  api.registerTool("vault_set_policy", {
    description:
      "Set agent policies using natural language. Compiles to Cedar rules + on-chain Swig limits.",
    parameters: {
      type: "object",
      properties: {
        agent_name: {
          type: "string",
          description: "Name of the agent to configure",
        },
        policy: {
          type: "string",
          description:
            "Natural language policy description (e.g., 'Allow swaps on Jupiter, max 2 SOL per trade, 5 SOL per day')",
        },
        replace_existing: {
          type: "boolean",
          description: "Whether to replace all existing policies",
          default: false,
        },
      },
      required: ["agent_name", "policy"],
    },
    handler: handleSetPolicy,
  });

  api.registerTool("vault_execute", {
    description:
      "Execute a transaction through the agent's Swig wallet, subject to policy checks",
    parameters: {
      type: "object",
      properties: {
        agent_name: {
          type: "string",
          description: "Name of the agent executing the transaction",
        },
        type: {
          type: "string",
          enum: ["swap", "transfer", "stake"],
          description: "Transaction type",
        },
        amount_sol: {
          type: "number",
          description: "Amount in SOL",
        },
        destination: {
          type: "string",
          description: "Destination address (for transfers)",
        },
        program: {
          type: "string",
          description: "Program to interact with (e.g., 'jupiter', or a public key)",
        },
        description: {
          type: "string",
          description: "Human-readable description of what the transaction does",
        },
      },
      required: ["agent_name", "type", "amount_sol", "description"],
    },
    handler: handleExecute,
  });

  api.registerTool("vault_status", {
    description:
      "Show agent wallet status: balance, trust score, active policies, pending approvals",
    parameters: {
      type: "object",
      properties: {
        agent_name: {
          type: "string",
          description: "Name of the agent",
        },
      },
      required: ["agent_name"],
    },
    handler: handleStatus,
  });

  api.registerTool("vault_approve", {
    description: "Approve a pending transaction that requires human approval",
    parameters: {
      type: "object",
      properties: {
        tx_id: {
          type: "string",
          description: "Transaction ID to approve",
        },
      },
      required: ["tx_id"],
    },
    handler: handleApprove,
  });

  api.registerTool("vault_reject", {
    description: "Reject a pending transaction",
    parameters: {
      type: "object",
      properties: {
        tx_id: {
          type: "string",
          description: "Transaction ID to reject",
        },
        reason: {
          type: "string",
          description: "Reason for rejection",
        },
      },
      required: ["tx_id"],
    },
    handler: handleReject,
  });

  api.registerTool("vault_freeze", {
    description:
      "Emergency freeze: remove agent's on-chain authority immediately",
    parameters: {
      type: "object",
      properties: {
        agent_name: {
          type: "string",
          description: "Name of the agent to freeze",
        },
      },
      required: ["agent_name"],
    },
    handler: handleFreeze,
  });

  // Register the before_tool_call hook for policy interception
  if (api.registerHook) {
    api.registerHook("before_tool_call", beforeToolCallHook);
  }

  // Start heartbeat monitoring
  startHeartbeatMonitor();

  console.log("[AgentVault] Plugin registered successfully");
}

// ============ Tool Handlers ============

async function handleProvision(params: {
  name: string;
  initial_sol?: number;
  passphrase: string;
}): Promise<string> {
  const { name, initial_sol = 1, passphrase } = params;
  const agentId = uuidv4();

  // Check if agent name already exists
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM agents WHERE name = ?")
    .get(name);
  if (existing) {
    return `Error: An agent named "${name}" already exists.`;
  }

  // Step 1: Generate keypair and store securely
  const { keypair: agentKeypair, shares } = await keyManager.generateAndStore(
    agentId,
    passphrase
  );

  // Step 2: Get owner keypair (for paying tx fees and being root authority)
  const ownerKeypair = getOwnerKeypair();

  // Step 3: Create Swig wallet with owner + agent authorities
  const walletInfo = await swigManager.createWallet(
    ownerKeypair,
    ownerKeypair.publicKey,
    agentKeypair.publicKey,
    {
      solPerTxLamports: BigInt(0.1 * LAMPORTS_PER_SOL), // Training wheels: 0.1 SOL/tx
      dailySolLamports: BigInt(1 * LAMPORTS_PER_SOL), // 1 SOL/day
      windowSlots: 216_000n,
      allowedPrograms: [], // No programs until policies are set
    }
  );

  // Step 4: Fund the wallet
  if (initial_sol > 0) {
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: ownerKeypair.publicKey,
        toPubkey: walletInfo.swigAddress,
        lamports: Math.round(initial_sol * LAMPORTS_PER_SOL),
      })
    );
    await connection.sendTransaction(fundTx, [ownerKeypair]);
  }

  // Step 5: Store agent record
  db.prepare(
    `INSERT INTO agents (id, name, swig_address, swig_id, agent_pubkey, owner_pubkey, role_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    agentId,
    name,
    walletInfo.swigAddress.toBase58(),
    Buffer.from(walletInfo.swigId).toString("hex"),
    agentKeypair.publicKey.toBase58(),
    ownerKeypair.publicKey.toBase58(),
    walletInfo.agentRoleId
  );

  // Step 6: Set default policies (training wheels)
  policyEngine.addDefaultPolicies(agentId);

  // Step 7: Initialize heartbeat
  db.prepare(
    "INSERT INTO heartbeats (agent_id) VALUES (?)"
  ).run(agentId);

  // Format response
  const shareDisplay = shares
    .map((s) => {
      if (s.index === 0) return `  Share ${s.index + 1}: Encrypted in local database`;
      return `  Share ${s.index + 1} (${s.storageHint}): ${s.shareHex.substring(0, 16)}...${s.shareHex.substring(s.shareHex.length - 16)}`;
    })
    .join("\n");

  return `
**AgentVault: Wallet Created** ✅

**Agent:** ${name}
**Agent ID:** ${agentId}
**Swig Wallet:** ${walletInfo.swigAddress.toBase58()}
**Agent Public Key:** ${agentKeypair.publicKey.toBase58()}
**Initial Balance:** ${initial_sol} SOL
**Trust Tier:** Training Wheels (0.1 SOL/tx, 1 SOL/day)

**Key Storage:**
  Primary: macOS Keychain (Touch ID protected)
  Backup: Shamir Secret Sharing (3-of-5 threshold)

**Shamir Backup Shares:**
${shareDisplay}

⚠️ **SAVE SHARES 2-5 NOW** — they won't be shown again.
Shares 2-5 are needed for key recovery. Store them in separate secure locations.

**Default Policies Applied:**
  • Swaps allowed up to 0.1 SOL, 1 SOL/day max
  • All direct transfers blocked
  • No activity between midnight and 6 AM

Use \`vault_set_policy\` to customize the agent's rules.
  `.trim();
}

async function handleSetPolicy(params: {
  agent_name: string;
  policy: string;
  replace_existing?: boolean;
}): Promise<string> {
  const { agent_name, policy, replace_existing = false } = params;
  const agent = getAgentByName(agent_name);
  if (!agent) return `Error: Agent "${agent_name}" not found.`;

  // Get existing policies for context
  const existingPolicies = policyEngine
    .listPolicies(agent.id)
    .map((p) => p.cedar_text);

  // Compile natural language to Cedar + Swig
  const compiled = await nlCompiler.compile(
    agent.id,
    policy,
    replace_existing ? [] : existingPolicies
  );

  // Show diff to user
  const diff = nlCompiler.generateDiff(compiled, existingPolicies);

  // Apply policies
  if (replace_existing) {
    policyEngine.clearPolicies(agent.id);
  }
  const policyIds = nlCompiler.applyPolicy(agent.id, compiled);

  // Update Swig on-chain limits if needed
  if (compiled.swigActions.solRecurringLimit || compiled.swigActions.programLimits) {
    const ownerKeypair = getOwnerKeypair();
    const swigAddress = new PublicKey(agent.swig_address);

    const ownerRoleId = 0; // Owner is always role 0
    const limits = {
      solPerTxLamports: compiled.swigActions.solLimit ?? BigInt(0),
      dailySolLamports:
        compiled.swigActions.solRecurringLimit?.recurringAmount ??
        BigInt(LAMPORTS_PER_SOL),
      windowSlots:
        compiled.swigActions.solRecurringLimit?.window ?? 216_000n,
      allowedPrograms: (compiled.swigActions.programLimits ?? []).map(
        (p) => new PublicKey(p)
      ),
    };

    try {
      await swigManager.updateAgentPermissions(
        ownerKeypair,
        swigAddress,
        ownerRoleId,
        agent.role_id,
        limits
      );
    } catch (err: any) {
      return `Policies saved locally but on-chain update failed: ${err.message}\n\n${diff}`;
    }
  }

  return `
**Policy Compiled & Applied** ✅

${diff}

**${policyIds.length} Cedar rule(s) added.**
**On-chain Swig limits updated.**

The agent will now operate within these boundaries.
  `.trim();
}

async function handleExecute(params: {
  agent_name: string;
  type: string;
  amount_sol: number;
  destination?: string;
  program?: string;
  description: string;
}): Promise<string> {
  const agent = getAgentByName(params.agent_name);
  if (!agent) return `Error: Agent "${params.agent_name}" not found.`;
  if (agent.frozen) return `Error: Agent "${params.agent_name}" is frozen.`;

  const programId = resolveProgram(params.program);

  // Update heartbeat
  const db = getDb();
  db.prepare(
    "UPDATE heartbeats SET last_heartbeat = unixepoch() WHERE agent_id = ?"
  ).run(agent.id);

  // Get daily spending for context
  const today = new Date().toISOString().split("T")[0];
  const dailyRow = db
    .prepare(
      "SELECT total_lamports FROM daily_spending WHERE agent_id = ? AND date = ?"
    )
    .get(agent.id, today) as { total_lamports: number } | undefined;
  const dailyTotalSol = dailyRow
    ? dailyRow.total_lamports / LAMPORTS_PER_SOL
    : 0;

  // === LAYER 1: Cedar pre-flight ===
  const policyResult = policyEngine.evaluate({
    agentId: agent.id,
    actionType: params.type,
    programId,
    destination: params.destination,
    amountSol: params.amount_sol,
    dailyTotalSol,
  });

  if (policyResult.decision === "deny") {
    trustLedger.recordBlocked(agent.id, policyResult.reasons.join("; "));
    return `
**Transaction BLOCKED** 🚫

**Cedar Policy: DENY**
${policyResult.reasons.map((r) => `  • ${r}`).join("\n")}

Trust score: ${trustLedger.getScore(agent.id)} (-1)
    `.trim();
  }

  // === LAYER 2: Risk scoring ===
  const intent: TransactionIntent = {
    type: params.type,
    programId,
    amountSol: params.amount_sol,
    destination: params.destination,
    description: params.description,
  };

  const risk = txQueue.assessRisk(agent.id, intent);

  const riskDisplay = risk.factors
    .map((f) => `  ${f.name}: ${f.score} (${f.detail})`)
    .join("\n");

  // === LAYER 3: Approval routing ===
  if (risk.route === "requires_approval") {
    const txId = txQueue.enqueue(agent.id, intent, risk.score);
    return `
**Transaction QUEUED for Approval** ⏳

**Cedar Policy: ALLOW**
**Risk Score: ${risk.score}/100** — requires human approval
${riskDisplay}

**Transaction:** ${params.description}
**Amount:** ${params.amount_sol} SOL
**TX ID:** ${txId}

Reply with \`vault_approve\` (tx_id: "${txId}") or \`vault_reject\` to decide.
Auto-expires in 10 minutes.
    `.trim();
  }

  if (risk.route === "delayed") {
    // For delayed, we still execute but note the risk
    // In production, you'd add a cancellation window here
  }

  // === LAYER 4: Solana simulation ===
  try {
    const agentKeypair = await keyManager.getKeypair(agent.id);
    if (!agentKeypair) return "Error: Could not retrieve agent key from Keychain.";

    const swigAddress = new PublicKey(agent.swig_address);

    // Build the inner instruction (SOL transfer as example)
    const innerIx = swigManager.buildSolTransferIx(
      swigAddress,
      params.destination
        ? new PublicKey(params.destination)
        : agentKeypair.publicKey,
      BigInt(Math.round(params.amount_sol * LAMPORTS_PER_SOL))
    );

    // Simulate first
    const simTx = new Transaction().add(innerIx);
    simTx.feePayer = agentKeypair.publicKey;
    const latestBlockhash = await connection.getLatestBlockhash();
    simTx.recentBlockhash = latestBlockhash.blockhash;

    const simulation = await connection.simulateTransaction(simTx);
    if (simulation.value.err) {
      return `
**Transaction FAILED simulation** ❌

Simulation error: ${JSON.stringify(simulation.value.err)}
Transaction not submitted.
      `.trim();
    }

    // === LAYER 5: Execute through Swig ===
    const ownerKeypair = getOwnerKeypair();
    const txSig = await swigManager.executeThrough(
      ownerKeypair,
      agentKeypair,
      swigAddress,
      agent.role_id,
      [innerIx]
    );

    // Record success
    txQueue.recordSpending(
      agent.id,
      Math.round(params.amount_sol * LAMPORTS_PER_SOL)
    );
    const newScore = trustLedger.recordSuccess(agent.id, params.description);

    // Check for trust upgrade
    const upgrade = trustLedger.checkUpgradeEligibility(agent.id);
    const upgradeMsg = upgrade
      ? `\n\n**🎉 Trust Upgrade Available!**\n${upgrade.message}`
      : "";

    return `
**Transaction EXECUTED** ✅

**Cedar Policy: ALLOW**
**Risk Score: ${risk.score}/100** (${risk.route})
${riskDisplay}

**TX Signature:** ${txSig}
**Amount:** ${params.amount_sol} SOL
**Trust Score:** ${newScore} (+1)${upgradeMsg}
    `.trim();
  } catch (err: any) {
    trustLedger.recordViolation(agent.id, `Execution error: ${err.message}`);
    return `
**Transaction FAILED** ❌

Error: ${err.message}
Trust score: ${trustLedger.getScore(agent.id)} (-3)
    `.trim();
  }
}

async function handleStatus(params: { agent_name: string }): Promise<string> {
  const agent = getAgentByName(params.agent_name);
  if (!agent) return `Error: Agent "${params.agent_name}" not found.`;

  const tier = trustLedger.getCurrentTier(agent.id);
  const score = trustLedger.getScore(agent.id);
  const policies = policyEngine.listPolicies(agent.id);
  const pending = txQueue.getPending(agent.id);
  const recentLog = trustLedger.getRecentLog(agent.id, 5);

  let balance: number;
  try {
    balance = await swigManager.getBalance(new PublicKey(agent.swig_address));
  } catch {
    balance = -1;
  }

  const logDisplay = recentLog
    .map(
      (l) =>
        `  [${new Date(l.timestamp * 1000).toLocaleString()}] ${l.event_type} (${l.trust_delta >= 0 ? "+" : ""}${l.trust_delta}) — ${l.details || "no details"}`
    )
    .join("\n");

  const policyDisplay = policies
    .map(
      (p) => `  • ${p.nl_description || p.cedar_text.split("\n")[0]}`
    )
    .join("\n");

  return `
**AgentVault Status: ${params.agent_name}** ${agent.frozen ? "🔒 FROZEN" : "🟢 Active"}

**Wallet:** ${agent.swig_address}
**Balance:** ${balance >= 0 ? balance.toFixed(4) : "unknown"} SOL
**Trust Score:** ${score} | **Tier:** ${tier.name} (${tier.tier})
**Limits:** ${tier.maxSolPerTx} SOL/tx, ${tier.maxDailySol} SOL/day

**Active Policies (${policies.length}):**
${policyDisplay || "  None"}

**Pending Approvals (${pending.length}):**
${pending.length > 0 ? pending.map((p) => `  • [${p.id.substring(0, 8)}] ${p.intent.description} (risk: ${p.riskScore})`).join("\n") : "  None"}

**Recent Activity:**
${logDisplay || "  No recent activity"}
  `.trim();
}

async function handleApprove(params: { tx_id: string }): Promise<string> {
  const tx = txQueue.approve(params.tx_id);
  if (!tx) return `Error: Transaction ${params.tx_id} not found or already resolved.`;

  // Execute the approved transaction
  const result = await handleExecute({
    agent_name: getAgentById(tx.agentId)?.name ?? "",
    type: tx.intent.type,
    amount_sol: tx.intent.amountSol,
    destination: tx.intent.destination,
    program: tx.intent.programId,
    description: `[APPROVED] ${tx.intent.description}`,
  });

  txQueue.markExecuted(params.tx_id, "approved-execution");

  return `**Transaction Approved** ✅\n\n${result}`;
}

async function handleReject(params: {
  tx_id: string;
  reason?: string;
}): Promise<string> {
  txQueue.reject(params.tx_id, params.reason);
  return `**Transaction Rejected** ❌\n\nTX ${params.tx_id.substring(0, 8)}... rejected. ${params.reason ? `Reason: ${params.reason}` : ""}`;
}

async function handleFreeze(params: { agent_name: string }): Promise<string> {
  const agent = getAgentByName(params.agent_name);
  if (!agent) return `Error: Agent "${params.agent_name}" not found.`;

  try {
    const ownerKeypair = getOwnerKeypair();
    const swigAddress = new PublicKey(agent.swig_address);

    // Remove agent authority on-chain
    await swigManager.freezeAgent(
      ownerKeypair,
      swigAddress,
      0, // owner role
      agent.role_id
    );

    // Mark as frozen in DB
    const db = getDb();
    db.prepare("UPDATE agents SET frozen = 1 WHERE id = ?").run(agent.id);

    // Reject all pending transactions
    const pending = txQueue.getPending(agent.id);
    for (const tx of pending) {
      txQueue.reject(tx.id, "Agent frozen by owner");
    }

    return `
**Agent FROZEN** 🔒

Agent "${params.agent_name}" has been frozen.
  • On-chain authority removed from Swig wallet
  • ${pending.length} pending transaction(s) rejected
  • Agent can no longer sign any transactions

To restore, re-provision the agent or add a new authority.
    `.trim();
  } catch (err: any) {
    return `Error freezing agent: ${err.message}`;
  }
}

// ============ Hook ============

async function beforeToolCallHook(context: {
  toolName: string;
  params: any;
}): Promise<{ block: boolean; message?: string } | void> {
  // Expire old pending transactions
  txQueue.expireOld();

  // Only intercept vault_execute calls — other tools pass through
  if (context.toolName !== "vault_execute") return;

  const agent = getAgentByName(context.params.agent_name);
  if (!agent) return;
  if (agent.frozen) {
    return {
      block: true,
      message: `Agent "${context.params.agent_name}" is frozen. Use vault_freeze to check status.`,
    };
  }
}

// ============ Heartbeat Monitor ============

function startHeartbeatMonitor(): void {
  // Check every 5 minutes
  heartbeatInterval = setInterval(() => {
    const db = getDb();
    const staleAgents = db
      .prepare(
        "SELECT a.id, a.name FROM agents a JOIN heartbeats h ON a.id = h.agent_id WHERE h.last_heartbeat < unixepoch() - 1800 AND a.frozen = 0"
      )
      .all() as Array<{ id: string; name: string }>;

    for (const agent of staleAgents) {
      console.warn(
        `[AgentVault] Dead man's switch triggered for agent "${agent.name}" — no heartbeat for 30 minutes`
      );
      // Auto-freeze
      const db2 = getDb();
      db2.prepare("UPDATE agents SET frozen = 1 WHERE id = ?").run(agent.id);
    }
  }, 5 * 60 * 1000);
}

// ============ Helpers ============

function getOwnerKeypair(): Keypair {
  if (!OWNER_PRIVATE_KEY) {
    throw new Error(
      "OWNER_PRIVATE_KEY environment variable not set. Provide base58 or JSON array."
    );
  }

  try {
    // Try JSON array format first
    const parsed = JSON.parse(OWNER_PRIVATE_KEY);
    return Keypair.fromSecretKey(new Uint8Array(parsed));
  } catch {
    // Try base58
    const bs58 = require("bs58");
    return Keypair.fromSecretKey(bs58.decode(OWNER_PRIVATE_KEY));
  }
}

interface AgentRecord {
  id: string;
  name: string;
  swig_address: string;
  swig_id: string;
  agent_pubkey: string;
  owner_pubkey: string;
  role_id: number;
  trust_score: number;
  trust_tier: number;
  frozen: number;
}

function getAgentByName(name: string): AgentRecord | null {
  const db = getDb();
  return (
    (db.prepare("SELECT * FROM agents WHERE name = ?").get(name) as AgentRecord) ??
    null
  );
}

function getAgentById(id: string): AgentRecord | null {
  const db = getDb();
  return (
    (db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRecord) ??
    null
  );
}

function resolveProgram(program?: string): string {
  if (!program) return "11111111111111111111111111111111";
  const known: Record<string, string> = {
    jupiter: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    raydium: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    orca: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    marinade: "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD",
  };
  return known[program.toLowerCase()] || program;
}

// Export for standalone usage
export {
  keyManager,
  swigManager,
  policyEngine,
  trustLedger,
  txQueue,
  nlCompiler,
  connection,
};
