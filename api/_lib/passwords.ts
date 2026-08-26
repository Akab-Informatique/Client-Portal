/**
 * Password hashing (bcrypt) with transparent upgrade from legacy plaintext.
 * Never store or compare passwords in plain text.
 */

import bcrypt from "bcryptjs";
import { timingSafeEqual } from "crypto";

const BCRYPT_ROUNDS = 12;
const BCRYPT_RE = /^\$2[aby]?\$\d{2}\$/;

export function isPasswordHashed(stored: string | null | undefined): boolean {
  return Boolean(stored && BCRYPT_RE.test(String(stored)));
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(String(plain), BCRYPT_ROUNDS);
}

/**
 * Verify password. Returns { ok, needsRehash } so callers can upgrade
 * legacy plaintext rows on successful login without a mass migration.
 */
export async function verifyPassword(
  plain: string,
  stored: string | null | undefined,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  const p = String(plain ?? "");
  const s = String(stored ?? "");
  if (!p || !s) {
    // Burn a constant amount of work to reduce timing oracles on missing rows
    await bcrypt.hash("akab-timing-pad", BCRYPT_ROUNDS);
    return { ok: false, needsRehash: false };
  }
  if (isPasswordHashed(s)) {
    const ok = await bcrypt.compare(p, s);
    return { ok, needsRehash: false };
  }
  // Legacy plaintext (bootstrap / pre-hash installs)
  const ok = safeEqualUtf8(p, s);
  return { ok, needsRehash: ok };
}

function safeEqualUtf8(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still compare against self to keep a branch
    timingSafeEqual(ab, ab);
    return false;
  }
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}
