import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { config } from "../config.js";

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (_db) return _db;

  _db = new DatabaseSync(path.resolve(config.dbPath));
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");
  migrate(_db);
  return _db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      base_url        TEXT NOT NULL,
      api_key         TEXT NOT NULL DEFAULT 'proxy-no-auth',
      status          TEXT NOT NULL DEFAULT 'unknown',
      models_json     TEXT NOT NULL DEFAULT '[]',
      last_checked_at INTEGER,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS app_sessions (
      id             TEXT PRIMARY KEY,
      client_info    TEXT NOT NULL DEFAULT '{}',
      created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at     INTEGER NOT NULL,
      last_heartbeat INTEGER NOT NULL DEFAULT (unixepoch()),
      provider_id    TEXT,
      directory      TEXT,
      ip             TEXT,
      status         TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS mcp_clients (
      session_id       TEXT PRIMARY KEY,
      client_name      TEXT NOT NULL DEFAULT 'unknown',
      client_version   TEXT,
      protocol_version TEXT,
      connected_at     INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen        INTEGER NOT NULL DEFAULT (unixepoch()),
      directory        TEXT,
      status           TEXT NOT NULL DEFAULT 'connected'
    );

    -- 🆕 client_sessions: persistent client-level sessions with verification
    CREATE TABLE IF NOT EXISTS client_sessions (
      id                 TEXT PRIMARY KEY,
      client_id          TEXT NOT NULL UNIQUE,
      client_name        TEXT NOT NULL DEFAULT 'unknown',
      client_version     TEXT,
      client_type        TEXT,
      status             TEXT NOT NULL DEFAULT 'pending'
                         CHECK(status IN ('pending','verified','disconnected','expired')),
      verification_code  TEXT,
      verified_at        INTEGER,
      ip                 TEXT,
      connected_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at         INTEGER NOT NULL,
      last_heartbeat     INTEGER NOT NULL DEFAULT (unixepoch()),
      conversation_count INTEGER NOT NULL DEFAULT 0,
      metadata_json      TEXT NOT NULL DEFAULT '{}',
      directory          TEXT
    );

    -- 🆕 conversations: grouping agent runs under a client session
    CREATE TABLE IF NOT EXISTS conversations (
      id                TEXT PRIMARY KEY,
      client_session_id TEXT NOT NULL REFERENCES client_sessions(id) ON DELETE CASCADE,
      title             TEXT,
      status            TEXT NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','archived')),
      started_at        INTEGER NOT NULL DEFAULT (unixepoch()),
      last_active       INTEGER NOT NULL DEFAULT (unixepoch()),
      prompt_count      INTEGER NOT NULL DEFAULT 0,
      metadata_json     TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id              TEXT PRIMARY KEY,
      app_session_id  TEXT,
      mcp_session_id  TEXT,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      provider_id     TEXT NOT NULL,
      model           TEXT NOT NULL,
      prompt          TEXT NOT NULL,
      output          TEXT,
      status          TEXT NOT NULL DEFAULT 'running',
      streaming       INTEGER NOT NULL DEFAULT 0,
      steps           INTEGER NOT NULL DEFAULT 0,
      tool_calls_json TEXT NOT NULL DEFAULT '[]',
      started_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      completed_at    INTEGER
    );

    CREATE TABLE IF NOT EXISTS metrics (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      value       REAL NOT NULL,
      labels_json TEXT NOT NULL DEFAULT '{}',
      recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_agent_runs_provider          ON agent_runs(provider_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_status            ON agent_runs(status);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation      ON agent_runs(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_app_sessions_status          ON app_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_client_sessions_client_id    ON client_sessions(client_id);
    CREATE INDEX IF NOT EXISTS idx_client_sessions_status       ON client_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_client_sessions_code         ON client_sessions(verification_code)
                                                                  WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_conversations_session         ON conversations(client_session_id);
    CREATE INDEX IF NOT EXISTS idx_metrics_name                 ON metrics(name);
  `);

  // Migration: add conversation_id to agent_runs if missing
  // SQLite doesn't support ALTER TABLE ADD COLUMN IF NOT EXISTS directly
  const tableInfo = db.prepare("PRAGMA table_info(agent_runs)").all() as Array<{ name: string }>;
  if (!tableInfo.some(col => col.name === "conversation_id")) {
    db.exec("ALTER TABLE agent_runs ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL");
  }
}

export function recordMetric(name: string, value: number, labels: Record<string, string> = {}): void {
  getDb()
    .prepare(`INSERT INTO metrics (name, value, labels_json) VALUES (?, ?, ?)`)
    .run(name, value, JSON.stringify(labels));
}
