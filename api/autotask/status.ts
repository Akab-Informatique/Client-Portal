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
      secretLooksTruncated: envDiag.secretLooksTruncated,
      usernameLooksLikeEmail: envDiag.usernameLooksLikeEmail,
      zonePinned: envDiag.zonePinned,
      envIssues: envDiag.issues,
      criticalIssues: envDiag.criticalIssues,
      warnings,
    };

    // Full auth failure (wrong credentials / zone)
    if (!probe.ok || probe.authOk === false || probe.ticketsAuthOk === false) {
      // Username (Key) may legitimately end with @soluti.dev — do not tell the user to remove it.
      const fix = [
        "Autotask returned 401 — credentials were rejected (not a portal code bug).",
        "1) Autotask → Admin → Resources (Users) → your API User (API-only) → Credentials tab",
        "2) Copy ALL THREE values fresh (regenerate Secret if unsure):",
        "     • API Tracking Identifier  → AUTOTASK_INTEGRATION_CODE",
        "     • Username (Key)           → AUTOTASK_USERNAME  (may end with @soluti.dev — keep it)",
        "     • Secret                   → AUTOTASK_SECRET",
        "3) Edit /opt/akab-portal/.env exactly like this (single quotes on secret):",
        "     AUTOTASK_INTEGRATION_CODE=paste-tracking-id",
        "     AUTOTASK_USERNAME=paste-username-key@soluti.dev",
        "     AUTOTASK_SECRET='paste-full-secret-with-$-and-#-ok'",
        "     # AUTOTASK_ZONE_URL=   ← leave unset / commented",
        "4) Confirm the resource is API User (API-only) and security level allows API + Tickets View",
        "5) Recreate and retest:",
        "     cd /opt/akab-portal && docker compose up -d --force-recreate app",
        "     sleep 8 && curl -sS 'http://127.0.0.1:3000/api/autotask/status?refresh=1'",
        "Check secretLength in the JSON — if it is much shorter than the Autotask Secret, quotes/# truncated it.",
      ];
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
        fix,
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
