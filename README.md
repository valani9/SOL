# AgentVault

**Smart Account Provisioning for OpenClaw AI Agents on Solana**

AgentVault provisions OpenClaw AI agents with secure, policy-controlled Swig smart accounts on Solana. It distributes signing keys across macOS Keychain and Shamir Secret Sharing, enforces dual-layer policies (Cedar off-chain + Swig on-chain), and features a natural language policy compiler that lets humans define agent rules in plain English.

---

## Architecture

```
User (Telegram/Discord/CLI)
  │
  ▼
┌─────────────────────────────────────────┐
│         OpenClaw Agent Runtime          │
│                                         │
│  ┌──────────────────────────────────┐   │
│  │       AgentVault Plugin          │   │
│  │                                  │   │
│  │  Tools:                          │   │
│  │   vault_provision                │   │
│  │   vault_set_policy (NL → Cedar)  │   │
│  │   vault_execute (5-layer check)  │   │
│  │   vault_status                   │   │
│  │   vault_approve / vault_reject   │   │
│  │   vault_freeze                   │   │
│  │                                  │   │
│  │  Modules:                        │   │
│  │   PolicyEngine (Cedar WASM)      │   │
│  │   KeyManager (Keychain+Shamir)   │   │
│  │   SwigManager (on-chain ops)     │   │
│  │   TrustLedger (autonomy tiers)   │   │
│  │   TxQueue (risk-based routing)   │   │
│  │   NLCompiler (Claude API)        │   │
│  └──────────────────────────────────┘   │
└─────────────────────────────────────────┘
          │                    │
          ▼                    ▼
   ┌─────────────┐    ┌──────────────┐
   │ macOS        │    │ Swig Wallet  │
   │ Keychain     │    │ (on-chain)   │
   │ + Shamir SSS │    │              │
   └─────────────┘    └──────────────┘
```

## Key Features

### 1. Natural Language Policy Compiler
Type policies in plain English:
> "Allow the agent to swap on Jupiter up to 2 SOL per trade, max 5 SOL per day. Block all transfers to unknown addresses."

The system compiles this into **synchronized** Cedar off-chain rules + Swig on-chain spending limits, shows you a diff, and applies on confirmation.

### 2. Progressive Autonomy ("Trust Ledger")
Agents start in "training wheels" mode (0.1 SOL/tx) and earn expanded permissions through successful transactions:

| Tier | Name | Score | Max/Tx | Max/Day |
|------|------|-------|--------|---------|
| 0 | Training Wheels | 0+ | 0.1 SOL | 1 SOL |
| 1 | Beginner | 10+ | 1 SOL | 5 SOL |
| 2 | Intermediate | 25+ | 5 SOL | 25 SOL |
| 3 | Advanced | 50+ | 25 SOL | 100 SOL |
| 4 | Autonomous | 100+ | 100 SOL | 500 SOL |

### 3. Dual-Layer Policy Enforcement
Every transaction passes through a 5-layer gauntlet:
1. **Cedar pre-flight** — off-chain policy evaluation
2. **Risk scoring** — weighted factors (amount, daily budget, tx type, time, failure rate)
3. **Approval routing** — auto-approve / delayed / human approval based on risk
4. **Solana simulation** — `simulateTransaction()` catches on-chain failures
5. **Swig on-chain limits** — ultimate backstop, enforced by the smart contract

### 4. Distributed Key Storage
- **Primary:** macOS Keychain (Touch ID protected)
- **Backup:** Shamir 3-of-5 Secret Sharing (one encrypted in DB, others for owner)
- Agent process never sees the raw private key — signing happens inside KeyManager

### 5. Creative Guardrails
- **Dead man's switch** — auto-freeze if no heartbeat for 30 minutes
- **Time-of-day restrictions** — no trading between midnight and 6 AM
- **Risk-based approval routing** — high-value transactions require human confirmation

## Security Model

### Threat Model

| Scenario | Protection |
|----------|-----------|
| Keychain compromised | Swig on-chain limits cap damage. Shamir shares enable recovery + rotation. |
| Single Shamir share leaked | Useless alone (need 3 of 5). Owner rotates the share. |
| Agent prompt injection | Agent never sees raw key. Cedar + Swig block unexpected transaction patterns. |
| Agent process crashes | Dead man's switch freezes after 30 min with no heartbeat. |
| Owner loses device | 3 of 5 Shamir shares reconstruct the key from backup locations. |

### Key Isolation
The agent's private key is stored in macOS Keychain and **never enters the agent's context**. When a transaction needs signing, the `KeyManager` module receives the serialized transaction bytes and returns a signature. The raw key material stays within the secure storage boundary.

## Setup

### Prerequisites
- Node.js >= 20
- macOS (for Keychain support; Linux/Windows use `keytar` with OS-native credential stores)
- Solana CLI (optional, for devnet setup)

### Installation

```bash
git clone <repo-url>
cd agentvault
npm install
```

### Configuration

```bash
cp .env.example .env
# Edit .env with your values:
#   SOLANA_RPC_URL=https://api.devnet.solana.com
#   ANTHROPIC_API_KEY=sk-ant-...
#   OWNER_PRIVATE_KEY=<base58 or JSON array>
```

To generate a devnet wallet:
```bash
solana-keygen new --outfile ~/.config/solana/devnet.json
solana airdrop 5 --url devnet
# Copy the private key to OWNER_PRIVATE_KEY
```

### Build

```bash
npm run build        # Compile TypeScript
npm run typecheck    # Type check without emitting
```

## Usage

### CLI Mode

```bash
# Create an agent wallet
npx ts-node src/cli.ts provision --name TradingBot --sol 5 --passphrase "my-secure-passphrase"

# Set policies in natural language
npx ts-node src/cli.ts set-policy --agent TradingBot --policy "Allow swaps on Jupiter, max 2 SOL per trade, 5 SOL per day"

# Execute a transaction
npx ts-node src/cli.ts execute --agent TradingBot --type swap --amount 1 --program jupiter --desc "Swap 1 SOL for USDC"

# Check status
npx ts-node src/cli.ts status --agent TradingBot

# Approve/reject pending transactions
npx ts-node src/cli.ts approve --tx-id <uuid>
npx ts-node src/cli.ts reject --tx-id <uuid> --reason "Too risky"

# Emergency freeze
npx ts-node src/cli.ts freeze --agent TradingBot

# Interactive mode
npx ts-node src/cli.ts interactive
```

### OpenClaw Plugin Mode

Add to your OpenClaw configuration:
```json
{
  "plugins": ["./path/to/agentvault"]
}
```

The plugin registers these tools automatically:
- `vault_provision` — Create a new Swig wallet with secure key storage
- `vault_set_policy` — Set policies via natural language
- `vault_execute` — Execute policy-gated transactions
- `vault_status` — View agent status, trust score, and policies
- `vault_approve` / `vault_reject` — Human-in-the-loop for high-risk transactions
- `vault_freeze` — Emergency stop

## Policy Engine Design

### Cedar Policies (Off-Chain)
Policies are written in [Cedar](https://www.cedarpolicy.com/), a declarative authorization language:

```cedar
permit(
  principal == Agent::"agent-001",
  action == Action::"swap",
  resource in ProgramGroup::"approved-dexes"
) when {
  context.amount_sol <= 2.0 &&
  context.daily_total_sol <= 10.0
};

forbid(
  principal == Agent::"agent-001",
  action == Action::"transfer",
  resource
) unless {
  resource in AddressGroup::"approved-destinations"
};
```

### Swig On-Chain (Backstop)
Swig Actions mirror Cedar policies as hard on-chain limits using `solRecurringLimit`, `programLimit`, etc. Even if Cedar has a bug, Swig rejects overspending.

### Natural Language Compilation
The NL Policy Compiler uses Claude API to convert English → Cedar + Swig in a single pass:
1. User types: "Allow swaps on Jupiter, max 2 SOL/trade"
2. Claude generates Cedar policies + Swig Actions config
3. System shows a human-readable diff
4. User confirms → policies stored in SQLite + Swig updated on-chain

## Project Structure

```
src/
  plugin.ts          # OpenClaw plugin entry point (register + tool handlers)
  cli.ts             # Standalone CLI runner
  db.ts              # SQLite schema and database access
  key-manager.ts     # Keychain storage + Shamir Secret Sharing
  swig-manager.ts    # Swig wallet lifecycle (create, update, sign, freeze)
  policy-engine.ts   # Cedar WASM policy evaluation + CRUD
  trust-ledger.ts    # Progressive autonomy scoring and tier management
  tx-queue.ts        # Transaction queue, risk scoring, approval routing
  nl-policy-compiler.ts  # Natural language → Cedar + Swig compilation
  index.ts           # Library exports
openclaw.plugin.json # OpenClaw plugin manifest
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Smart Account | Swig Wallet (`@swig-wallet/classic`) |
| Agent Framework | OpenClaw (plugin API) |
| Policy Engine | Cedar WASM (`@cedar-policy/cedar-wasm`) |
| Key Storage | macOS Keychain (`keytar`) + Shamir SSS |
| LLM | Claude API (`@anthropic-ai/sdk`) |
| Blockchain | Solana (`@solana/web3.js`) |
| Database | SQLite (`better-sqlite3`) |
| Runtime | Node.js + TypeScript |

## Extensibility

- **New storage backends:** Implement a `KeyStorageBackend` interface in `key-manager.ts` (e.g., Ledger via `@ledgerhq/hw-app-solana`, Secure Enclave, cloud HSM)
- **New guardrail types:** Add Cedar policy templates and context attributes in `policy-engine.ts`
- **New agent frameworks:** The core modules (`PolicyEngine`, `KeyManager`, `SwigManager`) are framework-agnostic — only `plugin.ts` is OpenClaw-specific
- **Volatility-aware limits:** Add a price oracle integration to dynamically adjust Cedar spending limits
- **Portfolio concentration:** Track token holdings and add Herfindahl index checks

## License

MIT
