/**
 * Multi-factor authentication helpers (browser-safe Web Crypto).
 * Primary: TOTP (RFC 6238) for authenticator apps.
 * Backup: emailed 6-digit OTP + one-time recovery codes.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function bytesToBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32ToBytes(input: string): Uint8Array {
  const cleaned = input.replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function generateTotpSecret(bytes = 20): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return bytesToBase32(arr);
}

export function buildOtpAuthUri(opts: {
  secret: string;
  accountName: string;
  issuer?: string;
}): string {
  const issuer = opts.issuer || "AKAB Portal";
  const label = encodeURIComponent(`${issuer}:${opts.accountName}`);
  const params = new URLSearchParams({
    secret: opts.secret.replace(/\s+/g, ""),
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

async function hmacSha1(
  keyBytes: Uint8Array,
  msg: ArrayBuffer,
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, msg);
}

function counterBuffer(counter: number): ArrayBuffer {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  // big-endian 64-bit; JS safe int fits high=0
  const high = Math.floor(counter / 0x100000000);
  const low = counter >>> 0;
  view.setUint32(0, high);
  view.setUint32(4, low);
  return buf;
}

export async function generateTotp(
  secretBase32: string,
  opts?: { timeMs?: number; stepSeconds?: number; digits?: number },
): Promise<string> {
  const step = opts?.stepSeconds ?? 30;
  const digits = opts?.digits ?? 6;
  const timeMs = opts?.timeMs ?? Date.now();
  const counter = Math.floor(timeMs / 1000 / step);
  const key = base32ToBytes(secretBase32);
  const mac = new Uint8Array(await hmacSha1(key, counterBuffer(counter)));
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  const mod = 10 ** digits;
  return String(bin % mod).padStart(digits, "0");
}

export async function verifyTotp(
  secretBase32: string,
  token: string,
  opts?: { window?: number; stepSeconds?: number },
): Promise<boolean> {
  const cleaned = (token || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleaned)) return false;
  if (!secretBase32?.trim()) return false;
  const window = opts?.window ?? 1;
  const step = opts?.stepSeconds ?? 30;
  const now = Date.now();
  for (let w = -window; w <= window; w++) {
    const code = await generateTotp(secretBase32, {
      timeMs: now + w * step * 1000,
      stepSeconds: step,
    });
    if (code === cleaned) return true;
  }
  return false;
}

export function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = new Uint8Array(5);
    crypto.getRandomValues(bytes);
    // 10 hex chars grouped 5-5
    const hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 10)
      .toUpperCase();
    codes.push(`${hex.slice(0, 5)}-${hex.slice(5)}`);
  }
  return codes;
}

export async function hashRecoveryCodes(codes: string[]): Promise<string[]> {
  return Promise.all(
    codes.map((c) => sha256Hex(c.replace(/\s+/g, "").toUpperCase())),
  );
}

export function parseRecoveryHashes(json: string | null | undefined): string[] {
  if (!json?.trim()) return [];
  try {
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

export async function consumeRecoveryCode(
  storedJson: string | null | undefined,
  code: string,
): Promise<{ ok: true; remainingJson: string } | { ok: false }> {
  const hashes = parseRecoveryHashes(storedJson);
  if (!hashes.length) return { ok: false };
  const target = await sha256Hex(code.replace(/\s+/g, "").toUpperCase());
  const idx = hashes.indexOf(target);
  if (idx < 0) return { ok: false };
  const next = hashes.filter((_, i) => i !== idx);
  return { ok: true, remainingJson: JSON.stringify(next) };
}

export function generateEmailOtp(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, "0");
}

export async function hashEmailOtp(code: string): Promise<string> {
  return sha256Hex(code.replace(/\s+/g, ""));
}

export function emailOtpExpiryIso(minutes = 10): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function isEmailOtpExpired(iso: string | null | undefined): boolean {
  if (!iso) return true;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return true;
  return Date.now() > t;
}

/** Opaque pending-setup token (localStorage) — not a full session. */
export function createPendingToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export type MfaUserFields = {
  mfa_enabled?: boolean | null;
  mfa_totp_secret?: string | null;
  mfa_recovery_codes?: string | null;
  mfa_email_code_hash?: string | null;
  mfa_email_code_expires?: string | null;
};

export function isMfaEnabled(user: MfaUserFields | null | undefined): boolean {
  return Boolean(user?.mfa_enabled && user?.mfa_totp_secret);
}
