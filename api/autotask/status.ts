import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  clearAutotaskZoneCache,
  diagnoseAutotaskEnv,
  getAutotaskConfigFromEnv,
  isAutotaskConfigured,
  probeAutotaskAccess,
} from "../_lib/autotask-client.js";

/**
 * GET /api/autotask/status
 * Verifies credentials + zone + Tickets entity + Contacts/query.
 * Use after changing AUTOTASK_* in .env and recreating the app container.
 *
 * Optional: ?refresh=1 clears the in-process zone cache first.
 *
 * Response:
 *  - ok / authOk → Tickets API accepts credentials (main "Connected")
 *  - contactsAuthOk → Contacts/query works (needed for client ticket matching)
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
        authOk: false,
        contactsAuthOk: false,
        message:
          "Autotask credentials missing. Set AUTOTASK_INTEGRATION_CODE, AUTOTASK_USERNAME, and AUTOTASK_SECRET in /opt/akab-portal/.env then: docker compose up -d --force-recreate app",
      });
    }

    const cfg = getAutotaskConfigFromEnv()!;
    const refresh =
      String(req.query.refresh ?? "") === "1" ||
      String(req.query.refresh ?? "").toLowerCase() === "true";
    if (refresh) clearAutotaskZoneCache();

    const envDiag = diagnoseAutotaskEnv();
    const probe = await probeAutotaskAccess();

    const warnings: string[] = [...envDiag.issues];
    if (probe.ok && probe.contactsAuthOk === false) {
      warnings.push(
        "Tickets API is connected, but Contacts/query failed. Client users will not see their tickets until CRM → Contacts → View is enabled on the API User security level.",
      );
    }

    const common = {
      usernameHint: maskMiddle(cfg.username),
      integrationCodeHint: maskMiddle(cfg.integrationCode),
      secretLength: cfg.secret.length,
      secretHasDollar: envDiag.secretHasDollar,
      secretHasHash: envDiag.secretHasHash,
      usernameLooksLikeEmail: envDiag.usernameLooksLikeEmail,
      zonePinned: envDiag.zonePinned,
      envIssues: envDiag.issues,
      warnings,
    };

    // Full auth failure (wrong credentials / zone)
    if (!probe.ok || probe.authOk === false || probe.ticketsAuthOk === false) {
      return res.status(200).json({
        ok: false,
        configured: true,
        zoneOk: probe.zoneOk ?? Boolean(probe.zoneUrl),
        zoneUrl: probe.zoneUrl,
        authOk: false,
        ticketsAuthOk: false,
        contactsAuthOk: false,
        httpStatus: probe.httpStatus,
        detail: probe.detail,
        message: probe.message,
        fix: [
          "Edit /opt/akab-portal/.env — use SINGLE quotes around the secret (required if it has $ or #):",
          "  AUTOTASK_INTEGRATION_CODE=your-tracking-id",
          "  AUTOTASK_USERNAME=your-username-key-not-email",
          "  AUTOTASK_SECRET='paste-full-secret-here'",
          "  # AUTOTASK_ZONE_URL=   ← keep commented unless you must pin a zone",
          "Save, then recreate so the container reloads env:",
          "  cd /opt/akab-portal && docker compose up -d --force-recreate app",
          "  curl -sS 'http://127.0.0.1:3000/api/autotask/status?refresh=1' | jq",
          "If usernameLooksLikeEmail=true, replace AUTOTASK_USERNAME with Username (Key) from Credentials.",
          "If secretHasDollar/secretHasHash=true and you still get 401, the secret was corrupted before quoting — re-paste the FULL secret inside single quotes.",
        ],
        ...common,
      });
    }

    // Tickets OK — may still have Contacts issue
    const fullyOk = probe.contactsAuthOk !== false;
    return res.status(200).json({
      ok: true,
      configured: true,
      zoneOk: true,
      zoneUrl: probe.zoneUrl,
      authOk: true,
      ticketsAuthOk: true,
      contactsAuthOk: fullyOk,
      httpStatus: probe.httpStatus,
      detail: fullyOk ? undefined : probe.detail,
      message: fullyOk
        ? probe.message ||
          "Connected to Autotask PSA (Tickets + Contacts). Client tickets load when portal email matches an Autotask Contact and the company has Autotask Company ID set."
        : probe.message,
      fix: fullyOk
        ? undefined
        : [
            "Autotask Tickets API is connected.",
            "Fix Contacts access: Autotask → Admin → Security Levels → your API User (API-only) level → CRM → Contacts → View.",
            "Save, wait a minute, then: curl -sS \"http://127.0.0.1:3000/api/autotask/status?refresh=1\"",
            "Client tickets also need: company Autotask Company ID + portal email = Autotask Contact email.",
          ],
      ...common,
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
