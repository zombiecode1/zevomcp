import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// ── Config ────────────────────────────────────────────────────────────────────
// Store hashed keys (SHA-256). The plain keys are set via .env and hashed at
// startup. This way even if the DB leaks, key material stays safe.
const SALT_LENGTH = 32;
const KEY_LENGTH = 48; // 48 chars = 384 bits of entropy

interface StoredKey {
  salt: string;
  hash: string;
  label: string;      // human-friendly name ("admin", "monitor", etc.)
  scopes: string[];   // ["proxy:read", "tools:call", "admin"]
}

// In-memory store — loaded once at startup from env.
const _keys: StoredKey[] = [];

// ── Init ───────────────────────────────────────────────────────────────────────

/** Load API keys from environment variables at startup. */
export function initAuth(): void {
  // Single master key (X_API_KEY)
  const master = process.env["X_API_KEY"];
  if (master && master.length >= 32) {
    const { salt, hash } = _hashKey(master);
    _keys.push({ salt, hash, label: "master", scopes: ["admin", "tools:call", "proxy:read", "proxy:write"] });
    console.log(`✓ Auth: master key loaded (${master.slice(0, 4)}…${master.slice(-4)})`);
  }

  // Secondary keys: X_API_KEY_1, X_API_KEY_2, …
  for (let i = 1; i <= 10; i++) {
    const raw = process.env[`X_API_KEY_${i}`];
    if (!raw) continue;
    const [label, ...rest] = raw.split(":");
    const key = rest.join(":");       // "label:keyvalue"
    if (key.length < 32) continue;
    const { salt, hash } = _hashKey(key);
    _keys.push({ salt, hash, label, scopes: ["tools:call"] }); // default scope
    console.log(`✓ Auth: key "${label}" loaded`);
  }

  if (_keys.length === 0) {
    console.log("⚠ Auth: NO API keys configured — server is OPEN (set X_API_KEY in .env)");
  }
}

// ── Validate ───────────────────────────────────────────────────────────────────

export interface AuthResult {
  ok: boolean;
  label?: string;
  scopes?: string[];
  reason?: string;
}

/** Check a bearer token against all stored keys. */
export function validateToken(token: string): AuthResult {
  // Fast-path: empty token when no keys configured = allow
  if (_keys.length === 0) return { ok: true, scopes: ["admin", "tools:call", "proxy:read", "proxy:write"] };

  if (!token) return { ok: false, reason: "No API key provided" };

  for (const stored of _keys) {
    if (_verifyKey(token, stored.salt, stored.hash)) {
      return { ok: true, label: stored.label, scopes: stored.scopes };
    }
  }

  return { ok: false, reason: "Invalid API key" };
}

// ── Middleware Factory for mcp-use / Hono ───────────────────────────────────────

import type { Context } from "hono";

/**
 * Hono middleware that validates X-API-Key or Authorization: Bearer <key>.
 * Add to any route: `app.use("/api/*", authMiddleware())`
 */
export function authMiddleware(requiredScopes?: string[]) {
  return async (c: Context, next: () => Promise<void>) => {
    // Skip auth for the web dashboard (it has its own session check)
    if (c.req.path === "/dashboard" || c.req.path === "/inspector") return next();

    const header = c.req.header("X-API-Key") ?? "";
    const bearer = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const token = bearer || header;

    const result = validateToken(token);
    if (!result.ok) {
      c.status(401);
      return c.json({ error: "unauthorized", detail: result.reason });
    }

    // Scope check (if required)
    if (requiredScopes && result.scopes) {
      const has = requiredScopes.some((s) => result.scopes!.includes(s));
      if (!has) {
        c.status(403);
        return c.json({ error: "forbidden", detail: `Requires one of: ${requiredScopes.join(", ")}` });
      }
    }

    c.set("auth_label", result.label ?? "unknown");
    c.set("auth_scopes", result.scopes ?? []);
    await next();
  };
}

// ── Generate a new API key ──────────────────────────────────────────────────────

/**
 * Generate a cryptographically random API key.
 * @param label human-friendly label (e.g. "admin", "ci-user")
 * @returns object with plainKey (show once!) and the env line to add
 */
export function generateKey(label: string): { plainKey: string; envLine: string } {
  const plainKey = `zk_${randomBytes(KEY_LENGTH).toString("base64url")}`;
  const keyIndex = _keys.length + 1;
  return {
    plainKey,
    envLine: `X_API_KEY_${keyIndex}=${label}:${plainKey}`,
  };
}

// ── Internal helpers ────────────────────────────────────────────────────────────

function _hashKey(key: string): { salt: string; hash: string } {
  const salt = randomBytes(SALT_LENGTH).toString("hex");
  const hash = createHash("sha256").update(salt + key).digest("hex");
  return { salt, hash };
}

function _verifyKey(key: string, salt: string, storedHash: string): boolean {
  const computed = createHash("sha256").update(salt + key).digest("hex");
  // Timing-safe comparison to prevent timing attacks
  const buf1 = Buffer.from(computed, "hex");
  const buf2 = Buffer.from(storedHash, "hex");
  return buf1.length === buf2.length && timingSafeEqual(buf1, buf2);
}
