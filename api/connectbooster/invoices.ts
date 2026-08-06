import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  buildConnectBoosterPortalUrl,
  fetchConnectBoosterInvoices,
  isConnectBoosterPortalConfigured,
} from "../_lib/connectbooster-client.js";

/**
 * GET /api/connectbooster/invoices?customerId=...
 * Lists invoices when API is available; always returns portal/pay links when portal URL is set.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const customerId = String(
      req.query.customerId ?? req.query.connectboosterCustomerId ?? "",
    ).trim();

    if (!customerId) {
      return res.status(400).json({
        configured: isConnectBoosterPortalConfigured(),
        invoices: [],
        portalUrl: buildConnectBoosterPortalUrl({ customerId: null }),
        payUrl: null,
        error:
          "Missing ConnectBooster customer ID. Ask your admin to set it on the client company.",
      });
    }

    const result = await fetchConnectBoosterInvoices({ customerId });
    return res.status(200).json({
      configured: result.configured,
      apiConfigured: result.apiConfigured,
      source: result.source,
      customerId,
      invoices: result.invoices,
      portalUrl: result.portalUrl,
      payUrl: result.payUrl,
      error: result.error ?? null,
    });
  } catch (err) {
    return res.status(500).json({
      configured: isConnectBoosterPortalConfigured(),
      invoices: [],
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}
