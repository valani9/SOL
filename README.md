# AgentVault

**Smart Account Provisioning for OpenClaw AI Agents on Solana**

AgentVault provisions OpenClaw AI agents with secure, policy-controlled [Swig](https://onswig.com) smart accounts on Solana. It distributes signing keys across macOS Keychain and Shamir Secret Sharing, enforces dual-layer policies (Cedar off-chain + Swig on-chain), and features a natural language policy compiler that lets humans define agent rules in plain English.

Built for the [Solana Smart Account Provisioning Bounty](https://solana.com).

---

## Table of Contents

- [Why AgentVault](#why-agentvault)
- [Key Features](#key-features)
- [Architecture](#architecture)
  - [System Overview](#system-overview)
  - [5-Layer Security Gauntlet](#5-layer-security-gauntlet)
  - [Module Dependency Graph](#module-dependency-graph)
- [Security Model](#security-model)
  - [Key Distribution Strategy](#key-distribution-strategy)
  - [Threat Model](#threat-model)
  - [Key Isolation Principle](#key-isolation-principle)
- [Policy Engine Design](#policy-engine-design)
  - [Cedar Policies (Off-Chain)](#cedar-policies-off-chain)
  - [Swig On-Chain Enforcement (Backstop)](#swig-on-chain-enforcement-backstop)
  - [Natural Language Compilation](#natural-language-compilation)
  - [Entity Model](#entity-model)
  - [Context Attributes](#context-attributes)
  - [Default Policies](#default-policies)
- [Progressive Autonomy (Trust Ledger)](#progressive-autonomy-trust-ledger)
  - [Trust Tiers](#trust-tiers)
  - [Score Mechanics](#score-mechanics)
  - [Upgrade Eligibility](#upgrade-eligibility)
- [Risk Scoring & Approval Routing](#risk-scoring--approval-routing)
  - [Risk Factors](#risk-factors)
  - [Routing Decision](#routing-decision)
- [Guardrails](#guardrails)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
  - [File-by-File Breakdown](#file-by-file-breakdown)
  - [Database Schema](#database-schema)
- [Setup & Installation](#setup--installation)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Configuration](#configuration)
  - [Build](#build)
- [Usage](#usage)
  - [CLI Mode](#cli-mode)
  - [Interactive Mode](#interactive-mode)
  - [OpenClaw Plugin Mode](#openclaw-plugin-mode)
- [API Reference](#api-reference)
  - [vault_provision](#vault_provision)
  - [vault_set_policy](#vault_set_policy)
  - [vault_execute](#vault_execute)
  - [vault_status](#vault_status)
  - [vault_approve](#vault_approve)
  - [vault_reject](#vault_reject)
  - [vault_freeze](#vault_freeze)
- [Example Flows](#example-flows)
  - [Provisioning a New Agent](#provisioning-a-new-agent)
  - [Setting Policies in Natural Language](#setting-policies-in-natural-language)
  - [Transaction That Succeeds](#transaction-that-succeeds)
  - [Transaction That Gets Blocked](#transaction-that-gets-blocked)
  - [Transaction Requiring Human Approval](#transaction-requiring-human-approval)
- [Extensibility](#extensibility)
- [License](#license)

---

## Why AgentVault

Most AI agents store their private key in a plaintext JSON file. No spending limits. No human oversight. No recovery if compromised. If the key leaks, everything is gone instantly.

Your bank account has 2FA, fraud detection, spending limits, and insurance. Your AI agent has... a plaintext file. That's a security model you wouldn't accept for a $50 PayPal account, let alone an autonomous agent managing real funds on Solana.

AgentVault fixes that.

---

## Key Features

### 1. Natural Language Policy Compiler
Type policies in plain English:

> "Allow the agent to swap on Jupiter up to 2 SOL per trade, max 5 SOL per day. Block all transfers to unknown addresses."

Claude API compiles this into **synchronized** Cedar off-chain rules + Swig on-chain spending limits in a single pass, shows you a human-readable diff, and applies on confirmation. This isn't a chatbot wrapper — it's a policy compiler that produces formally verifiable authorization rules.

### 2. Progressive Autonomy ("Trust Ledger")
Agents start in "training wheels" mode (0.1 SOL/tx) and earn expanded permissions through successful transactions. At tier thresholds, the system proposes upgrades. The owner approves or rejects. Agents literally earn their autonomy — and it can be revoked instantly.

### 3. 5-Layer Security Gauntlet
Every transaction passes through Cedar pre-flight, risk scoring, approval routing, Solana simulation, and Swig on-chain enforcement. Even if every off-chain layer has a bug, the smart contract itself rejects overspending.

### 4. Distributed Key Storage
Primary key in macOS Keychain (Touch ID protected). Backup via Shamir 3-of-5 Secret Sharing. The agent process never sees the raw private key.

### 5. Creative Guardrails
Dead man's switch (auto-freeze on missing heartbeat), time-of-day restrictions, risk-based approval routing, and default-deny for unrecognized operations.

---

## Architecture

### System Overview

```
User (Telegram / Discord / CLI)
  |
  v
+-------------------------------------------+
|         OpenClaw Agent Runtime             |
|                                            |
|  +--------------------------------------+  |
|  |         AgentVault Plugin            |  |
|  |                                      |  |
|  |  Tools:                              |  |
|  |   vault_provision                    |  |
|  |   vault_set_policy  (NL -> Cedar)    |  |
|  |   vault_execute     (5-layer check)  |  |
|  |   vault_status                       |  |
|  |   vault_approve / vault_reject       |  |
|  |   vault_freeze                       |  |
|  |                                      |  |
|  |  Hook: before_tool_call              |  |
|  |   (intercepts all calls for policy)  |  |
|  |                                      |  |
|  |  Modules:                            |  |
|  |   PolicyEngine    (Cedar WASM)       |  |
|  |   KeyManager      (Keychain+Shamir)  |  |
|  |   SwigManager     (on-chain ops)     |  |
|  |   TrustLedger     (autonomy tiers)   |  |
|  |   TxQueue         (risk routing)     |  |
|  |   NLCompiler      (Claude API)       |  |
|  +--------------------------------------+  |
|                                            |
+-------------------------------------------+
         |                    |
         v                    v
  +-----------+      +---------------+
  | macOS     |      | Swig Wallet   |
  | Keychain  |      | (on-chain)    |
  | + Shamir  |      | Solana Devnet |
  +-----------+      +---------------+
```

### 5-Layer Security Gauntlet

Every call to `vault_execute` passes through all 5 layers sequentially:

```
Transaction Intent
      |
      v
[Layer 1] Cedar Pre-flight
      |  Evaluates all active Cedar policies against the request.
      |  If DENY -> blocked immediately, trust score -1.
      v
[Layer 2] Risk Scoring
      |  Calculates weighted risk score (0-100) from 5 factors:
      |  amount ratio, daily budget usage, tx type, time-of-day, failure rate.
      v
[Layer 3] Approval Routing
      |  score < autoApproveThreshold  -> auto_approve
      |  score < requiresApprovalAbove -> delayed (60s cancellation window)
      |  score >= requiresApprovalAbove -> requires_approval (queued for human)
      v
[Layer 4] Solana Simulation
      |  connection.simulateTransaction() catches on-chain errors
      |  before spending gas.
      v
[Layer 5] Swig On-Chain Enforcement
      |  Even if all off-chain layers pass, Swig's on-chain spending
      |  limits are the final backstop. The smart contract itself
      |  rejects transactions exceeding the configured Actions limits.
      v
   TX Confirmed
```

### Module Dependency Graph

```
plugin.ts (main entry point)
  |
  +-- db.ts (SQLite database)
  +-- key-manager.ts (keytar + shamir-secret-sharing + crypto)
  +-- swig-manager.ts (@solana/web3.js + @swig-wallet/classic)
  +-- policy-engine.ts (@cedar-policy/cedar-wasm)
  +-- trust-ledger.ts (scoring logic, depends on db.ts)
  +-- tx-queue.ts (risk scoring, depends on trust-ledger.ts)
  +-- nl-policy-compiler.ts (@anthropic-ai/sdk, depends on policy-engine.ts)
  |
  +-- cli.ts (standalone CLI wrapper, depends on plugin.ts)
  +-- index.ts (public library exports)
```

No circular dependencies. Each module has a single responsibility.

---

## Security Model

### Key Distribution Strategy

**Backend 1: macOS Keychain (Primary)**
- Stores the agent's full Ed25519 private key
- Protected by macOS user password and Touch ID
- Accessed via `keytar.setPassword("agentvault", agentId, base64Key)`
- Key never enters the agent's runtime context

**Backend 2: Shamir Secret Sharing (Recovery)**
- On wallet creation, the private key is split into 5 shares with a threshold of 3
- Any 3 of 5 shares can reconstruct the full key

| Share | Storage | Purpose |
|-------|---------|---------|
| Share 1 | Encrypted in SQLite (AES-256-GCM with scrypt-derived key) | Local recovery |
| Share 2 | Displayed once for owner to print/photograph | Physical backup |
| Share 3 | Stored as file for external backup (USB, cloud) | Offsite recovery |
| Share 4 | Given to trusted contact #1 | Social recovery |
| Share 5 | Given to trusted contact #2 | Social recovery |

**Encryption Details (Share 1):**
- Key derivation: `scrypt(passphrase, "agentvault-salt", keylen=32)`
- Cipher: AES-256-GCM
- Format stored: `{iv_hex}:{auth_tag_hex}:{ciphertext_hex}`

### Threat Model

| Threat | Impact | Mitigation |
|--------|--------|-----------|
| **Keychain compromised** (attacker has macOS access) | Can sign transactions | Swig on-chain limits cap max damage. Owner uses Shamir shares to reconstruct key on a new machine and rotates agent authority on-chain. |
| **Single Shamir share leaked** | None | Useless alone — attacker needs 3 of 5 shares. Owner rotates the affected share. |
| **Agent process compromised** (prompt injection) | Could attempt unauthorized transactions | Agent never sees raw private key. Signing happens in KeyManager. Cedar policies + Swig on-chain limits block unexpected patterns. |
| **Agent process crashes** | Agent stops operating | Dead man's switch auto-freezes after 30 minutes with no heartbeat. |
| **Owner loses device** | Loses Keychain access | Any 3 of 5 Shamir shares reconstruct the key. Social recovery via trusted contacts. |
| **Cedar policy engine has a bug** | Could allow transactions that should be denied | Swig on-chain limits are always equal to or tighter than Cedar limits. The smart contract is the final backstop. |
| **Database compromised** | Attacker sees encrypted share + policies | Share 1 is AES-256-GCM encrypted. Without passphrase + 2 more shares, key is unrecoverable. Policies are not secret. |

### Key Isolation Principle

The agent's private key is stored in macOS Keychain and **never enters the agent's context**. When a transaction needs signing:

1. The `vault_execute` handler builds a serialized transaction
2. It calls `keyManager.getKeypair(agentId)` to retrieve the key from Keychain
3. The key is used to sign within the handler function
4. The key is never passed to the agent, stored in memory longer than the function scope, or logged

The agent only ever sees: wallet address, balance, transaction signatures, and policy results.

---

## Policy Engine Design

### Cedar Policies (Off-Chain)

Policies are written in [Cedar](https://www.cedarpolicy.com/), a declarative authorization language by AWS with formal verification capabilities (42-60x faster than OPA/Rego).

**Example — Permit swaps with limits:**
```cedar
permit(
  principal == Agent::"agent-001",
  action == Action::"swap",
  resource in ProgramGroup::"approved-dexes"
) when {
  context.amount_sol <= 2.0 &&
  context.daily_total_sol <= 10.0
};
```

**Example — Forbid transfers to unknown addresses:**
```cedar
forbid(
  principal == Agent::"agent-001",
  action == Action::"transfer",
  resource
) unless {
  resource in AddressGroup::"approved-destinations"
};
```

**Example — Time-of-day restriction:**
```cedar
forbid(
  principal == Agent::"agent-001",
  action,
  resource
) when {
  context.hour_of_day < 6 || context.hour_of_day > 23
};
```

### Swig On-Chain Enforcement (Backstop)

Swig [Actions](https://build.onswig.com) mirror Cedar policies as hard on-chain limits. The Swig smart contract evaluates these limits at transaction time — if the agent somehow bypasses every off-chain check, the on-chain program still rejects overspending.

**Swig Actions used:**
- `solRecurringLimit({ recurringAmount, window })` — Daily SOL spending cap
- `programLimit({ programId })` — Restrict to specific programs (Jupiter, Raydium, etc.)
- `solDestinationLimit({ amount, destination })` — Restrict transfers to specific addresses

On-chain limits are always **equal to or tighter** than Cedar limits.

### Natural Language Compilation

The NL Policy Compiler uses Claude API (Sonnet 4) to convert English into synchronized Cedar + Swig configuration:

```
User Input: "Allow swaps on Jupiter, max 2 SOL per trade, 5 SOL per day"
                                    |
                                    v
                          Claude API (Sonnet 4)
                                    |
                    +---------------+---------------+
                    |                               |
                    v                               v
          Cedar Policies                  Swig Actions Config
          (stored in SQLite)              (updated on-chain)
```

**Compilation output structure:**
```json
{
  "cedarPolicies": ["permit(...) when { context.amount_sol <= 2.0 }"],
  "swigActions": {
    "solRecurringLimit": { "amount_sol": 5, "window_hours": 24 },
    "programLimits": ["jupiter"]
  },
  "entityGroups": [
    {
      "entityType": "ProgramGroup",
      "entityId": "approved-dexes",
      "members": ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"]
    }
  ],
  "explanation": "Allows swaps on Jupiter up to 2 SOL per trade, 5 SOL daily limit."
}
```

The system shows a human-readable diff before applying. You inspect, then confirm.

### Entity Model

Cedar uses an entity hierarchy for access control:

| Entity Type | Example | Purpose |
|-------------|---------|---------|
| `Agent` | `Agent::"agent-001"` | The AI agent principal |
| `Action` | `Action::"swap"` | Transaction types: swap, transfer, stake, unstake |
| `Program` | `Program::"JUP6Lk..."` | Solana program being invoked |
| `ProgramGroup` | `ProgramGroup::"approved-dexes"` | Whitelisted program sets |
| `Address` | `Address::"7xKp..."` | Destination addresses |
| `AddressGroup` | `AddressGroup::"approved-destinations"` | Whitelisted address sets |

Programs and addresses inherit group membership. A program in `ProgramGroup::"approved-dexes"` satisfies any policy requiring `resource in ProgramGroup::"approved-dexes"`.

### Context Attributes

Every policy evaluation includes these context attributes:

| Attribute | Type | Description |
|-----------|------|-------------|
| `amount_sol` | number | SOL amount for this transaction |
| `daily_total_sol` | number | Total SOL spent today (from daily_spending table) |
| `hour_of_day` | number (0-23) | Current hour in local time |
| `destination` | string | Destination address (for transfers) |
| `token_mint` | string | SPL token mint address (for token swaps) |
| `portfolio_concentration` | number (0-1) | Herfindahl index of portfolio (reserved for future use) |

### Default Policies

Every new agent starts with three "training wheels" policies:

1. **Permit small swaps:** `amount_sol <= 0.1` AND `daily_total_sol <= 1.0`
2. **Forbid all transfers:** No direct SOL/token transfers allowed
3. **Forbid late-night activity:** No operations between midnight and 6 AM

If no policies exist for an agent, the engine defaults to **deny all** (fail-safe).

---

## Progressive Autonomy (Trust Ledger)

### Trust Tiers

| Tier | Name | Min Score | Max SOL/TX | Max SOL/Day | Auto-Approve Below | Human Approval Above |
|------|------|-----------|------------|-------------|--------------------|-----------------------|
| 0 | Training Wheels | 0 | 0.1 | 1 | risk < 20 | risk > 30 |
| 1 | Beginner | 10 | 1 | 5 | risk < 30 | risk > 50 |
| 2 | Intermediate | 25 | 5 | 25 | risk < 40 | risk > 60 |
| 3 | Advanced | 50 | 25 | 100 | risk < 50 | risk > 70 |
| 4 | Autonomous | 100 | 100 | 500 | risk < 60 | risk > 80 |

### Score Mechanics

| Event | Score Change | Event Type |
|-------|-------------|------------|
| Successful transaction | +1 | `tx_success` |
| Transaction blocked by policy | -1 | `tx_blocked` |
| Policy violation (execution error) | -3 | `policy_violation` |
| Tier upgrade applied | 0 (logged only) | `trust_upgrade` |

Score floor is 0 (cannot go negative).

### Upgrade Eligibility

The system checks for upgrade eligibility after every successful transaction:

1. Agent's score must be >= next tier's `minScore`
2. Zero policy violations in the last 24 hours
3. System generates a human-readable proposal message
4. Owner must explicitly approve the upgrade via chat

Upgrades are never automatic — the human always has final say.

---

## Risk Scoring & Approval Routing

### Risk Factors

Each transaction is scored across 5 weighted factors:

| Factor | Weight | Scoring Logic | Example |
|--------|--------|---------------|---------|
| `amount_ratio` | 30% | `(amountSol / tier.maxSolPerTx) * 100`, capped at 100 | 1 SOL / 2 SOL limit = 50 |
| `daily_budget` | 25% | `((dailyTotal + amount) / tier.maxDailySol) * 100`, capped at 100 | (3+1) / 5 daily = 80 |
| `tx_type` | 20% | Base scores: swap=20, transfer=60, stake=30, unstake=40, unknown=80 | swap = 20 |
| `time_of_day` | 10% | Off-hours (23:00-06:00)=70, normal hours=10 | 14:00 = 10 |
| `failure_rate` | 15% | `(failedTxCount / totalTxCount_24h) * 200`, capped at 100 | 1 fail / 10 total = 20 |

**Final score** = round(sum of componentScore * weight)

### Routing Decision

```
if score < tier.autoApproveRiskThreshold  --> auto_approve (execute immediately)
if score < tier.requiresApprovalAbove     --> delayed (execute after 60s, cancellable)
if score >= tier.requiresApprovalAbove    --> requires_approval (queued, 10-min timeout)
```

Pending transactions auto-expire after 10 minutes if not approved or rejected.

---

## Guardrails

| Guardrail | Implementation | Trigger |
|-----------|---------------|---------|
| **Dead man's switch** | Heartbeat check every 5 minutes. If no heartbeat for 30 minutes, agent is auto-frozen in DB. | Agent process crashes or hangs |
| **Time-of-day restrictions** | Cedar policy with `context.hour_of_day` condition. Default: no activity midnight-6AM. | Late-night transactions |
| **Default deny** | If no active policies exist, all transactions are denied. | Misconfigured agent |
| **Transfer block** | Default policy forbids all direct transfers. Must be explicitly overridden. | Unauthorized fund extraction |
| **Risk-based routing** | High-risk transactions require human approval before execution. | Large or unusual transactions |
| **Auto-expiry** | Pending approvals expire after 10 minutes. | Unattended approval queues |
| **On-chain backstop** | Swig limits enforce hard caps even if all off-chain logic is bypassed. | Software bugs or exploits |

---

## Tech Stack

| Layer | Technology | Package | Purpose |
|-------|-----------|---------|---------|
| Smart Account | Swig Wallet | `@swig-wallet/classic` | On-chain wallet with session keys, granular Actions, single-signer execution |
| Agent Framework | OpenClaw | Plugin API | AI agent runtime with tool registration and lifecycle hooks |
| Policy Engine | Cedar WASM | `@cedar-policy/cedar-wasm` | Attribute-based access control, 42-60x faster than OPA, formal verification |
| Key Storage (Primary) | macOS Keychain | `keytar` | OS-native secure credential storage, Touch ID protected |
| Key Storage (Backup) | Shamir Secret Sharing | `shamir-secret-sharing` | 3-of-5 threshold key splitting (audited by Cure53 & Zellic) |
| NL Compiler | Claude API | `@anthropic-ai/sdk` | Natural language to Cedar + Swig compilation (Sonnet 4) |
| Blockchain | Solana | `@solana/web3.js` | Transaction building, simulation, and submission |
| Database | SQLite | `better-sqlite3` | Policy storage, trust logs, transaction queue, Shamir shares |
| Cryptography | Node.js crypto + tweetnacl | Built-in + `tweetnacl` | AES-256-GCM encryption, Ed25519 signing |
| IDs | UUID v4 | `uuid` | Agent IDs, policy IDs, transaction IDs |

**Why Swig over Squads:**
- **Session keys** with inherited permissions — agent gets a session keypair with precise spending limits that expire automatically
- **Granular Actions API** — `solRecurringLimit`, `programLimit`, `tokenDestinationLimit` map directly to agent guardrails
- **Single-signer execution** — no proposal/vote/execute multisig latency, appropriate for autonomous agents
- **Native AI agent focus** — Swig ships an MCP server (`@swig-wallet/mcp-server`), targeting this use case

---

## Project Structure

```
agentvault/
  |
  +-- src/
  |     +-- plugin.ts             # OpenClaw plugin entry + 7 tool handlers + hook
  |     +-- cli.ts                # Standalone CLI with command + interactive modes
  |     +-- db.ts                 # SQLite schema (8 tables) + singleton connection
  |     +-- key-manager.ts        # Keychain storage + Shamir SSS + AES-256-GCM
  |     +-- swig-manager.ts       # Swig wallet create/update/sign/freeze
  |     +-- policy-engine.ts      # Cedar WASM evaluation + policy CRUD
  |     +-- trust-ledger.ts       # 5-tier progressive autonomy + scoring
  |     +-- tx-queue.ts           # Risk scoring (5 factors) + approval routing
  |     +-- nl-policy-compiler.ts # Claude API NL -> Cedar + Swig compilation
  |     +-- index.ts              # Public library exports
  |
  +-- data/                       # SQLite database (gitignored)
  +-- dist/                       # Compiled JavaScript (gitignored)
  |
  +-- openclaw.plugin.json        # OpenClaw plugin manifest
  +-- package.json                # Dependencies and scripts
  +-- tsconfig.json               # TypeScript strict mode config
  +-- .env.example                # Environment variable template
  +-- .gitignore                  # Ignores node_modules, dist, data, .env
  +-- README.md                   # This file
```

### File-by-File Breakdown

| File | Lines | Exports | Description |
|------|-------|---------|-------------|
| `db.ts` | ~100 | `getDb()`, `closeDb()` | SQLite singleton with WAL mode, foreign keys, 8-table schema |
| `key-manager.ts` | ~225 | `KeyManager` class | Ed25519 keygen, Keychain CRUD, Shamir split/combine, AES-256-GCM encrypt/decrypt, key rotation |
| `swig-manager.ts` | ~230 | `SwigManager` class | Swig wallet creation with dual authorities, Actions building, permission updates, sign-through-Swig execution, freeze |
| `policy-engine.ts` | ~330 | `PolicyEngine` class | Cedar WASM dynamic import, policy evaluation with entity hierarchy, CRUD operations, default training-wheels policies |
| `trust-ledger.ts` | ~235 | `TrustLedger` class | 5-tier system with score tracking, upgrade eligibility checks (24h violation window), event logging |
| `tx-queue.ts` | ~275 | `TxQueue` class | 5-factor risk assessment, 3-tier routing (auto/delayed/human), SQLite-backed queue, daily spending tracker, auto-expiry |
| `nl-policy-compiler.ts` | ~240 | `NLPolicyCompiler` class | Claude Sonnet 4 integration, structured prompt with Cedar examples, SOL-to-lamports conversion, diff generation |
| `plugin.ts` | ~800 | `register()` + 7 handlers | OpenClaw plugin registration, 5-layer execution pipeline, heartbeat monitor (dead man's switch), helper functions |
| `cli.ts` | ~270 | CLI entry point | 8 commands + interactive REPL mode, mock OpenClaw API for standalone use |
| `index.ts` | ~10 | Re-exports | Public API for library consumers |

### Database Schema

**8 tables**, all with foreign key constraints:

```sql
-- Core agent record
agents (
  id TEXT PRIMARY KEY,           -- UUID
  name TEXT NOT NULL,            -- Human-readable name
  swig_address TEXT NOT NULL,    -- Solana address of Swig wallet
  swig_id TEXT NOT NULL,         -- Hex-encoded 32-byte Swig ID
  agent_pubkey TEXT NOT NULL,    -- Agent's Ed25519 public key
  owner_pubkey TEXT NOT NULL,    -- Owner's Solana public key
  role_id INTEGER DEFAULT 1,    -- Agent's Swig role ID
  trust_score INTEGER DEFAULT 0, -- Accumulated trust points
  trust_tier INTEGER DEFAULT 0,  -- Current tier (0-4)
  created_at INTEGER,           -- Unix timestamp
  frozen INTEGER DEFAULT 0       -- Emergency lock flag
)

-- Cedar policies (soft-deletable)
policies (
  id TEXT PRIMARY KEY,           -- UUID
  agent_id TEXT FK -> agents,
  cedar_text TEXT NOT NULL,      -- Full Cedar policy syntax
  nl_description TEXT,           -- Original natural language input
  created_at INTEGER,
  active INTEGER DEFAULT 1       -- 0 = deactivated
)

-- Entity groups for Cedar (ProgramGroup, AddressGroup)
policy_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT FK -> agents,
  entity_type TEXT NOT NULL,     -- "ProgramGroup", "AddressGroup"
  entity_id TEXT NOT NULL,       -- Group name
  members TEXT DEFAULT '[]'      -- JSON array of addresses
)

-- Trust event log (append-only)
trust_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT FK -> agents,
  event_type TEXT NOT NULL,      -- tx_success, policy_violation, tx_blocked, trust_upgrade
  details TEXT,
  trust_delta INTEGER DEFAULT 0,
  trust_total INTEGER DEFAULT 0,
  timestamp INTEGER
)

-- Transaction approval queue
tx_queue (
  id TEXT PRIMARY KEY,           -- UUID
  agent_id TEXT FK -> agents,
  intent TEXT NOT NULL,          -- JSON-serialized TransactionIntent
  risk_score INTEGER DEFAULT 0,  -- 0-100
  status TEXT DEFAULT 'pending', -- pending, approved, rejected, expired, executed
  created_at INTEGER,
  resolved_at INTEGER,
  resolution TEXT                -- Reason or TX signature
)

-- Encrypted Shamir shares (only share 0 stored)
shamir_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT FK -> agents,
  share_index INTEGER NOT NULL,  -- 0-4
  encrypted_share TEXT NOT NULL,  -- AES-256-GCM encrypted hex
  storage_hint TEXT NOT NULL      -- Where this share should be kept
)

-- Daily spending tracker
daily_spending (
  agent_id TEXT FK -> agents,
  date TEXT NOT NULL,            -- ISO date string (YYYY-MM-DD)
  total_lamports INTEGER DEFAULT 0,
  tx_count INTEGER DEFAULT 0,
  PRIMARY KEY (agent_id, date)
)

-- Dead man's switch heartbeats
heartbeats (
  agent_id TEXT PRIMARY KEY FK -> agents,
  last_heartbeat INTEGER         -- Unix timestamp
)
```

---

## Setup & Installation

### Prerequisites

- **Node.js >= 20** (for ES2022 support)
- **macOS** (for Keychain support via `keytar`; Linux/Windows use OS-native credential stores automatically)
- **Solana CLI** (optional, for generating devnet wallets and airdrops)

### Installation

```bash
git clone https://github.com/valani9/SOL.git
cd SOL
npm install
```

### Configuration

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# Solana RPC endpoint (default: devnet)
SOLANA_RPC_URL=https://api.devnet.solana.com

# Claude API key for natural language policy compilation
ANTHROPIC_API_KEY=sk-ant-...

# Owner wallet private key (base58 string or JSON array of bytes)
# This wallet pays for Swig creation and is the root authority
OWNER_PRIVATE_KEY=<your-private-key>
```

**To generate a devnet wallet:**
```bash
solana-keygen new --outfile ~/.config/solana/devnet.json
solana airdrop 5 --url devnet
# Then export the private key to OWNER_PRIVATE_KEY
cat ~/.config/solana/devnet.json
# Copy the JSON array
```

### Build

```bash
npm run build        # Compile TypeScript to dist/
npm run typecheck    # Type check without emitting files
```

---

## Usage

### CLI Mode

```bash
# Create a new agent wallet
npx ts-node src/cli.ts provision --name TradingBot --sol 5 --passphrase "my-secure-passphrase"

# Set policies in natural language
npx ts-node src/cli.ts set-policy --agent TradingBot \
  --policy "Allow swaps on Jupiter, max 2 SOL per trade, 5 SOL per day. Block transfers to unknown addresses."

# Replace all existing policies
npx ts-node src/cli.ts set-policy --agent TradingBot \
  --policy "Only allow staking on Marinade, max 10 SOL per day" --replace

# Execute a transaction
npx ts-node src/cli.ts execute --agent TradingBot \
  --type swap --amount 1 --program jupiter --desc "Swap 1 SOL for USDC"

# Check agent status
npx ts-node src/cli.ts status --agent TradingBot

# Approve a pending transaction
npx ts-node src/cli.ts approve --tx-id a3f8b2c1-...

# Reject with reason
npx ts-node src/cli.ts reject --tx-id a3f8b2c1-... --reason "Too much on memecoins"

# Emergency freeze (removes on-chain authority)
npx ts-node src/cli.ts freeze --agent TradingBot
```

### Interactive Mode

```bash
npx ts-node src/cli.ts interactive
```

```
agentvault> provision TradingBot 5
agentvault> policy TradingBot Allow swaps on Jupiter, max 2 SOL per trade
agentvault> exec TradingBot swap 1 jupiter
agentvault> status TradingBot
agentvault> freeze TradingBot
agentvault> quit
```

### OpenClaw Plugin Mode

Add to your OpenClaw configuration:

```json
{
  "plugins": ["./path/to/agentvault"]
}
```

The plugin auto-registers 7 tools and a `before_tool_call` hook. Agents interact via natural language through any OpenClaw channel (Telegram, Discord, etc.).

---

## API Reference

### vault_provision

Creates a new Swig smart wallet with secure key storage.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | string | Yes | — | Agent name (must be unique) |
| `initial_sol` | number | No | 1 | SOL to fund the wallet |
| `passphrase` | string | Yes | — | Encrypts the local Shamir backup share |

**What it does:**
1. Generates Ed25519 keypair
2. Stores private key in macOS Keychain
3. Splits key into 5 Shamir shares (threshold 3)
4. Creates Swig wallet with owner (full control) + agent (restricted) authorities
5. Funds the wallet
6. Applies default training-wheels policies
7. Initializes heartbeat for dead man's switch

### vault_set_policy

Compiles natural language into Cedar + Swig limits.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `agent_name` | string | Yes | — | Agent to configure |
| `policy` | string | Yes | — | Natural language policy description |
| `replace_existing` | boolean | No | false | Clear all existing policies first |

**What it does:**
1. Sends natural language + existing policies to Claude Sonnet 4
2. Receives Cedar policies + Swig Actions + entity groups
3. Shows human-readable diff
4. Stores Cedar policies in SQLite
5. Updates Swig on-chain spending limits

### vault_execute

Executes a transaction through the 5-layer security gauntlet.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `agent_name` | string | Yes | — | Agent executing the transaction |
| `type` | string | Yes | — | "swap", "transfer", or "stake" |
| `amount_sol` | number | Yes | — | Amount in SOL |
| `destination` | string | No | — | Destination address (for transfers) |
| `program` | string | No | System Program | "jupiter", "raydium", "orca", "marinade", or a public key |
| `description` | string | Yes | — | Human-readable description |

**Known program aliases:**
- `jupiter` → `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`
- `raydium` → `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`
- `orca` → `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc`
- `marinade` → `MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD`

### vault_status

Shows agent state, trust score, policies, pending approvals, and recent activity.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_name` | string | Yes | Agent to query |

### vault_approve

Approves a pending transaction and executes it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tx_id` | string | Yes | Transaction UUID from vault_execute |

### vault_reject

Rejects a pending transaction.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tx_id` | string | Yes | Transaction UUID |
| `reason` | string | No | Explanation for rejection |

### vault_freeze

Emergency freeze: removes the agent's on-chain Swig authority and rejects all pending transactions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_name` | string | Yes | Agent to freeze |

**This action:**
- Calls `getRemoveAuthorityInstructions()` on Swig to remove the agent's role
- Sets `frozen = 1` in the database
- Rejects all pending transactions with reason "Agent frozen by owner"
- The agent can no longer sign any transactions on-chain

---

## Example Flows

### Provisioning a New Agent

```
$ npx ts-node src/cli.ts provision --name TradingBot --sol 5 --passphrase my-secret

AgentVault: Wallet Created

Agent:          TradingBot
Agent ID:       a1b2c3d4-e5f6-7890-abcd-ef1234567890
Swig Wallet:    7xKpN4vR8mQ2wL5jD9bYc3nYf...
Agent Pubkey:   Fg7Ja2eLpXm8Rv3bKw...
Balance:        5 SOL
Trust Tier:     Training Wheels (0.1 SOL/tx, 1 SOL/day)

Key Storage:
  Primary: macOS Keychain (Touch ID protected)
  Backup:  Shamir Secret Sharing (3-of-5 threshold)

Shamir Backup Shares:
  Share 1: Encrypted in local database
  Share 2 (owner-print-or-photo): a4f8c2...9e31b7
  Share 3 (external-backup-file): 7b21d9...f4a8c3
  Share 4 (trusted-contact-1):    e9c6a1...2d7f85
  Share 5 (trusted-contact-2):    3f8b72...c1e946

SAVE SHARES 2-5 NOW — they won't be shown again.

Default Policies Applied:
  - Swaps up to 0.1 SOL, 1 SOL/day max
  - All direct transfers blocked
  - No activity between midnight and 6 AM
```

### Setting Policies in Natural Language

```
$ npx ts-node src/cli.ts set-policy --agent TradingBot \
    --policy "Allow swaps on Jupiter up to 2 SOL per trade, max 5 SOL per day. Block all transfers to unknown addresses."

Policy Compiled & Applied

=== Policy Changes ===

ADDING Cedar Rules:
  + permit(principal == Agent::"a1b2c3d4-...", action == Action::"swap", ...)
  + forbid(principal == Agent::"a1b2c3d4-...", action == Action::"transfer", ...)

SWIG On-Chain Limit: 5 SOL per 24 hours
SWIG Allowed Programs: JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4

Entity Groups:
  + ProgramGroup::"approved-dexes" with 1 members

2 Cedar rule(s) added. On-chain Swig limits updated.
```

### Transaction That Succeeds

```
$ npx ts-node src/cli.ts execute --agent TradingBot --type swap --amount 1 --program jupiter --desc "Swap 1 SOL for USDC"

Transaction EXECUTED

Cedar Policy: ALLOW
Risk Score: 12/100 (auto_approve)
  amount_ratio: 50 (1 SOL / 2 SOL limit = 50%)
  daily_budget: 20 (1 SOL / 5 SOL daily = 20%)
  tx_type: 20 (swap = low risk)
  time_of_day: 10 (14:00 = normal hours)
  failure_rate: 0 (0% recent failures)

TX Signature: 4vJ9mK2...xK2m
Amount: 1 SOL
Trust Score: 1 (+1)
```

### Transaction That Gets Blocked

```
$ npx ts-node src/cli.ts execute --agent TradingBot --type transfer --amount 3 --destination Random111...111 --desc "Transfer to unknown"

Transaction BLOCKED

Cedar Policy: DENY
  - Transfers to unknown addresses forbidden by policy
  - Matched: forbid(action == Action::"transfer") unless resource in AddressGroup::"approved-destinations"

Trust Score: 0 (-1)
```

### Transaction Requiring Human Approval

```
$ npx ts-node src/cli.ts execute --agent TradingBot --type swap --amount 4.5 --program jupiter --desc "Swap 4.5 SOL for BONK"

Transaction QUEUED for Approval

Cedar Policy: ALLOW
Risk Score: 78/100 — requires human approval
  amount_ratio: 225% (exceeds per-tx limit)
  daily_budget: 90% of daily limit

TX ID: a3f8b2c1-...
Auto-expires in 10 minutes.

$ npx ts-node src/cli.ts reject --tx-id a3f8b2c1-... --reason "Too much on memecoins"

Transaction Rejected
```

---

## Extensibility

AgentVault is designed as a set of independent, pluggable modules. Each module has a single responsibility and clean interface.

| Extension | Where to Add | Effort |
|-----------|-------------|--------|
| **Ledger hardware wallet** | New `KeyStorageBackend` in `key-manager.ts` using `@ledgerhq/hw-app-solana` | Medium |
| **Secure Enclave / TEE** | Use P-256 key as authorization layer for Ed25519 access | Medium |
| **Volatility-aware limits** | Fetch SOL price from Pyth oracle in `policy-engine.ts`, halve limits when vol > 15% | Small |
| **Portfolio concentration** | Calculate Herfindahl index in `tx-queue.ts`, add as Cedar context attribute | Small |
| **Anomaly detection** | Track 7-day rolling averages in `tx-queue.ts`, flag 2+ std dev deviations | Medium |
| **Telegram/Discord approvals** | Wire `vault_approve`/`vault_reject` to bot commands via OpenClaw channels | Small |
| **New agent frameworks** | Only `plugin.ts` is OpenClaw-specific. Core modules work with any framework. | Small |
| **New Cedar policy templates** | Add to `addDefaultPolicies()` or create a policy template library | Trivial |
| **Passkey authentication** | Swig supports SECP256R1 authorities — add passkey-based owner auth | Medium |
| **Windows/Linux support** | `keytar` automatically uses Windows Credential Manager / Linux Secret Service | Built-in |

---

## License

MIT
