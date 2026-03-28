import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "data", "agentvault.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initSchema(db);
  }
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      swig_address TEXT NOT NULL,
      swig_id TEXT NOT NULL,
      agent_pubkey TEXT NOT NULL,
      owner_pubkey TEXT NOT NULL,
      role_id INTEGER NOT NULL DEFAULT 1,
      trust_score INTEGER NOT NULL DEFAULT 0,
      trust_tier INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      frozen INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      cedar_text TEXT NOT NULL,
      nl_description TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS policy_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      members TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS trust_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      event_type TEXT NOT NULL,
      details TEXT,
      trust_delta INTEGER NOT NULL DEFAULT 0,
      trust_total INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS tx_queue (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      intent TEXT NOT NULL,
      risk_score INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      resolved_at INTEGER,
      resolution TEXT
    );

    CREATE TABLE IF NOT EXISTS shamir_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      share_index INTEGER NOT NULL,
      encrypted_share TEXT NOT NULL,
      storage_hint TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_spending (
      agent_id TEXT NOT NULL REFERENCES agents(id),
      date TEXT NOT NULL,
      total_lamports INTEGER NOT NULL DEFAULT 0,
      tx_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (agent_id, date)
    );

    CREATE TABLE IF NOT EXISTS heartbeats (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id),
      last_heartbeat INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
