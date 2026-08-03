import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  clearAutotaskZoneCache,
  getAutotaskConfigFromEnv,
  isAutotaskConfigured,
  probeAutotaskAccess,
} from "../_lib/autotask-client.js";

/**
 * GET /api/autotask/status
 * Verifies credentials + zone + Tickets entity + Contacts/query.
 * Use this after changing AUTOTASK_* in .env and recreating the app container.
 *
 * Optional: ?refresh=1 clears the in-process zone cache first.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (!isAutotaskConfigured()) {
      return res.status(200).json({
        ok: false,
        configured: false,
        message:
          "Autotask credentials missing. Set AUTOTASK_INTEGRATION_CODE, AUTOTASK_USERNAME, and AUTOTASK_SECRET in /opt/akab-portal/.env then: docker compose up -d --force-recreate app",
      });
    }

    const cfg = getAutotaskConfigFromEnv()!;
    const refresh =
      String(req.query.refresh ?? "") === "1" ||
      String(req.query.refresh ?? "").toLowerCase() === "true";
    if (refresh) clearAutotaskZoneCache();

    const usernameLooksLikeEmail = /@/.test(cfg.username);
    const probe = await probeAutotaskAccess();

    const commonHints = {
      usernameHint: maskMiddle(cfg.username),
      integrationCodeHint: maskMiddle(cfg.integrationCode),
      secretLength: cfg.secret.length,
      usernameLooksLikeEmail,
      zonePinned: Boolean(cfg.zoneBaseUrl),
      warnings: [] as string[],
    };

    if (usernameLooksLikeEmail) {
      commonHints.warnings.push(
        "AUTOTASK_USERNAME looks like an email. For API-only users you usually need the generated Username (Key) from the Credentials tab — not the resource email/login.",
      );
    }
    if (cfg.secret.length < 8) {
      commonHints.warnings.push(
        "AUTOTASK_SECRET looks too short. Re-copy the generated Secret from the API User Credentials tab.",
      );
    }
    if (cfg.integrationCode.length < 6) {
      commonHints.warnings.push(
        "AUTOTASK_INTEGRATION_CODE looks too short. Use the API Tracking Identifier from the API User.",
      );
    }

    if (!probe.ok) {
      return res.status(200).json({
        ok: false,
        configured: true,
        zoneOk: probe.zoneOk,
        zoneUrl: probe.zoneUrl,
        authOk: probe.authOk,
        contactsAuthOk: probe.contactsAuthOk,
        httpStatus: probe.httpStatus,
        detail: probe.detail,
        message: probe.message,
        fix: [
          "Edit /opt/akab-portal/.env with the three values from Autotask → Admin → Resources → your API User → Credentials:",
          "  AUTOTASK_INTEGRATION_CODE=<API Tracking Identifier>",
          "  AUTOTASK_USERNAME=<Username (Key) — not a normal login>",
          '  AUTOTASK_SECRET="<Secret>"   # quote if it has $ # spaces or !',
          "Remove AUTOTASK_ZONE_URL unless you know your zone URL is correct.",
          "Then: cd /opt/akab-portal && docker compose up -d --force-recreate app",
          'Then: curl -sS "http://127.0.0.1:3000/api/autotask/status?refresh=1"',
        ],
        ...commonHints,
      });
    }

    return res.status(200).json({
      ok: true,
      configured: true,
      zoneOk: true,
      authOk: true,
      contactsAuthOk: true,
      zoneUrl: probe.zoneUrl,
      message:
        "Connected to Autotask PSA (Tickets + Contacts). Client tickets can load when portal email matches an Autotask Contact and the company has Autotask Company ID set.",
      ...commonHints,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}

function maskMiddle(value: string) {
  if (!value) return "(empty)";
  if (value.length <= 4) return "***";
  return `${value.slice(0, 2)}…${value.slice(-2)} (len ${value.length})`;
}
