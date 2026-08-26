/**
 * Server-side auth helpers: user load, session DTO, MFA (Node crypto).
 * Never import from the browser bundle.
 */

import { createHmac, createHash, randomBytes, timingSafeEqual } from "crypto";
import { getPool } from "./pg.js";
import type { SessionPayload } from "./session.js";

export type DbUser = {
  id: number;
  email: string;
  password: string;
  name: string;
  role: string;
  company_id: number | null;
  active: boolean;
  staff_role_id: number | null;
  client_role_id: number | null;
  billing_access: boolean | null;
  job_title: string | null;
  phone: string | null;
  mobile: string | null;
  bio: string | null;
  locale: string | null;
  itglue_user_id: string | null;
  datto_web_remote_device_uids: string | null;
  board_email_opt_in: boolean | null;
  mfa_enabled: boolean | null;
  mfa_totp_secret: string | null;
  mfa_recovery_codes: string | null;
  mfa_email_code_hash: string | null;
  mfa_email_code_expires: string | null;
  created_at: Date | string | null;
};

export type SessionUserDto = {
  id: number;
  email: string;
  name: string;
  role: string;
  company_id: number | null;
  active: boolean;
  staff_role_id: number | null;
  client_role_id: number | null;
  billing_access: boolean | null;
  job_title: string | null;
  phone: string | null;
  mobile: string | null;
  bio: string | null;
  locale: string | null;
  itglue_user_id: string | null;
  datto_web_remote_device_uids: string | null;
  board_email_opt_in: boolean;
  mfa_enabled: boolean;
  created_at: string | null;
  permissions: Record<string, boolean> | null;
  staff_role_name: string | null;
  staff_role_slug: string | null;
  client_role_name: string | null;
  client_role_slug: string | null;
  client_role_names: string[];
  client_role_slugs: string[];
  billing_enabled: boolean;
  client_permissions: Record<string, boolean> | null;
};

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32ToBytes(input: string): Buffer {
  const cleaned = input.replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function generateTotpSecret(bytes = 20): string {
  const buf = randomBytes(bytes);
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
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

/**
 * Render TOTP QR locally as a data: URL — never send the secret to a third party.
 */
export async function totpQrDataUrl(
  otpauthUri: string,
  size = 200,
): Promise<string> {
  const s = Math.min(Math.max(size, 120), 400);
  const QRCode = await import("qrcode");
  return QRCode.toDataURL(otpauthUri, {
    width: s,
    margin: 2,
    errorCorrectionLevel: "M",
  });
}

/** @deprecated use totpQrDataUrl — kept name for call-site search; throws if misused */
export function totpQrImageUrl(_otpauthUri: string, _size = 200): string {
  throw new Error(
    "totpQrImageUrl removed — use async totpQrDataUrl (local QR, no third party)",
  );
}

function generateTotpCode(secretBase32: string, timeMs = Date.now()): string {
  const step = 30;
  const counter = Math.floor(timeMs / 1000 / step);
  const key = base32ToBytes(secretBase32);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac("sha1", key).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(bin % 1_000_000).padStart(6, "0");
}

export function verifyTotp(secretBase32: string, token: string): boolean {
  const cleaned = (token || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleaned)) return false;
  if (!secretBase32?.trim()) return false;
  const now = Date.now();
  for (let w = -1; w <= 1; w++) {
    const code = generateTotpCode(secretBase32, now + w * 30_000);
    const a = Buffer.from(code);
    const b = Buffer.from(cleaned);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

export function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const hex = randomBytes(5).toString("hex").slice(0, 10).toUpperCase();
    codes.push(`${hex.slice(0, 5)}-${hex.slice(5)}`);
  }
  return codes;
}

export function hashRecoveryCodes(codes: string[]): string[] {
  return codes.map((c) => sha256Hex(c.replace(/\s+/g, "").toUpperCase()));
}

export function consumeRecoveryCode(
  storedJson: string | null | undefined,
  code: string,
): { ok: true; remainingJson: string } | { ok: false } {
  let hashes: string[] = [];
  try {
    const arr = storedJson ? (JSON.parse(storedJson) as unknown) : [];
    if (Array.isArray(arr)) {
      hashes = arr.filter((x): x is string => typeof x === "string");
    }
  } catch {
    return { ok: false };
  }
  if (!hashes.length) return { ok: false };
  const target = sha256Hex(code.replace(/\s+/g, "").toUpperCase());
  const idx = hashes.indexOf(target);
  if (idx < 0) return { ok: false };
  const next = hashes.filter((_, i) => i !== idx);
  return { ok: true, remainingJson: JSON.stringify(next) };
}

export function generateEmailOtp(): string {
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

export function hashEmailOtp(code: string): string {
  return sha256Hex(code.replace(/\s+/g, ""));
}

export function emailOtpExpiryIso(minutes = 10): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function isEmailOtpExpired(iso: string | null | undefined): boolean {
  if (!iso) return true;
  const t = Date.parse(iso);
  return !Number.isFinite(t) || Date.now() > t;
}

export function isMfaEnabled(user: {
  mfa_enabled?: boolean | null;
  mfa_totp_secret?: string | null;
}): boolean {
  return Boolean(user?.mfa_enabled && user?.mfa_totp_secret);
}

function mapUser(row: Record<string, unknown>): DbUser {
  return {
    id: Number(row.id),
    email: String(row.email ?? ""),
    password: String(row.password ?? ""),
    name: String(row.name ?? ""),
    role: String(row.role ?? ""),
    company_id: row.company_id == null ? null : Number(row.company_id),
    active: Boolean(row.active),
    staff_role_id:
      row.staff_role_id == null ? null : Number(row.staff_role_id),
    client_role_id:
      row.client_role_id == null ? null : Number(row.client_role_id),
    billing_access:
      row.billing_access == null ? null : Boolean(row.billing_access),
    job_title: row.job_title == null ? null : String(row.job_title),
    phone: row.phone == null ? null : String(row.phone),
    mobile: row.mobile == null ? null : String(row.mobile),
    bio: row.bio == null ? null : String(row.bio),
    locale: row.locale == null ? null : String(row.locale),
    itglue_user_id:
      row.itglue_user_id == null ? null : String(row.itglue_user_id),
    datto_web_remote_device_uids:
      row.datto_web_remote_device_uids == null
        ? null
        : String(row.datto_web_remote_device_uids),
    board_email_opt_in:
      row.board_email_opt_in == null ? null : Boolean(row.board_email_opt_in),
    mfa_enabled: row.mfa_enabled == null ? null : Boolean(row.mfa_enabled),
    mfa_totp_secret:
      row.mfa_totp_secret == null ? null : String(row.mfa_totp_secret),
    mfa_recovery_codes:
      row.mfa_recovery_codes == null ? null : String(row.mfa_recovery_codes),
    mfa_email_code_hash:
      row.mfa_email_code_hash == null
        ? null
        : String(row.mfa_email_code_hash),
    mfa_email_code_expires:
      row.mfa_email_code_expires == null
        ? null
        : String(row.mfa_email_code_expires),
    session_epoch:
      row.session_epoch == null || row.session_epoch === ""
        ? 0
        : Number(row.session_epoch) || 0,
    created_at: (row.created_at as Date | string | null) ?? null,
  };
}

/**
 * Invalidate all outstanding session cookies for this user.
 * Call on logout, password change, MFA disable / re-enroll.
 */
export async function bumpSessionEpoch(userId: number): Promise<number> {
  if (!Number.isFinite(userId) || userId <= 0) return 0;
  const p = getPool();
  try {
    const r = await p.query(
      `UPDATE users
       SET session_epoch = COALESCE(session_epoch, 0) + 1
       WHERE id = $1
       RETURNING session_epoch`,
      [userId],
    );
    return Number((r.rows[0] as { session_epoch?: number } | undefined)?.session_epoch ?? 0);
  } catch (err) {
    // Column may not exist until migrate runs — non-fatal
    console.warn("[auth] bumpSessionEpoch failed", err);
    return 0;
  }
}

export async function loadUserById(id: number): Promise<DbUser | null> {
  if (!Number.isFinite(id) || id <= 0) return null;
  const p = getPool();
  const r = await p.query(`SELECT * FROM users WHERE id = $1 LIMIT 1`, [id]);
  if (!r.rows[0]) return null;
  return mapUser(r.rows[0] as Record<string, unknown>);
}

export async function loadUserByEmail(email: string): Promise<DbUser | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const p = getPool();
  const r = await p.query(
    `SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1`,
    [normalized],
  );
  if (!r.rows[0]) return null;
  return mapUser(r.rows[0] as Record<string, unknown>);
}

function parseJsonMap(raw: string | null | undefined): Record<string, boolean> {
  if (!raw?.trim()) return {};
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(o || {})) {
      out[k] = Boolean(v);
    }
    return out;
  } catch {
    return {};
  }
}

export async function toSessionUserDto(user: DbUser): Promise<SessionUserDto> {
  const p = getPool();
  let permissions: Record<string, boolean> | null = null;
  let staff_role_name: string | null = null;
  let staff_role_slug: string | null = null;

  if (user.role === "admin" || user.role === "technician") {
    if (user.staff_role_id) {
      const rr = await p.query(
        `SELECT name, slug, permissions FROM staff_roles WHERE id = $1 LIMIT 1`,
        [user.staff_role_id],
      );
      const row = rr.rows[0] as
        | { name?: string; slug?: string; permissions?: string }
        | undefined;
      if (row) {
        staff_role_name = row.name ?? null;
        staff_role_slug = row.slug ?? null;
        permissions = parseJsonMap(row.permissions);
      }
    }
    if (user.role === "admin" && !permissions) {
      // Full admin fallback
      permissions = null;
    }
  }

  let client_permissions: Record<string, boolean> | null = null;
  let client_role_name: string | null = null;
  let client_role_slug: string | null = null;
  const client_role_names: string[] = [];
  const client_role_slugs: string[] = [];
  let billing_enabled = Boolean(user.billing_access);

  if (user.role === "client" && user.company_id) {
    const merged: Record<string, boolean> = {};
    try {
      const mem = await p.query(
        `SELECT r.name, r.slug, r.permissions
         FROM client_user_roles cur
         JOIN client_roles r ON r.id = cur.role_id
         WHERE cur.user_id = $1 AND cur.company_id = $2 AND r.active = true`,
        [user.id, user.company_id],
      );
      for (const row of mem.rows as Array<{
        name?: string;
        slug?: string;
        permissions?: string;
      }>) {
        if (row.name) client_role_names.push(row.name);
        if (row.slug) client_role_slugs.push(row.slug);
        const m = parseJsonMap(row.permissions);
        for (const [k, v] of Object.entries(m)) {
          if (v) merged[k] = true;
        }
      }
    } catch {
      /* older schema without client_user_roles */
    }
    if (user.client_role_id) {
      const rr = await p.query(
        `SELECT name, slug, permissions FROM client_roles WHERE id = $1 LIMIT 1`,
        [user.client_role_id],
      );
      const row = rr.rows[0] as
        | { name?: string; slug?: string; permissions?: string }
        | undefined;
      if (row) {
        client_role_name = row.name ?? null;
        client_role_slug = row.slug ?? null;
        if (!client_role_names.length && row.name) client_role_names.push(row.name);
        if (!client_role_slugs.length && row.slug) client_role_slugs.push(row.slug);
        const m = parseJsonMap(row.permissions);
        for (const [k, v] of Object.entries(m)) {
          if (v) merged[k] = true;
        }
      }
    }
    if (merged.billing) billing_enabled = true;
    client_permissions = merged;
  }

  const created =
    user.created_at instanceof Date
      ? user.created_at.toISOString()
      : user.created_at
        ? String(user.created_at)
        : null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    company_id: user.company_id,
    active: user.active,
    staff_role_id: user.staff_role_id,
    client_role_id: user.client_role_id,
    billing_access: user.billing_access,
    job_title: user.job_title,
    phone: user.phone,
    mobile: user.mobile,
    bio: user.bio,
    locale: user.locale,
    itglue_user_id: user.itglue_user_id,
    datto_web_remote_device_uids: user.datto_web_remote_device_uids,
    board_email_opt_in: user.board_email_opt_in === false ? false : true,
    mfa_enabled: isMfaEnabled(user),
    created_at: created,
    permissions,
    staff_role_name,
    staff_role_slug,
    client_role_name,
    client_role_slug,
    client_role_names,
    client_role_slugs,
    billing_enabled,
    client_permissions: user.role === "client" ? client_permissions : null,
  };
}

export async function requireSessionUser(
  session: SessionPayload | null,
): Promise<DbUser | null> {
  if (!session) return null;
  const user = await loadUserById(session.uid);
  if (!user || !user.active) return null;
  return user;
}

/** Safe user projection — never includes password / MFA secrets. */
export function publicUserFields(user: DbUser): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    company_id: user.company_id,
    active: user.active,
    staff_role_id: user.staff_role_id,
    client_role_id: user.client_role_id,
    billing_access: user.billing_access,
    job_title: user.job_title,
    phone: user.phone,
    mobile: user.mobile,
    bio: user.bio,
    locale: user.locale,
    itglue_user_id: user.itglue_user_id,
    datto_web_remote_device_uids: user.datto_web_remote_device_uids,
    board_email_opt_in: user.board_email_opt_in,
    mfa_enabled: isMfaEnabled(user),
    created_at: user.created_at,
  };
}
