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
  totpQrImageUrl,
  verifyTotp,
} from "../_lib/auth-server.js";
import { getPool, isPostgresConfigured } from "../_lib/pg.js";
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

/**
 * POST /api/auth/mfa
 * Body: { action, code? }
 * All MFA verification and secret writes happen server-side only.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
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

    async function finishLogin(userId: number) {
      const user = await loadUserById(userId);
      if (!user || !user.active) return null;
      setSessionCookie(res, user.id);
      clearMfaPendingCookie(res);
      return toSessionUserDto(user);
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
      if (isEmailOtpExpired(found.mfa_email_code_expires)) {
        return res.status(401).json({ ok: false, error: "expired" });
      }
      const hash = hashEmailOtp(code);
      if (!found.mfa_email_code_hash || hash !== found.mfa_email_code_hash) {
        return res.status(401).json({ ok: false, error: "invalid_code" });
      }
      await p.query(
        `UPDATE users SET mfa_email_code_hash = NULL, mfa_email_code_expires = NULL WHERE id = $1`,
        [found.id],
      );
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
      const qrUrl = totpQrImageUrl(otpauthUrl, 200);
      setMfaPendingCookie(res, {
        uid: found.id,
        email: found.email,
        name: found.name,
        kind: "enroll",
        setupSecret: secret,
      });
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
      clearSessionCookie(res);
      setMfaPendingCookie(res, {
        uid: found.id,
        email: found.email,
        name: found.name,
        kind: "enroll",
      });
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
