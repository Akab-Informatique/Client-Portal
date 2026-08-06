import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  fetchClientSafeContractsForCompany,
  isAutotaskConfigured,
} from "../_lib/autotask-client.js";

/**
 * GET /api/autotask/contracts?autotaskCompanyId=123
 * Optional: includeInactive=1
 *
 * Returns CLIENT-SAFE contract fields (name, dates, status, type, monthly amount, description).
 * Internal cost, profit, margin, and setup fees are never returned.
 * Default: Active contracts only.
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

    const includeInactive =
      String(req.query.includeInactive ?? "").toLowerCase() === "1" ||
      String(req.query.includeInactive ?? "").toLowerCase() === "true";

    const { contracts } = await fetchClientSafeContractsForCompany(
      autotaskCompanyId,
      { includeInactive },
    );

    return res.status(200).json({
      configured: true,
      contracts,
      activeOnly: !includeInactive,
      clientVisibleFields: [
        "id",
        "name",
        "number",
        "typeLabel",
        "statusLabel",
        "isActive",
        "startDate",
        "endDate",
        "description",
        "monthlyAmount",
        "periodTypeLabel",
      ],
      clientHiddenNote:
        "Internal cost, profit, margin, and setup fees are never exposed. Monthly amount is estimated from service unit prices × units.",
    });
  } catch (err) {
    return res.status(500).json({
      configured: isAutotaskConfigured(),
      contracts: [],
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}
