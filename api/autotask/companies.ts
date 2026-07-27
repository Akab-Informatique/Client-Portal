import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getAutotaskConfigFromEnv,
  isAutotaskConfigured,
  resolveZoneBase,
} from "../_lib/autotask-client.js";

/**
 * GET /api/autotask/companies?q=acme
 * Search Autotask companies so admins can map portal clients to PSA IDs.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (!isAutotaskConfigured()) {
      return res.status(200).json({
        configured: false,
        companies: [],
        error: "Autotask credentials not configured",
      });
    }

    const q = String(req.query.q ?? "").trim();
    const cfg = getAutotaskConfigFromEnv()!;
    const base = await resolveZoneBase(cfg);

    const filter = q
      ? [
          {
            op: "or",
            items: [
              { op: "contains", field: "companyName", value: q },
              { op: "beginsWith", field: "companyName", value: q },
            ],
          },
        ]
      : [{ op: "exist", field: "id" }];

    const body = {
      MaxRecords: 25,
      IncludeFields: ["id", "companyName", "companyNumber", "phone", "isActive"],
      filter,
    };

    const url = `${base}v1.0/Companies/query`;
    const atRes = await fetch(url, {
      method: "POST",
      headers: {
        ApiIntegrationCode: cfg.integrationCode,
        UserName: cfg.username,
        Secret: cfg.secret,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await atRes.text();
    let data: { items?: Array<Record<string, unknown>>; errors?: unknown } = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }

    if (!atRes.ok) {
      return res.status(atRes.status).json({
        configured: true,
        companies: [],
        error: `Autotask Companies/query failed (${atRes.status}): ${text.slice(0, 300)}`,
      });
    }

    const companies = (data.items ?? []).map((c) => ({
      id: Number(c.id),
      name: String(c.companyName ?? ""),
      number: c.companyNumber != null ? String(c.companyNumber) : null,
      phone: c.phone != null ? String(c.phone) : null,
      active: c.isActive !== false,
    }));

    companies.sort((a, b) => a.name.localeCompare(b.name));

    return res.status(200).json({
      configured: true,
      companies,
    });
  } catch (err) {
    return res.status(500).json({
      configured: isAutotaskConfigured(),
      companies: [],
      error: err instanceof Error ? err.message : "Server error",
    });
  }
}
