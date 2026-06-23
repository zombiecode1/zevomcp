import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// ── Constants ──────────────────────────────────────────────────────────────────
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;        // 256 bits
const SALT_LENGTH = 32;
const ITERATIONS = 100_000;   // PBKDF2 iterations

// ── Key derivation ──────────────────────────────────────────────────────────────

/**
 * Derive a 256-bit AES key from a passphrase + random salt.
 * The salt is prepended to the ciphertext so decryption can re-derive the key.
 */
function _deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LENGTH, { N: ITERATIONS });
}

// ── Encrypt ─────────────────────────────────────────────────────────────────────

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Output format (hex-encoded): salt + iv + tag + ciphertext
 *
 * @param plaintext - The value to encrypt (e.g. an API key)
 * @param passphrase - The passphrase the user keeps secret (from .env → ENCRYPTION_KEY)
 * @returns hex-encoded string containing {salt}{iv}{tag}{ciphertext}
 */
export function encrypt(plaintext: string, passphrase: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const key = _deriveKey(passphrase, salt);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Concatenate: salt || iv || tag || ciphertext
  return Buffer.concat([salt, iv, tag, encrypted]).toString("hex");
}

// ── Decrypt ─────────────────────────────────────────────────────────────────────

/**
 * Decrypts a hex-encoded ciphertext that was created by `encrypt()`.
 *
 * @param cipherHex - The hex string from `encrypt()`
 * @param passphrase - The same passphrase used for encryption
 * @returns original plaintext
 */
export function decrypt(cipherHex: string, passphrase: string): string {
  const raw = Buffer.from(cipherHex, "hex");

  const salt = raw.subarray(0, SALT_LENGTH);
  const iv = raw.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = raw.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const ciphertext = raw.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

  const key = _deriveKey(passphrase, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return decipher.update(ciphertext) + decipher.final("utf8");
}

// ── Env file helpers ────────────────────────────────────────────────────────────

/**
 * Reads the current .env file, finds `ENCRYPTION_KEY`, and returns it.
 * If not found, generates one, writes it to .env, and returns it.
 */
export function ensureEncryptionKey(envPath: string): string {
  try {
    const content = readFileSync(envPath, "utf8");
    const match = content.match(/^ENCRYPTION_KEY=(.+)$/m);
    if (match) return match[1].trim();
  } catch { /* file may not exist yet */ }

  const key = `zek_${randomBytes(24).toString("base64url")}`;
  try {
    writeFileSync(envPath, `\n# AES-256-GCM encryption key for stored secrets\nENCRYPTION_KEY=${key}\n`, { flag: "a" });
    console.log(`✓ Encryption key generated & saved to ${envPath}`);
  } catch { /* if file is read-only, just log */ }
  return key;
}

// ── Convenience wrappers using the env key ──────────────────────────────────────

let _cachedEncryptionKey: string | null = null;

function _getKey(): string {
  if (_cachedEncryptionKey) return _cachedEncryptionKey;
  _cachedEncryptionKey = process.env["ENCRYPTION_KEY"] ?? "";
  if (!_cachedEncryptionKey) {
    console.warn("⚠ ENCRYPTION_KEY not set — secrets stored in plain text");
  }
  return _cachedEncryptionKey;
}

/** Encrypt using the ENCRYPTION_KEY from env. Falls back to plain text. */
export function encryptWithEnvKey(plaintext: string): string {
  const key = _getKey();
  if (!key) return plaintext;       // no encryption = stored as-is
  return encrypt(plaintext, key);
}

/** Decrypt using the ENCRYPTION_KEY from env. If not encrypted, returns as-is. */
export function decryptWithEnvKey(cipherHex: string): string {
  const key = _getKey();
  if (!key) return cipherHex;       // passthrough
  try {
    return decrypt(cipherHex, key);
  } catch {
    return cipherHex;               // was plain text, not encrypted
  }
}
