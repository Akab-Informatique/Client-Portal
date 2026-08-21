/**
 * Server-side signed session cookies (HMAC-SHA256).
 * Never trust localStorage for auth — validate this on every API call.
 */

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export const SESSION_COOKIE = "akab_session";
export const MFA_PENDING_COOKIE = "akab_mfa_pending";

const MAX_SESSION_AGE_SEC = 60 * 60 * 12; // 12h
const MAX_MFA_PENDING_AGE_SEC = 60 * 15; // 15m

export type SessionPayload = {
  /** user id */
  uid: number;
  /** issued at (unix sec) */
  iat: number;
  /** expires at (unix sec) */
  exp: number;
  /** random jti */
  jti: string;
};

export type MfaPendingPayload = {
  uid: number;
  email: string;
  name: string;
  kind: "challenge" | "enroll";
  /** base32 secret while enrolling (not yet persisted) */
  setupSecret?: string;
  iat: number;
  exp: number;
  jti: string;
};

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

/** Prefer SESSION_SECRET; fall back to DB password only to avoid breaking boots — still server-side only. */
export function getSessionSecret(): string {
  const explicit =
    cleanEnv(process.env.SESSION_SECRET) ||
    cleanEnv(process.env.AKAB_SESSION_SECRET);
  if (explicit && explicit.length >= 16) return explicit;
  const fallback = cleanEnv(process.env.POSTGRES_PASSWORD) || "";
  if (fallback && fallback.length >= 8) {
    return `akab-session:${fallback}`;
  }
  // Dev-only last resort — production must set SESSION_SECRET
  return "akab-dev-insecure-session-secret-change-me";
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(Buffer.from(JSON.stringify(obj), "utf8"));
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64");
}

function sign(payloadB64: string, secret: string): string {
  return b64url(
    createHmac("sha256", secret).update(payloadB64).digest(),
  );
}

function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

function encodeToken(payload: object, secret: string): string {
  const body = b64urlJson(payload);
  const sig = sign(body, secret);
  return `${body}.${sig}`;
}

function decodeToken<T extends { exp?: number }>(
  token: string | null | undefined,
  secret: string,
): T | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const expected = sign(body, secret);
  if (!safeEqualStr(sig, expected)) return null;
  try {
    const json = JSON.parse(fromB64url(body).toString("utf8")) as T;
    if (json.exp != null && Date.now() / 1000 > Number(json.exp)) return null;
    return json;
  } catch {
    return null;
  }
}

export function parseCookies(
  req: VercelRequest | { headers?: { cookie?: string | string[] } },
): Record<string, string> {
  const raw = req.headers?.cookie;
  const header = Array.isArray(raw) ? raw.join(";") : String(raw || "");
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function cookieSecure(): boolean {
  const v = cleanEnv(process.env.COOKIE_SECURE).toLowerCase();
  if (v === "0" || v === "false") return false;
  if (v === "1" || v === "true") return true;
  // Many lab installs hit the portal over plain HTTP (:3000). Secure cookies
  // would never stick there. Prefer explicit COOKIE_SECURE=true behind HTTPS.
  // Also honor common reverse-proxy signals when present on process env.
  const publicUrl =
    cleanEnv(process.env.PUBLIC_URL) ||
    cleanEnv(process.env.APP_URL) ||
    cleanEnv(process.env.BASE_URL);
  if (publicUrl.toLowerCase().startsWith("https://")) return true;
  return false;
}

function serializeCookie(
  name: string,
  value: string,
  opts: { maxAge: number; httpOnly?: boolean },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`,
  ];
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (cookieSecure()) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(name: string): string {
  return serializeCookie(name, "", { maxAge: 0 });
}

export function appendSetCookie(res: VercelResponse, cookie: string): void {
  const prev = res.getHeader("Set-Cookie");
  if (!prev) {
    res.setHeader("Set-Cookie", cookie);
    return;
  }
  if (Array.isArray(prev)) {
    res.setHeader("Set-Cookie", [...prev, cookie]);
    return;
  }
  res.setHeader("Set-Cookie", [String(prev), cookie]);
}

export function createSessionToken(userId: number): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    uid: userId,
    iat: now,
    exp: now + MAX_SESSION_AGE_SEC,
    jti: b64url(randomBytes(16)),
  };
  return encodeToken(payload, getSessionSecret());
}

export function setSessionCookie(res: VercelResponse, userId: number): void {
  const token = createSessionToken(userId);
  appendSetCookie(
    res,
    serializeCookie(SESSION_COOKIE, token, {
      maxAge: MAX_SESSION_AGE_SEC,
      httpOnly: true,
    }),
  );
}

export function clearSessionCookie(res: VercelResponse): void {
  appendSetCookie(res, clearCookie(SESSION_COOKIE));
  appendSetCookie(res, clearCookie(MFA_PENDING_COOKIE));
}

export function readSession(
  req: VercelRequest,
): SessionPayload | null {
  const cookies = parseCookies(req);
  return decodeToken<SessionPayload>(
    cookies[SESSION_COOKIE],
    getSessionSecret(),
  );
}

export function createMfaPendingToken(
  payload: Omit<MfaPendingPayload, "iat" | "exp" | "jti">,
): string {
  const now = Math.floor(Date.now() / 1000);
  const full: MfaPendingPayload = {
    ...payload,
    iat: now,
    exp: now + MAX_MFA_PENDING_AGE_SEC,
    jti: b64url(randomBytes(12)),
  };
  return encodeToken(full, getSessionSecret());
}

export function setMfaPendingCookie(
  res: VercelResponse,
  payload: Omit<MfaPendingPayload, "iat" | "exp" | "jti">,
): void {
  const token = createMfaPendingToken(payload);
  appendSetCookie(
    res,
    serializeCookie(MFA_PENDING_COOKIE, token, {
      maxAge: MAX_MFA_PENDING_AGE_SEC,
      httpOnly: true,
    }),
  );
}

export function clearMfaPendingCookie(res: VercelResponse): void {
  appendSetCookie(res, clearCookie(MFA_PENDING_COOKIE));
}

export function readMfaPending(
  req: VercelRequest,
): MfaPendingPayload | null {
  const cookies = parseCookies(req);
  return decodeToken<MfaPendingPayload>(
    cookies[MFA_PENDING_COOKIE],
    getSessionSecret(),
  );
}

export function getRequestSessionUserId(req: VercelRequest): number | null {
  const s = readSession(req);
  if (!s || !Number.isFinite(s.uid) || s.uid <= 0) return null;
  return s.uid;
}
