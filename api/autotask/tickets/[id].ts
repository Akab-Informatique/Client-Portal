import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  fetchTicketById,
  fetchTicketNotes,
  findContactsByEmail,
  isAutotaskConfigured,
  mockGetTicketDetail,
  primeMockTickets,
} from "../../_lib/autotask-client.js";

/**
 * GET /api/autotask/tickets/:id
 *   ?autotaskCompanyId=…&email=…
 *
 * Returns ticket detail + client-visible notes.
 * Enforces that the ticket belongs to the caller's company and (when scoped)
 * that the contact matches the portal user.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const idRaw = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
    const ticketId = Number(idRaw);
    if (!Number.isFinite(ticketId) || ticketId <= 0) {
      return res.status(400).json({ error: "Invalid ticket id" });
    }

    const autotaskCompanyId = String(
      req.query.autotaskCompanyId ?? req.query.atCompanyId ?? "",
    ).trim();
    const email = String(req.query.email ?? req.query.userEmail ?? "")
      .trim()
      .toLowerCase();

    if (!autotaskCompanyId) {
      return res.status(400).json({
        error: "Missing Autotask company ID.",
        configured: isAutotaskConfigured(),
      });
    }

    // ── Mock mode ──────────────────────────────────────────────────────────
    if (!isAutotaskConfigured()) {
      primeMockTickets(autotaskCompanyId, email);
      const { ticket, notes } = mockGetTicketDetail(ticketId, {
        autotaskCompanyId,
        userEmail: email,
      });
      if (!ticket) {
        return res.status(404).json({
          error: "Ticket not found",
          configured: false,
          mock: true,
        });
      }
      return res.status(200).json({
        configured: false,
        mock: true,
        ticket,
        notes,
      });
    }

    // ── Live Autotask ──────────────────────────────────────────────────────
    const [{ ticket, statusLabels, priorityLabels }, notesResult] =
      await Promise.all([
        fetchTicketById(ticketId),
        fetchTicketNotes(ticketId),
      ]);

    if (!ticket) {
      return res.status(404).json({
        error: "Ticket not found",
        configured: true,
        mock: false,
      });
    }

    // Company ownership check
    const companyNum = Number(autotaskCompanyId);
    if (
      Number.isFinite(companyNum) &&
      ticket.companyID != null &&
      Number(ticket.companyID) !== companyNum
    ) {
      return res.status(403).json({
        error: "This ticket does not belong to your company.",
        configured: true,
        mock: false,
      });
    }

    // Contact ownership (portal user must be ticket contact or creator)
    if (email) {
      const contacts = await findContactsByEmail(email, {
        companyId: Number.isFinite(companyNum) ? companyNum : null,
      });
      const contactIds = new Set(contacts.map((c) => c.id));
      const allowed =
        contacts.length === 0 ||
        (ticket.contactID != null && contactIds.has(Number(ticket.contactID))) ||
        (ticket.createdByContactID != null &&
          contactIds.has(Number(ticket.createdByContactID)));

      // If we matched contacts but ticket isn't theirs, deny
      if (contacts.length > 0 && !allowed) {
        return res.status(403).json({
          error: "You can only open tickets linked to your contact.",
          configured: true,
          mock: false,
        });
      }
    }

    return res.status(200).json({
      configured: true,
      mock: false,
      ticket,
      notes: notesResult.notes,
      statusLabels,
      priorityLabels,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Server error";
    return res.status(500).json({
      error: message,
      configured: isAutotaskConfigured(),
    });
  }
}
