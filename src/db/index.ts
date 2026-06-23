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
      session_id     TEXT PRIMARY KEY,
      client_name    TEXT NOT NULL DEFAULT 'unknown',
      client_version TEXT,
      protocol_version TEXT,
      connected_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen      INTEGER NOT NULL DEFAULT (unixepoch()),
      directory      TEXT,
      status         TEXT NOT NULL DEFAULT 'connected'
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id              TEXT PRIMARY KEY,
      app_session_id  TEXT,
      mcp_session_id  TEXT,
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

    CREATE INDEX IF NOT EXISTS idx_agent_runs_provider ON agent_runs(provider_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_status   ON agent_runs(status);
    CREATE INDEX IF NOT EXISTS idx_app_sessions_status ON app_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_metrics_name        ON metrics(name);
  `);
}

export function recordMetric(name: string, value: number, labels: Record<string, string> = {}): void {
  getDb()
    .prepare(`INSERT INTO metrics (name, value, labels_json) VALUES (?, ?, ?)`)
    .run(name, value, JSON.stringify(labels));
}
