import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getAutotaskConfigFromEnv,
  isAutotaskConfigured,
  resolveZoneBase,
} from "../_lib/autotask-client.js";

/**
 * GET /api/autotask/status
 * Lightweight health check — does not list tickets.
 * Verifies credentials + zone resolution against Autotask.
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

    let zoneUrl: string;
    try {
      zoneUrl = await resolveZoneBase(cfg);
    } catch (e) {
      return res.status(200).json({
        ok: false,
        configured: true,
        zoneOk: false,
        message: e instanceof Error ? e.message : "Zone lookup failed",
        usernameHint: maskMiddle(cfg.username),
        integrationCodeHint: maskMiddle(cfg.integrationCode),
      });
    }

    // Probe entity info (lightweight auth check)
    const probeUrl = `${zoneUrl}v1.0/Tickets/entityInformation`;
    const probe = await fetch(probeUrl, {
      headers: {
        ApiIntegrationCode: cfg.integrationCode,
        UserName: cfg.username,
        Secret: cfg.secret,
        Accept: "application/json",
      },
    });

    if (!probe.ok) {
      const text = await probe.text().catch(() => "");
      return res.status(200).json({
        ok: false,
        configured: true,
        zoneOk: true,
        zoneUrl,
        authOk: false,
        httpStatus: probe.status,
        usernameHint: maskMiddle(cfg.username),
        integrationCodeHint: maskMiddle(cfg.integrationCode),
        secretLength: cfg.secret.length,
        message:
          probe.status === 401
            ? "Autotask rejected credentials (401). Check: (1) API Tracking Identifier / Integration Code, (2) API Username (Key), (3) Secret. Use an API-only user, not a normal login."
            : `Autotask probe failed (${probe.status}): ${text.slice(0, 200)}`,
      });
    }

    return res.status(200).json({
      ok: true,
      configured: true,
      zoneOk: true,
      authOk: true,
      zoneUrl,
      message: "Connected to Autotask PSA",
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
