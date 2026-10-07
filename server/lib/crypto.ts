import crypto from "node:crypto";
import * as OTPAuth from "otpauth";
import { config } from "../config.ts";

// ── Passwords: scrypt, per-password salt ──────────────────────────────────────
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

function scrypt(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number) {
  return new Promise<Buffer>((resolve, reject) =>
    crypto.scrypt(password.normalize("NFKC"), salt, keylen, { N, r, p, maxmem: SCRYPT.maxmem }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** Hash of a random password — used to spend the same time when the email is unknown. */
let dummyHash: Promise<string> | null = null;

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    dummyHash ??= hashPassword(crypto.randomUUID());
    await verifyPassword(password, await dummyHash);
    return false;
  }
  const [alg, N, r, p, saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64url");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64url"), Number(N), Number(r), Number(p), expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Password policy shared by every password-setting path. */
export function passwordProblem(password: string): "short" | "long" | null {
  if (password.length < 12) return "short";
  if (password.length > 200) return "long";
  return null;
}

/** Readable temporary password (shown once to the admin). */
export function temporaryPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i === 3 || i === 7 || i === 11) out += "-";
  }
  return out;
}

// ── Tokens ────────────────────────────────────────────────────────────────────
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// ── Secrets at rest: AES-256-GCM with a key derived from APP_SECRET ─────────────
const key = crypto.createHash("sha256").update(`akab-seal:${config.appSecret}`).digest();

export function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url")}`;
}

export function unseal(sealed: string | null | undefined): string | null {
  if (!sealed?.startsWith("v1.")) return null;
  try {
    const raw = Buffer.from(sealed.slice(3), "base64url");
    const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ── TOTP (authenticator apps) ───────────────────────────────────────────────────
export function newTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

export function totpUri(secretBase32: string, account: string): string {
  return new OTPAuth.TOTP({
    issuer: "AKAB Portal",
    label: account,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  }).toString();
}

/** Time-step of a valid code (±1 step tolerance), or null. */
export function totpStep(secretBase32: string, code: string): number | null {
  const token = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(token)) return null;
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const delta = totp.validate({ token, window: 1 });
  if (delta === null) return null;
  return Math.floor(Date.now() / 30_000) + delta;
}
