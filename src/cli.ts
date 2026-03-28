#!/usr/bin/env node
/**
 * AgentVault CLI — standalone runner for testing and demos.
 * Usage:
 *   npx ts-node src/cli.ts provision --name TradingBot --sol 5 --passphrase mysecret
 *   npx ts-node src/cli.ts set-policy --agent TradingBot --policy "Allow swaps on Jupiter, max 2 SOL per trade"
 *   npx ts-node src/cli.ts execute --agent TradingBot --type swap --amount 1 --program jupiter --desc "Swap 1 SOL for USDC"
 *   npx ts-node src/cli.ts status --agent TradingBot
 *   npx ts-node src/cli.ts approve --tx-id <id>
 *   npx ts-node src/cli.ts reject --tx-id <id>
 *   npx ts-node src/cli.ts freeze --agent TradingBot
 */

import { register } from "./plugin";
import readline from "readline";

const args = process.argv.slice(2);
const command = args[0];

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

// Mock OpenClaw API for standalone mode
const mockTools: Record<string, { handler: Function }> = {};
const mockApi = {
  registerTool(name: string, config: { handler: Function }) {
    mockTools[name] = config;
  },
  registerHook(_name: string, _fn: Function) {},
};

async function main() {
  // Initialize the plugin
  await register(mockApi);

  switch (command) {
    case "provision": {
      const name = getArg("name") || "TestAgent";
      const sol = parseFloat(getArg("sol") || "1");
      const passphrase = getArg("passphrase") || "default-passphrase";
      const result = await mockTools.vault_provision.handler({
        name,
        initial_sol: sol,
        passphrase,
      });
      console.log(result);
      break;
    }

    case "set-policy": {
      const agentName = getArg("agent") || "";
      const policy = getArg("policy") || "";
      const replace = args.includes("--replace");
      const result = await mockTools.vault_set_policy.handler({
        agent_name: agentName,
        policy,
        replace_existing: replace,
      });
      console.log(result);
      break;
    }

    case "execute": {
      const agentName = getArg("agent") || "";
      const type = getArg("type") || "swap";
      const amount = parseFloat(getArg("amount") || "0");
      const dest = getArg("destination");
      const program = getArg("program");
      const desc = getArg("desc") || `${type} ${amount} SOL`;
      const result = await mockTools.vault_execute.handler({
        agent_name: agentName,
        type,
        amount_sol: amount,
        destination: dest,
        program,
        description: desc,
      });
      console.log(result);
      break;
    }

    case "status": {
      const agentName = getArg("agent") || "";
      const result = await mockTools.vault_status.handler({
        agent_name: agentName,
      });
      console.log(result);
      break;
    }

    case "approve": {
      const txId = getArg("tx-id") || "";
      const result = await mockTools.vault_approve.handler({ tx_id: txId });
      console.log(result);
      break;
    }

    case "reject": {
      const txId = getArg("tx-id") || "";
      const reason = getArg("reason");
      const result = await mockTools.vault_reject.handler({
        tx_id: txId,
        reason,
      });
      console.log(result);
      break;
    }

    case "freeze": {
      const agentName = getArg("agent") || "";
      const result = await mockTools.vault_freeze.handler({
        agent_name: agentName,
      });
      console.log(result);
      break;
    }

    case "interactive": {
      await interactiveMode();
      break;
    }

    default:
      console.log(`
AgentVault CLI — Smart Account Provisioning for OpenClaw Agents

Commands:
  provision     Create a new agent wallet
  set-policy    Set policies using natural language
  execute       Execute a transaction through the agent
  status        Show agent status
  approve       Approve a pending transaction
  reject        Reject a pending transaction
  freeze        Emergency freeze an agent
  interactive   Interactive chat mode

Examples:
  npx ts-node src/cli.ts provision --name TradingBot --sol 5 --passphrase mysecret
  npx ts-node src/cli.ts set-policy --agent TradingBot --policy "Allow swaps on Jupiter, max 2 SOL per trade"
  npx ts-node src/cli.ts execute --agent TradingBot --type swap --amount 1 --program jupiter --desc "Swap SOL for USDC"
  npx ts-node src/cli.ts status --agent TradingBot
  npx ts-node src/cli.ts freeze --agent TradingBot

Environment Variables:
  SOLANA_RPC_URL      Solana RPC endpoint (default: devnet)
  ANTHROPIC_API_KEY   Claude API key for natural language policies
  OWNER_PRIVATE_KEY   Owner wallet private key (base58 or JSON array)
      `);
  }
}

async function interactiveMode() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "agentvault> ",
  });

  console.log("AgentVault Interactive Mode. Type 'help' for commands, 'quit' to exit.\n");
  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input === "quit" || input === "exit") {
      rl.close();
      process.exit(0);
    }

    if (input === "help") {
      console.log(`
Commands:
  provision <name> [sol]           Create new agent wallet
  policy <agent> <description>     Set policy via natural language
  exec <agent> <type> <amount>     Execute transaction
  status <agent>                   Show agent status
  approve <tx_id>                  Approve pending tx
  reject <tx_id>                   Reject pending tx
  freeze <agent>                   Emergency freeze
  quit                             Exit
      `);
      rl.prompt();
      return;
    }

    const parts = input.split(/\s+/);
    const cmd = parts[0];

    try {
      switch (cmd) {
        case "provision": {
          const result = await mockTools.vault_provision.handler({
            name: parts[1] || "Agent",
            initial_sol: parseFloat(parts[2] || "1"),
            passphrase: "interactive-session",
          });
          console.log(result);
          break;
        }
        case "policy": {
          const agentName = parts[1];
          const policyText = parts.slice(2).join(" ");
          const result = await mockTools.vault_set_policy.handler({
            agent_name: agentName,
            policy: policyText,
          });
          console.log(result);
          break;
        }
        case "exec": {
          const result = await mockTools.vault_execute.handler({
            agent_name: parts[1],
            type: parts[2] || "swap",
            amount_sol: parseFloat(parts[3] || "0.1"),
            program: parts[4],
            description: parts.slice(2).join(" "),
          });
          console.log(result);
          break;
        }
        case "status": {
          const result = await mockTools.vault_status.handler({
            agent_name: parts[1],
          });
          console.log(result);
          break;
        }
        case "approve": {
          const result = await mockTools.vault_approve.handler({
            tx_id: parts[1],
          });
          console.log(result);
          break;
        }
        case "reject": {
          const result = await mockTools.vault_reject.handler({
            tx_id: parts[1],
            reason: parts.slice(2).join(" ") || undefined,
          });
          console.log(result);
          break;
        }
        case "freeze": {
          const result = await mockTools.vault_freeze.handler({
            agent_name: parts[1],
          });
          console.log(result);
          break;
        }
        default:
          console.log(`Unknown command: ${cmd}. Type 'help' for usage.`);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
    }

    rl.prompt();
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
