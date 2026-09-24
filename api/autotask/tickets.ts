import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  fetchOpenTicketsForCompany,
  fetchOpenTicketsForUser,
  getAutotaskConfigFromEnv,
  isAutotaskConfigured,
  mockOpenTickets,
  primeMockTickets,
} from "../_lib/autotask-client.js";

/**
 * GET /api/autotask/tickets?autotaskCompanyId=123&email=user@company.com
 *
 * Returns open tickets from Autotask for the logged-in portal user only.
 * Matching rule: Autotask Contact email == portal user email, then tickets
 * where contactID OR createdByContactID is that contact.
 *
 * Optional: scope=company  → company-wide open tickets (admin/tech use)
 * If credentials are missing, returns demo mock tickets with mock: true.
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
    const email = String(req.query.email ?? req.query.userEmail ?? "")
      .trim()
      .toLowerCase();
    const scope = String(req.query.scope ?? "user").trim().toLowerCase();

    if (!autotaskCompanyId) {
      return res.status(400).json({
        error:
          "Missing Autotask company ID. Ask your admin to set Autotask Company ID on your client record.",
        configured: isAutotaskConfigured(),
        tickets: [],
      });
    }

    // Client portal default: must identify the user
    if (scope !== "company" && !email) {
      return res.status(400).json({
        error:
          "Missing user email. Tickets are limited to the signed-in contact.",
        configured: isAutotaskConfigured(),
        tickets: [],
      });
    }

    if (!isAutotaskConfigured()) {
      primeMockTickets(autotaskCompanyId, email || null);
      return res.status(200).json({
        configured: false,
        mock: true,
        scope: scope === "company" ? "company" : "user",
        companyId: autotaskCompanyId,
        email: email || null,
        contactMatched: Boolean(email),
        tickets: mockOpenTickets(autotaskCompanyId, { userEmail: email }),
        error:
          "Autotask credentials are not configured. Showing demo tickets for your user only. Add AUTOTASK_INTEGRATION_CODE, AUTOTASK_USERNAME, and AUTOTASK_SECRET.",
      });
    }

    void getAutotaskConfigFromEnv();

    // Company-wide (optional admin/tech path)
    if (scope === "company") {
      const { tickets, statusLabels, priorityLabels } =
        await fetchOpenTicketsForCompany(autotaskCompanyId);
      return res.status(200).json({
        configured: true,
        mock: false,
        scope: "company",
        companyId: autotaskCompanyId,
        email: email || null,
        contactMatched: true,
        tickets,
        statusLabels,
        priorityLabels,
      });
    }

    // Default: only this contact's tickets
    const result = await fetchOpenTicketsForUser({
      autotaskCompanyId,
      userEmail: email,
    });

    if (!result.contactMatched) {
      return res.status(200).json({
        configured: true,
        mock: false,
        scope: "user",
        companyId: autotaskCompanyId,
        email,
        contactMatched: false,
        contacts: [],
        tickets: [],
        statusLabels: result.statusLabels,
        priorityLabels: result.priorityLabels,
        error: `No Autotask contact found for ${email}. Tickets only appear when your portal email matches a contact on this company in Autotask.`,
      });
    }

    return res.status(200).json({
      configured: true,
      mock: false,
      scope: "user",
      companyId: autotaskCompanyId,
      email,
      contactMatched: true,
      contacts: result.contacts.map((c) => ({
        id: c.id,
        emailAddress: c.emailAddress,
        firstName: c.firstName,
        lastName: c.lastName,
        companyID: c.companyID,
        isActive: c.isActive,
      })),
      tickets: result.tickets,
      statusLabels: result.statusLabels,
      priorityLabels: result.priorityLabels,
    });
  } catch (err) {
    // Never return raw Autotask error objects — always a plain string for the UI.
    let message = "Server error";
    if (err instanceof Error) {
      message = err.message;
    } else if (typeof err === "string") {
      message = err;
    } else if (err && typeof err === "object") {
      const obj = err as { message?: unknown; errors?: unknown };
      if (typeof obj.message === "string") message = obj.message;
      else if (obj.errors != null) {
        try {
          message = JSON.stringify(obj.errors);
        } catch {
          message = "Autotask request failed";
        }
      }
    }
    const isGone = /\(410\b|410 Gone/i.test(message);
    const isAuth = /\(401\b|Unauthorized|credentials rejected/i.test(message);
    return res.status(isGone ? 410 : isAuth ? 502 : 500).json({
      error: message,
      configured: isAutotaskConfigured(),
      tickets: [],
      authError: isAuth,
    });
  }
}
