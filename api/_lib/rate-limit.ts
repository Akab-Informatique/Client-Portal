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

/**
 * Forwarded headers are only trusted when the TCP peer is the reverse proxy
 * (loopback / private network — the proxy runs on the same host or Docker
 * network). A direct internet client cannot spoof its IP with X-Forwarded-For.
 */
function isTrustedProxyPeer(addr: string): boolean {
  const a = addr.replace(/^::ffff:/, "");
  return (
    a === "127.0.0.1" ||
    a === "::1" ||
    /^10\./.test(a) ||
    /^192\.168\./.test(a) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a) ||
    /^f[cd][0-9a-f]{2}:/i.test(a)
  );
}

export function clientIp(req: {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}): string {
  const peer = String(req.socket?.remoteAddress || "unknown");
  if (!isTrustedProxyPeer(peer)) return peer;
  const headers = req.headers || {};
  const real = headers["x-real-ip"];
  const realStr = Array.isArray(real) ? real[0] : String(real || "");
  if (realStr.trim()) return realStr.trim();
  // Right-most entry is the one appended by our proxy (left ones are client-supplied)
  const fwd = headers["x-forwarded-for"];
  const fwdStr = Array.isArray(fwd) ? fwd.join(",") : String(fwd || "");
  const hops = fwdStr.split(",").map((s) => s.trim()).filter(Boolean);
  return hops[hops.length - 1] || peer;
}

/** Clear a key (e.g. after successful auth). */
export function rateLimitReset(key: string): void {
  buckets.delete(key);
}
