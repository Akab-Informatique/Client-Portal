import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { HTTPException } from "hono/http-exception";
import { config } from "../config.ts";

/** Visitor IP. Forwarded headers count only when the peer is a trusted proxy. */
export function clientIp(c: Context): string {
  let peer = "unknown";
  try {
    peer = (getConnInfo(c).remote.address || "unknown").replace(/^::ffff:/, "");
  } catch {
    /* not running on node-server (tests) */
  }
  const trusted = config.trustedProxies.includes(peer) || peer === "127.0.0.1" || peer === "::1";
  if (!trusted) return peer;
  const real = c.req.header("x-real-ip")?.trim();
  if (real) return real;
  const hops = (c.req.header("x-forwarded-for") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return hops[hops.length - 1] || peer;
}

/**
 * CSRF defence for state-changing requests: JSON body only (no simple HTML
 * form posts) and the Origin must be this site.
 */
export const sameOriginJson: MiddlewareHandler = async (c, next) => {
  const m = c.req.method;
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
  const ct = c.req.header("content-type") || "";
  const hasBody = m !== "DELETE";
  if (hasBody && !ct.toLowerCase().startsWith("application/json")) {
    throw new HTTPException(415, { message: "JSON required" });
  }
  const origin = c.req.header("origin");
  if (origin) {
    const host = c.req.header("x-forwarded-host") || c.req.header("host") || "";
    const allowed = new Set<string>([`http://${host}`, `https://${host}`].map((s) => s.toLowerCase()));
    if (config.publicUrl) allowed.add(new URL(config.publicUrl).origin.toLowerCase());
    if (!allowed.has(origin.toLowerCase())) throw new HTTPException(403, { message: "Bad origin" });
  } else if (config.production) {
    // Browsers always send Origin on cross-site POST/PATCH/DELETE; require it in prod.
    const site = c.req.header("sec-fetch-site");
    if (site && site !== "same-origin") throw new HTTPException(403, { message: "Bad origin" });
  }
  await next();
};

// ── Small in-memory rate limiter (single server) ─────────────────────────────
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  if (buckets.size > 5000) for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  b.count++;
  return { ok: b.count <= limit, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
}

export function resetRateLimit(key: string) {
  buckets.delete(key);
}

export function badRequest(message: string, details?: unknown): never {
  throw new HTTPException(400, { message, cause: details });
}
export function forbidden(message = "Forbidden"): never {
  throw new HTTPException(403, { message });
}
export function notFound(message = "Not found"): never {
  throw new HTTPException(404, { message });
}
