import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  fetchClientSafeContractsForCompany,
  isAutotaskConfigured,
} from "../_lib/autotask-client.js";

/**
 * GET /api/autotask/contracts?autotaskCompanyId=123
 *
 * Returns CLIENT-SAFE contract fields only (name, dates, status, type, short description).
 * Cost, profit, margin, internal currency, and setup fees are never requested or returned.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const autotaskCompanyId = String(
      req.query.autotaskCompanyId ?? req.query.atCompanyId ?? "",
    ).trim();

    if (!autotaskCompanyId) {
      return res.status(400).json({
        configured: isAutotaskConfigured(),
        contracts: [],
        error:
          "Missing Autotask company ID. Set it under Clients → Edit for this company.",
      });
    }

    if (!isAutotaskConfigured()) {
      return res.status(200).json({
        configured: false,
        contracts: [],
        error:
          "Autotask credentials are not configured. Add AUTOTASK_INTEGRATION_CODE, AUTOTASK_USERNAME, and AUTOTASK_SECRET.",
      });
    }

    const { contracts } =
      await fetchClientSafeContractsForCompany(autotaskCompanyId);

    return res.status(200).json({
      configured: true,
      contracts,
      /** Explicit allowlist for clients / admins reviewing the API */
      clientVisibleFields: [
        "id",
        "name",
        "number",
        "typeLabel",
        "statusLabel",
        "startDate",
        "endDate",
        "description",
      ],
      clientHiddenNote:
        "Cost, profit, margin, internal pricing, and setup fees are never exposed to clients.",
    });
  } catch (err) {
    return res.status(500).json({
      configured: isAutotaskConfigured(),
      contracts: [],
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}
