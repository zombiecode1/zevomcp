import { v4 as uuidv4 } from "uuid";
import crypto from "node:crypto";
import { getDb } from "../db/index.js";
import { logSystem } from "../logger/index.js";

const TTL_S = 24 * 60 * 60; // 24 hours

// ── Types ────────────────────────────────────────────────────────────────────

export interface ClientSession {
  id: string;
  clientId: string;
  clientName: string;
  clientVersion: string | null;
  clientType: string | null;
  status: "pending" | "verified" | "disconnected" | "expired";
  verificationCode: string | null;
  verifiedAt: number | null;
  ip: string | null;
  connectedAt: number;
  expiresAt: number;
  lastHeartbeat: number;
  conversationCount: number;
  metadata: Record<string, unknown>;
  directory: string | null;
}

interface ClientSessionRow {
  id: string;
  client_id: string;
  client_name: string;
  client_version: string | null;
  client_type: string | null;
  status: string;
  verification_code: string | null;
  verified_at: number | null;
  ip: string | null;
  connected_at: number;
  expires_at: number;
  last_heartbeat: number;
  conversation_count: number;
  metadata_json: string;
  directory: string | null;
}

function toClientSession(r: ClientSessionRow): ClientSession {
  return {
    id: r.id,
    clientId: r.client_id,
    clientName: r.client_name,
    clientVersion: r.client_version,
    clientType: r.client_type,
    status: r.status as ClientSession["status"],
    verificationCode: r.verification_code,
    verifiedAt: r.verified_at,
    ip: r.ip,
    connectedAt: r.connected_at,
    expiresAt: r.expires_at,
    lastHeartbeat: r.last_heartbeat,
    conversationCount: r.conversation_count,
    metadata: JSON.parse(r.metadata_json) as Record<string, unknown>,
    directory: r.directory,
  };
}

function ttlExpiry(): number {
  return Math.floor(Date.now() / 1000) + TTL_S;
}

// ── Verification Code ─────────────────────────────────────────────────────────

/**
 * Generate a 6-character uppercase alphanumeric verification code.
 * Format: ABC123 (letters + digits, no ambiguous chars like 0/O/1/I)
 */
export function generateVerificationCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

// ── Create / Find / Heartbeat ─────────────────────────────────────────────────

/**
 * Create a new client session with status = 'pending'.
 * Returns the session with a fresh verification_code.
 */
export function createClientSession(opts: {
  clientName: string;
  clientVersion?: string;
  clientType?: string;
  ip?: string;
  directory?: string;
}): ClientSession {
  const db = getDb();
  const id = uuidv4();
  const clientId = uuidv4();
  const code = generateVerificationCode();
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO client_sessions
      (id, client_id, client_name, client_version, client_type,
       status, verification_code, ip, expires_at, directory)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(
    id, clientId,
    opts.clientName, opts.clientVersion ?? null,
    opts.clientType ?? null,
    code, opts.ip ?? null,
    ttlExpiry(), opts.directory ?? null,
  );

  const row = db.prepare(`SELECT * FROM client_sessions WHERE id = ?`).get(id) as unknown as ClientSessionRow;
  return toClientSession(row);
}

/**
 * Find a client session by the persistent client_id.
 * Useful when a client reconnects and sends its stored client_id.
 */
export function findClientSessionByClientId(clientId: string): ClientSession | null {
  const row = getDb().prepare(
    `SELECT * FROM client_sessions WHERE client_id = ? ORDER BY connected_at DESC LIMIT 1`
  ).get(clientId) as unknown as ClientSessionRow | undefined;
  return row ? toClientSession(row) : null;
}

/**
 * Look up a pending session by its verification_code.
 */
export function findClientSessionByCode(code: string): ClientSession | null {
  const row = getDb().prepare(
    `SELECT * FROM client_sessions WHERE verification_code = ? AND status = 'pending' LIMIT 1`
  ).get(code) as unknown as ClientSessionRow | undefined;
  return row ? toClientSession(row) : null;
}

/**
 * Extend the session TTL + update heartbeat.
 */
export function heartbeatClientSession(id: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  const r = getDb().prepare(`
    UPDATE client_sessions SET last_heartbeat = ?, expires_at = ?
    WHERE id = ? AND status IN ('pending', 'verified')
  `).run(now, ttlExpiry(), id);
  return Number(r.changes) > 0;
}

// ── Status Machine ────────────────────────────────────────────────────────────

/**
 * Approve a pending client session → status = 'verified'.
 * Returns true if the transition was applied.
 */
export function approveClientSession(id: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  const r = getDb().prepare(`
    UPDATE client_sessions
    SET status = 'verified', verified_at = ?, expires_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(now, ttlExpiry(), id);
  return Number(r.changes) > 0;
}

/**
 * Reject / disconnect a pending client session.
 */
export function rejectClientSession(id: string): boolean {
  const r = getDb().prepare(`
    UPDATE client_sessions SET status = 'disconnected'
    WHERE id = ? AND status = 'pending'
  `).run(id);
  return Number(r.changes) > 0;
}

/**
 * Mark a session as disconnected (client went away).
 */
export function disconnectClientSession(id: string): boolean {
  const r = getDb().prepare(`
    UPDATE client_sessions SET status = 'disconnected'
    WHERE id = ? AND status = 'verified'
  `).run(id);
  return Number(r.changes) > 0;
}

// ── Queries ───────────────────────────────────────────────────────────────────

export function expireStaleClientSessions(): number {
  const r = getDb().prepare(`
    UPDATE client_sessions SET status = 'expired'
    WHERE status IN ('pending', 'verified') AND expires_at < unixepoch()
  `).run();
  return Number(r.changes);
}

export function listClientSessions(status?: string): ClientSession[] {
  expireStaleClientSessions();
  const sql = status
    ? `SELECT * FROM client_sessions WHERE status = ? ORDER BY connected_at DESC`
    : `SELECT * FROM client_sessions ORDER BY connected_at DESC`;
  const rows = status
    ? getDb().prepare(sql).all(status)
    : getDb().prepare(sql).all();
  return (rows as unknown as ClientSessionRow[]).map(toClientSession);
}

export function listVerifiedSessions(): ClientSession[] {
  return listClientSessions("verified");
}

// ── Conversations ─────────────────────────────────────────────────────────────

export interface Conversation {
  id: string;
  clientSessionId: string;
  title: string | null;
  status: "active" | "archived";
  startedAt: number;
  lastActive: number;
  promptCount: number;
  metadata: Record<string, unknown>;
}

interface ConversationRow {
  id: string;
  client_session_id: string;
  title: string | null;
  status: string;
  started_at: number;
  last_active: number;
  prompt_count: number;
  metadata_json: string;
}

function toConversation(r: ConversationRow): Conversation {
  return {
    id: r.id,
    clientSessionId: r.client_session_id,
    title: r.title,
    status: r.status as Conversation["status"],
    startedAt: r.started_at,
    lastActive: r.last_active,
    promptCount: r.prompt_count,
    metadata: JSON.parse(r.metadata_json) as Record<string, unknown>,
  };
}

export function createConversation(clientSessionId: string, title?: string): Conversation {
  const db = getDb();
  const id = uuidv4();
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO conversations (id, client_session_id, title, started_at, last_active)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, clientSessionId, title ?? null, now, now);

  // Bump conversation_count on the parent session
  db.prepare(`
    UPDATE client_sessions SET conversation_count = conversation_count + 1 WHERE id = ?
  `).run(clientSessionId);

  const row = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as unknown as ConversationRow;
  return toConversation(row);
}

export function listConversations(clientSessionId?: string): Conversation[] {
  const sql = clientSessionId
    ? `SELECT * FROM conversations WHERE client_session_id = ? ORDER BY last_active DESC`
    : `SELECT * FROM conversations ORDER BY last_active DESC`;
  const rows = clientSessionId
    ? getDb().prepare(sql).all(clientSessionId)
    : getDb().prepare(sql).all();
  return (rows as unknown as ConversationRow[]).map(toConversation);
}

export function touchConversation(id: string): boolean {
  const r = getDb().prepare(`
    UPDATE conversations SET last_active = unixepoch(), prompt_count = prompt_count + 1
    WHERE id = ?
  `).run(id);
  return Number(r.changes) > 0;
}
