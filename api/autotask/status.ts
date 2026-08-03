import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getAutotaskConfigFromEnv,
  isAutotaskConfigured,
  probeAutotaskAccess,
} from "../_lib/autotask-client.js";

/**
 * GET /api/autotask/status
 * Lightweight health check — does not list tickets.
 * Verifies credentials + zone + Tickets/Contacts access (needed for client ticket matching).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const configured = isAutotaskConfigured();
    if (!configured) {
      return res.status(200).json({
        ok: false,
        configured: false,
        message:
          "Autotask credentials missing. Set AUTOTASK_INTEGRATION_CODE, AUTOTASK_USERNAME, and AUTOTASK_SECRET.",
      });
    }

    const cfg = getAutotaskConfigFromEnv()!;
    const probe = await probeAutotaskAccess();

    return res.status(200).json({
      ok: probe.ok,
      configured: true,
      zoneOk: Boolean(probe.zoneUrl),
      zoneUrl: probe.zoneUrl ?? null,
      authOk: probe.ticketsAuthOk === true,
      ticketsAuthOk: probe.ticketsAuthOk === true,
      contactsAuthOk: probe.contactsAuthOk === true,
      httpStatus: probe.httpStatus ?? null,
      usernameHint: maskMiddle(cfg.username),
      integrationCodeHint: maskMiddle(cfg.integrationCode),
      secretLength: cfg.secret.length,
      message: probe.message,
      detail: probe.detail ?? null,
      hint: probe.ok
        ? null
        : "After fixing .env: docker compose up -d --force-recreate app  then hard-refresh Settings.",
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
