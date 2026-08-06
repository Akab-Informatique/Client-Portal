import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  fetchContractServicesForContract,
  isAutotaskConfigured,
} from "../../../_lib/autotask-client.js";

/**
 * GET /api/autotask/contracts/:id/services
 * Services on a contract (names, units, client unit price). No internal cost.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const idRaw = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
    const contractId = Number(idRaw);
    if (!Number.isFinite(contractId) || contractId <= 0) {
      return res.status(400).json({ error: "Invalid contract id" });
    }

    if (!isAutotaskConfigured()) {
      return res.status(503).json({
        configured: false,
        services: [],
        error:
          "Autotask is not configured. Add AUTOTASK_INTEGRATION_CODE, AUTOTASK_USERNAME, and AUTOTASK_SECRET.",
      });
    }

    const { services } = await fetchContractServicesForContract(contractId);
    return res.status(200).json({
      configured: true,
      contractId,
      services,
      error: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Server error";
    const status = /not configured/i.test(message)
      ? 503
      : /401|Unauthorized/i.test(message)
        ? 401
        : /403|Forbidden/i.test(message)
          ? 403
          : 500;
    return res.status(status).json({
      configured: isAutotaskConfigured(),
      services: [],
      error: message,
    });
  }
}
