import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  buildOtpAuthUri,
  consumeRecoveryCode,
  emailOtpExpiryIso,
  generateEmailOtp,
  generateRecoveryCodes,
  generateTotpSecret,
  hashEmailOtp,
  hashRecoveryCodes,
  isEmailOtpExpired,
  isMfaEnabled,
  loadUserById,
  toSessionUserDto,
  totpQrDataUrl,
  verifyTotp,
} from "../_lib/auth-server.js";
import { getPool, isPostgresConfigured } from "../_lib/pg.js";
import {
  clientIp,
  rateLimit,
  rateLimitReset,
} from "../_lib/rate-limit.js";
import { assertSameOrigin } from "../_lib/request-guard.js";
import { isSmtpConfigured, sendPlainEmail } from "../_lib/smtp-client.js";
import {
  clearMfaPendingCookie,
  clearSessionCookie,
  readMfaPending,
  readSession,
  setMfaPendingCookie,
  setSessionCookie,
} from "../_lib/session.js";

type Action =
  | "verify_totp"
  | "verify_recovery"
  | "send_email"
  | "verify_email"
  | "start_enroll"
  | "confirm_enroll"
  | "disable"
  | "regenerate_recovery";

const VERIFY_ACTIONS = new Set<Action>([
  "verify_totp",
  "verify_recovery",
  "verify_email",
  "confirm_enroll",
  "disable",
  "regenerate_recovery",
]);

/**
 * POST /api/auth/mfa
 * Body: { action, code? }
 * All MFA verification and secret writes happen server-side only.
 * Verification actions are rate-limited per user and per IP.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const originErr = assertSameOrigin(req);
    if (originErr) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    if (!isPostgresConfigured()) {
      return res.status(503).json({ ok: false, error: "server_error" });
    }

    const body = (req.body ?? {}) as {
      action?: string;
      code?: string;
      totpCode?: string;
    };
    const action = String(body.action || "") as Action;
    const code = String(body.code ?? body.totpCode ?? "").trim();
    const p = getPool();
    const ip = clientIp(req);

    async function finishLogin(userId: number) {
      const user = await loadUserById(userId);
      if (!user || !user.active) return null;
      setSessionCookie(res, user.id, req);
      clearMfaPendingCookie(res, req);
      rateLimitReset(`mfa:uid:${userId}`);
      rateLimitReset(`mfa:ip:${ip}`);
      rateLimitReset(`mfa:email-send:${userId}`);
      return toSessionUserDto(user);
    }

    function checkVerifyLimits(userId: number): {
      ok: true;
    } | { ok: false; status: number; body: Record<string, unknown> } {
      const uidLimit = rateLimit({
        key: `mfa:uid:${userId}`,
        limit: 8,
        windowMs: 15 * 60_000,
      });
      const ipLimit = rateLimit({
        key: `mfa:ip:${ip}`,
        limit: 40,
        windowMs: 15 * 60_000,
      });
      if (!uidLimit.allowed || !ipLimit.allowed) {
        // Drop pending MFA cookie so lockout forces a fresh password login.
        clearMfaPendingCookie(res, req);
        return {
          ok: false,
          status: 429,
          body: {
            ok: false,
            error: "rate_limited",
            retryAfterSec: Math.max(
              uidLimit.retryAfterSec,
              ipLimit.retryAfterSec,
            ),
          },
        };
      }
      return { ok: true };
    }

    // Pre-check rate limits when we already know the uid from pending/session
    if (VERIFY_ACTIONS.has(action)) {
      const pending = readMfaPending(req);
      const session = readSession(req);
      const uid = pending?.uid ?? session?.uid;
      if (uid != null) {
        const lim = checkVerifyLimits(uid);
        if (!lim.ok) {
          res.setHeader("Retry-After", String(lim.body.retryAfterSec ?? 60));
          return res.status(lim.status).json(lim.body);
        }
      }
    }

    if (action === "verify_totp") {
      const pending = readMfaPending(req);
      if (!pending || pending.kind !== "challenge") {
        return res.status(400).json({ ok: false, error: "no_pending" });
      }
      const found = await loadUserById(pending.uid);
      if (!found || !found.active || !isMfaEnabled(found)) {
        return res.status(400).json({ ok: false, error: "no_pending" });
      }
      if (!verifyTotp(found.mfa_totp_secret || "", code)) {
        return res.status(401).json({ ok: false, error: "invalid_code" });
      }
      const dto = await finishLogin(found.id);
      return dto
        ? res.status(200).json({ ok: true, user: dto })
        : res.status(500).json({ ok: false, error: "generic" });
    }

    if (action === "verify_recovery") {
      const pending = readMfaPending(req);
      if (!pending || pending.kind !== "challenge") {
        return res.status(400).json({ ok: false, error: "no_pending" });
      }
      const found = await loadUserById(pending.uid);
      if (!found || !found.active || !isMfaEnabled(found)) {
        return res.status(400).json({ ok: false, error: "no_pending" });
      }
      const consumed = consumeRecoveryCode(found.mfa_recovery_codes, code);
      if (!consumed.ok) {
        return res.status(401).json({ ok: false, error: "invalid_code" });
      }
      await p.query(
        `UPDATE users SET mfa_recovery_codes = $1 WHERE id = $2`,
        [consumed.remainingJson, found.id],
      );
      const dto = await finishLogin(found.id);
      return dto
        ? res.status(200).json({ ok: true, user: dto })
        : res.status(500).json({ ok: false, error: "generic" });
    }

    if (action === "send_email") {
      const pending = readMfaPending(req);
      if (!pending || pending.kind !== "challenge") {
        return res.status(400).json({ ok: false, error: "no_pending" });
      }
      const found = await loadUserById(pending.uid);
      if (!found || !found.active) {
        return res.status(400).json({ ok: false, error: "no_pending" });
      }
      // Cap resends: 5 per 15 minutes per user
      const sendLimit = rateLimit({
        key: `mfa:email-send:${found.id}`,
        limit: 5,
        windowMs: 15 * 60_000,
      });
      const ipSend = rateLimit({
        key: `mfa:email-send-ip:${ip}`,
        limit: 20,
        windowMs: 15 * 60_000,
      });
      if (!sendLimit.allowed || !ipSend.allowed) {
        res.setHeader(
          "Retry-After",
          String(Math.max(sendLimit.retryAfterSec, ipSend.retryAfterSec)),
        );
        return res.status(429).json({ ok: false, error: "rate_limited" });
      }
      if (!isSmtpConfigured()) {
        return res.status(503).json({
          ok: false,
          error: "smtp",
          message: "Email is not configured on the server.",
        });
      }
      const otp = generateEmailOtp();
      const hash = hashEmailOtp(otp);
      const expires = emailOtpExpiryIso(10);
      await p.query(
        `UPDATE users SET mfa_email_code_hash = $1, mfa_email_code_expires = $2 WHERE id = $3`,
        [hash, expires, found.id],
      );
      const locale = String(found.locale || "en").toLowerCase().startsWith("fr")
        ? "fr"
        : "en";
      const isFr = locale === "fr";
      const subject = isFr
        ? "Votre code de vérification AKAB"
        : "Your AKAB verification code";
      const text = isFr
        ? `Bonjour ${found.name},\n\nVoici votre code :\n\n    ${otp}\n\nExpire dans 10 minutes.\n\n— Portail AKAB`
        : `Hello ${found.name},\n\nYour verification code is:\n\n    ${otp}\n\nExpires in 10 minutes.\n\n— AKAB Portal`;
      const result = await sendPlainEmail({
        to: found.email,
        toName: found.name,
        subject,
        text,
      });
      if (!result.ok) {
        return res.status(502).json({
          ok: false,
          error: "smtp",
          message: result.error || "Could not send email",
        });
      }
      return res.status(200).json({ ok: true });
    }

    if (action === "verify_email") {
      const pending = readMfaPending(req);
      if (!pending || pending.kind !== "challenge") {
        return res.status(400).json({ ok: false, error: "no_pending" });
      }
      const found = await loadUserById(pending.uid);
      if (!found || !found.active) {
        return res.status(400).json({ ok: false, error: "no_pending" });
      }
      // Stricter email OTP attempts (5 / 15m) on top of general verify limits
      const emailLimit = rateLimit({
        key: `mfa:email-verify:${found.id}`,
        limit: 5,
        windowMs: 15 * 60_000,
      });
      if (!emailLimit.allowed) {
        clearMfaPendingCookie(res, req);
        res.setHeader("Retry-After", String(emailLimit.retryAfterSec));
        return res.status(429).json({ ok: false, error: "rate_limited" });
      }
      if (isEmailOtpExpired(found.mfa_email_code_expires)) {
        return res.status(401).json({ ok: false, error: "expired" });
      }
      const hash = hashEmailOtp(code);
      if (!found.mfa_email_code_hash || hash !== found.mfa_email_code_hash) {
        // Invalidate email OTP after first wrong guess so codes cannot be
        // brute-forced over the full 10-minute window.
        await p.query(
          `UPDATE users SET mfa_email_code_hash = NULL, mfa_email_code_expires = NULL WHERE id = $1`,
          [found.id],
        );
        return res.status(401).json({ ok: false, error: "invalid_code" });
      }
      await p.query(
        `UPDATE users SET mfa_email_code_hash = NULL, mfa_email_code_expires = NULL WHERE id = $1`,
        [found.id],
      );
      rateLimitReset(`mfa:email-verify:${found.id}`);
      const dto = await finishLogin(found.id);
      return dto
        ? res.status(200).json({ ok: true, user: dto })
        : res.status(500).json({ ok: false, error: "generic" });
    }

    if (action === "start_enroll") {
      const pending = readMfaPending(req);
      const session = readSession(req);
      let userId = pending?.uid ?? session?.uid ?? null;
      if (userId == null) {
        return res.status(400).json({ ok: false, error: "no_pending" });
      }
      const found = await loadUserById(userId);
      if (!found || !found.active) {
        return res.status(400).json({ ok: false, error: "no_pending" });
      }
      const secret = generateTotpSecret();
      const otpauthUrl = buildOtpAuthUri({
        secret,
        accountName: found.email,
        issuer: "AKAB Portal",
      });
      const qrUrl = await totpQrDataUrl(otpauthUrl, 200);
      setMfaPendingCookie(
        res,
        {
          uid: found.id,
          email: found.email,
          name: found.name,
          kind: "enroll",
          setupSecret: secret,
        },
        req,
      );
      return res.status(200).json({
        ok: true,
        secret,
        otpauthUrl,
        qrUrl,
      });
    }

    if (action === "confirm_enroll") {
      const pending = readMfaPending(req);
      if (!pending?.setupSecret || pending.kind !== "enroll") {
        return res.status(400).json({ ok: false, error: "no_pending" });
      }
      if (!verifyTotp(pending.setupSecret, code)) {
        return res.status(401).json({ ok: false, error: "invalid_code" });
      }
      const recoveryCodes = generateRecoveryCodes(8);
      const hashed = hashRecoveryCodes(recoveryCodes);
      await p.query(
        `UPDATE users SET
          mfa_enabled = true,
          mfa_totp_secret = $1,
          mfa_recovery_codes = $2,
          mfa_email_code_hash = NULL,
          mfa_email_code_expires = NULL
         WHERE id = $3`,
        [pending.setupSecret, JSON.stringify(hashed), pending.uid],
      );
      const dto = await finishLogin(pending.uid);
      if (!dto) return res.status(500).json({ ok: false, error: "generic" });
      return res.status(200).json({ ok: true, user: dto, recoveryCodes });
    }

    if (action === "disable") {
      const session = readSession(req);
      if (!session) return res.status(401).json({ ok: false, error: "not_signed_in" });
      const found = await loadUserById(session.uid);
      if (!found || !isMfaEnabled(found)) {
        return res.status(400).json({ ok: false, error: "not_enabled" });
      }
      const totpOk = verifyTotp(found.mfa_totp_secret || "", code);
      let recoveryOk = false;
      let remainingJson: string | null = found.mfa_recovery_codes;
      if (!totpOk) {
        const consumed = consumeRecoveryCode(found.mfa_recovery_codes, code);
        if (consumed.ok) {
          recoveryOk = true;
          remainingJson = consumed.remainingJson;
        }
      }
      if (!totpOk && !recoveryOk) {
        return res.status(401).json({ ok: false, error: "invalid_code" });
      }
      await p.query(
        `UPDATE users SET
          mfa_enabled = false,
          mfa_totp_secret = NULL,
          mfa_recovery_codes = $1,
          mfa_email_code_hash = NULL,
          mfa_email_code_expires = NULL
         WHERE id = $2`,
        [recoveryOk ? remainingJson : null, found.id],
      );
      clearSessionCookie(res, req);
      setMfaPendingCookie(
        res,
        {
          uid: found.id,
          email: found.email,
          name: found.name,
          kind: "enroll",
        },
        req,
      );
      return res.status(200).json({
        ok: true,
        mfaPending: {
          kind: "enroll",
          email: found.email,
          name: found.name,
        },
      });
    }

    if (action === "regenerate_recovery") {
      const session = readSession(req);
      if (!session) return res.status(401).json({ ok: false, error: "not_signed_in" });
      const found = await loadUserById(session.uid);
      if (!found || !isMfaEnabled(found)) {
        return res.status(400).json({ ok: false, error: "not_enabled" });
      }
      if (!verifyTotp(found.mfa_totp_secret || "", code)) {
        return res.status(401).json({ ok: false, error: "invalid_code" });
      }
      const recoveryCodes = generateRecoveryCodes(8);
      const hashed = hashRecoveryCodes(recoveryCodes);
      await p.query(`UPDATE users SET mfa_recovery_codes = $1 WHERE id = $2`, [
        JSON.stringify(hashed),
        found.id,
      ]);
      return res.status(200).json({ ok: true, recoveryCodes });
    }

    return res.status(400).json({ ok: false, error: "unknown_action" });
  } catch (err) {
    console.error("[auth/mfa]", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}
