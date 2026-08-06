import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  fetchClientInvoicesForCompany,
  isAutotaskConfigured,
} from "../_lib/autotask-client.js";

/**
 * GET /api/autotask/invoices?autotaskCompanyId=123
 * Client + staff invoice list from Autotask for one company.
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
    const search = String(req.query.search ?? req.query.q ?? "").trim();

    if (!autotaskCompanyId) {
      return res.status(400).json({
        configured: isAutotaskConfigured(),
        invoices: [],
        error:
          "Missing Autotask company ID. Set it on the client company under Clients → Edit.",
      });
    }

    if (!isAutotaskConfigured()) {
      return res.status(200).json({
        configured: false,
        invoices: [],
        error:
          "Autotask is not configured. Add AUTOTASK_INTEGRATION_CODE, AUTOTASK_USERNAME, and AUTOTASK_SECRET.",
      });
    }

    const { invoices, totalReturned } = await fetchClientInvoicesForCompany(
      autotaskCompanyId,
      { search: search || null },
    );
    return res.status(200).json({
      configured: true,
      companyId: autotaskCompanyId,
      search: search || null,
      count: totalReturned,
      invoices,
      error: null,
    });
  } catch (err) {
    return res.status(500).json({
      configured: isAutotaskConfigured(),
      invoices: [],
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}
