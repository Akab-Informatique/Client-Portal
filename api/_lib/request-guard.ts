/**
 * CSRF / Origin checks for cookie-authenticated mutating requests.
 */

import type { VercelRequest } from "@vercel/node";

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

function originFromUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

function allowedOrigins(req: VercelRequest): Set<string> {
  const out = new Set<string>();
  for (const key of ["PUBLIC_URL", "APP_URL", "BASE_URL"] as const) {
    const o = originFromUrl(cleanEnv(process.env[key]));
    if (o) out.add(o);
  }
  const host = req.headers?.host;
  const hostStr = Array.isArray(host) ? host[0] : String(host || "");
  if (hostStr) {
    out.add(`http://${hostStr}`.toLowerCase());
    out.add(`https://${hostStr}`.toLowerCase());
  }
  // Common loopback hosts for lab / upgrade scripts
  for (const h of ["127.0.0.1", "localhost"]) {
    out.add(`http://${h}:3000`);
    out.add(`https://${h}:3000`);
    out.add(`http://${h}`);
    out.add(`https://${h}`);
  }
  return out;
}

/**
 * Reject cross-site POSTs that present a foreign Origin/Referer.
 * Same-origin SPA fetches always send Origin matching Host.
 * Returns null when OK, or an error string when blocked.
 */
export function assertSameOrigin(req: VercelRequest): string | null {
  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return null;
  }

  const originRaw = req.headers?.origin;
  const originHdr = Array.isArray(originRaw)
    ? originRaw[0]
    : String(originRaw || "");
  const refererRaw = req.headers?.referer ?? req.headers?.referrer;
  const refererHdr = Array.isArray(refererRaw)
    ? refererRaw[0]
    : String(refererRaw || "");

  const allowed = allowedOrigins(req);

  if (originHdr) {
    const o = originFromUrl(originHdr);
    if (o && allowed.has(o)) return null;
    // Some tooling sends Origin: null
    if (originHdr === "null") return "Cross-origin request blocked.";
    return "Cross-origin request blocked.";
  }

  if (refererHdr) {
    const o = originFromUrl(refererHdr);
    if (o && allowed.has(o)) return null;
    return "Cross-origin request blocked.";
  }

  // No Origin/Referer — allow same-host API clients (curl on server, health scripts).
  // Cookie-bearing browser requests almost always send Origin.
  return null;
}
