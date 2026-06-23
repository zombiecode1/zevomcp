import { v4 as uuidv4 } from "uuid";
import { getDb } from "../db/index.js";

const TTL_S = 24 * 60 * 60;

export interface AppSession {
  id: string;
  clientInfo: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
  lastHeartbeat: number;
  providerId: string | null;
  directory: string | null;
  ip: string | null;
  status: "active" | "expired";
}

interface Row {
  id: string;
  client_info: string;
  created_at: number;
  expires_at: number;
  last_heartbeat: number;
  provider_id: string | null;
  directory: string | null;
  ip: string | null;
  status: string;
}

function toSession(r: Row): AppSession {
  return {
    id: r.id,
    clientInfo: JSON.parse(r.client_info) as Record<string, unknown>,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastHeartbeat: r.last_heartbeat,
    providerId: r.provider_id,
    directory: r.directory,
    ip: r.ip,
    status: r.status as "active" | "expired",
  };
}

export function createSession(opts: {
  clientInfo?: Record<string, unknown>;
  providerId?: string;
  directory?: string;
  ip?: string;
}): AppSession {
  const db = getDb();
  const id = uuidv4();
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO app_sessions (id, client_info, expires_at, provider_id, directory, ip)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    JSON.stringify(opts.clientInfo ?? {}),
    now + TTL_S,
    opts.providerId ?? null,
    opts.directory ?? null,
    opts.ip ?? null
  );

  const row = db.prepare(`SELECT * FROM app_sessions WHERE id = ?`).get(id) as unknown as Row;
  return toSession(row);
}

export function verifySession(id: string): { valid: boolean; session?: AppSession; reason?: string } {
  const row = getDb().prepare(`SELECT * FROM app_sessions WHERE id = ?`).get(id) as unknown as Row | undefined;
  if (!row) return { valid: false, reason: "session_not_found" };

  const s = toSession(row);
  if (s.expiresAt < Math.floor(Date.now() / 1000) || s.status !== "active") {
    return { valid: false, reason: "session_expired", session: s };
  }
  return { valid: true, session: s };
}

export function heartbeatSession(id: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  const r = getDb().prepare(`
    UPDATE app_sessions SET last_heartbeat = ?, expires_at = ?
    WHERE id = ? AND status = 'active'
  `).run(now, now + TTL_S, id);
  return Number(r.changes) > 0;
}

export function expireStaleSessions(): number {
  const r = getDb().prepare(
    `UPDATE app_sessions SET status = 'expired' WHERE status = 'active' AND expires_at < unixepoch()`
  ).run();
  return Number(r.changes);
}

export function listActiveSessions(): AppSession[] {
  expireStaleSessions();
  const rows = getDb().prepare(
    `SELECT * FROM app_sessions WHERE status = 'active' ORDER BY created_at DESC`
  ).all() as unknown as Row[];
  return rows.map(toSession);
}
