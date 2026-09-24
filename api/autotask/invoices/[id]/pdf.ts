import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  fetchEntityCompanyId,
  fetchInvoicePdf,
  isAutotaskConfigured,
} from "../../../_lib/autotask-client.js";
import { clientOwnsAutotaskRecord } from "../../../_lib/api-gate.js";

/**
 * GET /api/autotask/invoices/:id/pdf
 * Streams Autotask invoice PDF (binary) for preview / print / download.
 *
 * Query:
 *   disposition=inline   → browser preview (default)
 *   disposition=attachment → force download
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const idRaw = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
    const invoiceId = Number(idRaw);
    if (!Number.isFinite(invoiceId) || invoiceId <= 0) {
      return res.status(400).json({ error: "Invalid invoice id" });
    }

    if (!isAutotaskConfigured()) {
      return res.status(503).json({
        error:
          "Autotask is not configured. Add AUTOTASK_INTEGRATION_CODE, AUTOTASK_USERNAME, and AUTOTASK_SECRET.",
      });
    }

    const disposition =
      String(req.query.disposition ?? "inline").toLowerCase() === "attachment"
        ? "attachment"
        : "inline";

    const ownerCompanyId = await fetchEntityCompanyId("Invoices", invoiceId);
    if (!clientOwnsAutotaskRecord(req, ownerCompanyId)) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    const { bytes, fileName, contentType } = await fetchInvoicePdf(invoiceId);

    const buf = Buffer.from(bytes);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType || "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `${disposition}; filename="${fileName.replace(/"/g, "")}"`,
    );
    res.setHeader("Content-Length", String(buf.byteLength));
    res.setHeader("Cache-Control", "private, max-age=60");
    // Prefer end(Buffer) so wrappers that JSON-stringify objects still work
    if (typeof res.end === "function") {
      res.end(buf);
      return;
    }
    return res.status(200).send(buf);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Server error";
    const status = /not configured/i.test(message)
      ? 503
      : /401|Unauthorized/i.test(message)
        ? 401
        : /403|Forbidden/i.test(message)
          ? 403
          : /404|not found/i.test(message)
            ? 404
            : 500;
    return res.status(status).json({ error: message });
  }
}
