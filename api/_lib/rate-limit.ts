/**
 * In-memory sliding-window rate limiter (per process).
 * Good enough for single-node Docker deploys; not a distributed store.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/** Prune occasionally so the map does not grow forever. */
function prune(now: number): void {
  if (buckets.size < 500) return;
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
}

export function rateLimit(opts: {
  key: string;
  limit: number;
  windowMs: number;
}): { allowed: boolean; remaining: number; retryAfterSec: number } {
  const now = Date.now();
  prune(now);
  const existing = buckets.get(opts.key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(opts.key, { count: 1, resetAt: now + opts.windowMs });
    return {
      allowed: true,
      remaining: Math.max(0, opts.limit - 1),
      retryAfterSec: Math.ceil(opts.windowMs / 1000),
    };
  }
  existing.count += 1;
  const retryAfterSec = Math.max(
    1,
    Math.ceil((existing.resetAt - now) / 1000),
  );
  if (existing.count > opts.limit) {
    return { allowed: false, remaining: 0, retryAfterSec };
  }
  return {
    allowed: true,
    remaining: Math.max(0, opts.limit - existing.count),
    retryAfterSec,
  };
}

export function clientIp(req: {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}): string {
  const headers = req.headers || {};
  const fwd = headers["x-forwarded-for"];
  const fwdStr = Array.isArray(fwd) ? fwd[0] : String(fwd || "");
  if (fwdStr) return fwdStr.split(",")[0]?.trim() || "unknown";
  const real = headers["x-real-ip"];
  const realStr = Array.isArray(real) ? real[0] : String(real || "");
  if (realStr) return realStr.trim();
  return String(req.socket?.remoteAddress || "unknown");
}

/** Clear a key (e.g. after successful auth). */
export function rateLimitReset(key: string): void {
  buckets.delete(key);
}
