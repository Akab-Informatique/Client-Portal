/**
 * AES-256-GCM sealed box for third-party credentials at rest
 * (e.g. companies.sharepoint_client_secret).
 *
 * Ciphertext format: "enc:v1:" + base64url(iv || tag || ciphertext)
 * Plaintext legacy rows (no prefix) are still accepted on decrypt so
 * existing data keeps working until rewritten on next save.
 *
 * Key: CREDENTIALS_ENCRYPTION_KEY or SESSION_SECRET (32+ chars).
 * Prefer a dedicated CREDENTIALS_ENCRYPTION_KEY in production.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const PREFIX = "enc:v1:";

function cleanEnv(v: string | undefined): string {
  if (!v) return "";
  let s = String(v).trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1);
  }
  return s;
}

function keyMaterial(): Buffer {
  const raw =
    cleanEnv(process.env.CREDENTIALS_ENCRYPTION_KEY) ||
    cleanEnv(process.env.SESSION_SECRET) ||
    cleanEnv(process.env.AKAB_SESSION_SECRET);
  if (!raw || raw.length < 32) {
    throw new Error(
      "CREDENTIALS_ENCRYPTION_KEY or SESSION_SECRET (≥32 chars) required to seal secrets",
    );
  }
  // Derive a stable 32-byte key (accept hex or arbitrary string)
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  return createHash("sha256").update(raw, "utf8").digest();
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64");
}

export function isSealedSecret(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/** Encrypt plaintext for DB storage. Empty → empty. */
export function sealSecret(plaintext: string | null | undefined): string | null {
  if (plaintext == null) return null;
  const text = String(plaintext);
  if (!text) return "";
  if (isSealedSecret(text)) return text; // already sealed
  const key = keyMaterial();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + b64url(Buffer.concat([iv, tag, ct]));
}

/**
 * Decrypt sealed value, or return legacy plaintext as-is.
 * Never throws for missing/empty — returns null.
 */
export function openSecret(stored: string | null | undefined): string | null {
  if (stored == null) return null;
  const text = String(stored);
  if (!text) return "";
  if (!isSealedSecret(text)) return text; // legacy plaintext
  try {
    const raw = fromB64url(text.slice(PREFIX.length));
    if (raw.length < 12 + 16 + 1) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const key = keyMaterial();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** UI-safe flag: secret present without revealing value. */
export function secretConfiguredFlag(
  stored: string | null | undefined,
): boolean {
  return Boolean(stored && String(stored).length > 0);
}
