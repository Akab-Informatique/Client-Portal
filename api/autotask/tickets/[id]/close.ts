import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  closeTicket,
  createTicketNote,
  fetchTicketById,
  findContactsByEmail,
  isAutotaskConfigured,
  mockCloseTicket,
  mockGetTicketDetail,
  primeMockTickets,
} from "../../../_lib/autotask-client.js";

/**
 * POST /api/autotask/tickets/:id/close
 * Body: { email, autotaskCompanyId, resolution? }
 *
 * Marks the ticket Complete in Autotask (client-initiated close).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const idRaw = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
    const ticketId = Number(idRaw);
    if (!Number.isFinite(ticketId) || ticketId <= 0) {
      return res.status(400).json({ error: "Invalid ticket id" });
    }

    const body = (req.body ?? {}) as {
      resolution?: string;
      email?: string;
      userEmail?: string;
      autotaskCompanyId?: string;
      atCompanyId?: string;
    };

    const resolution = String(body.resolution ?? "").trim();
    const email = String(body.email ?? body.userEmail ?? "")
      .trim()
      .toLowerCase();
    const autotaskCompanyId = String(
      body.autotaskCompanyId ?? body.atCompanyId ?? "",
    ).trim();

    if (!autotaskCompanyId) {
      return res.status(400).json({ error: "Missing Autotask company ID." });
    }
    if (!email) {
      return res.status(400).json({ error: "Missing user email." });
    }

    // ── Mock mode ──────────────────────────────────────────────────────────
    if (!isAutotaskConfigured()) {
      primeMockTickets(autotaskCompanyId, email);
      const existing = mockGetTicketDetail(ticketId, {
        autotaskCompanyId,
        userEmail: email,
      });
      if (!existing.ticket) {
        return res.status(404).json({ error: "Ticket not found", mock: true });
      }
      const label = existing.ticket.statusLabel.toLowerCase();
      if (label.includes("complete") || label.includes("closed")) {
        return res.status(400).json({
          error: "This ticket is already closed.",
          mock: true,
          ticket: existing.ticket,
        });
      }

      const ticket = mockCloseTicket({
        ticketId,
        resolution: resolution || "Closed by client via SOLU TI portal.",
        autotaskCompanyId,
        userEmail: email,
      });
      const detail = mockGetTicketDetail(ticketId, {
        autotaskCompanyId,
        userEmail: email,
      });
      return res.status(200).json({
        configured: false,
        mock: true,
        ticket,
        notes: detail.notes,
        message: "Ticket closed.",
      });
    }

    // ── Live Autotask ──────────────────────────────────────────────────────
    const { ticket } = await fetchTicketById(ticketId);
    if (!ticket) {
      return res.status(404).json({ error: "Ticket not found", configured: true });
    }

    const companyNum = Number(autotaskCompanyId);
    if (
      Number.isFinite(companyNum) &&
      ticket.companyID != null &&
      Number(ticket.companyID) !== companyNum
    ) {
      return res.status(403).json({
        error: "This ticket does not belong to your company.",
        configured: true,
      });
    }

    const contacts = await findContactsByEmail(email, {
      companyId: Number.isFinite(companyNum) ? companyNum : null,
    });
    if (contacts.length > 0) {
      const contactIds = new Set(contacts.map((c) => c.id));
      const allowed =
        (ticket.contactID != null && contactIds.has(Number(ticket.contactID))) ||
        (ticket.createdByContactID != null &&
          contactIds.has(Number(ticket.createdByContactID)));
      if (!allowed) {
        return res.status(403).json({
          error: "You can only close tickets linked to your contact.",
          configured: true,
        });
      }
    }

    const statusLabel = (ticket.statusLabel ?? "").toLowerCase();
    if (
      statusLabel.includes("complete") ||
      statusLabel.includes("closed") ||
      statusLabel.includes("canceled") ||
      statusLabel.includes("cancelled")
    ) {
      return res.status(400).json({
        error: "This ticket is already closed.",
        configured: true,
        ticket,
      });
    }

    // Optional closing note before status change
    const closeNote =
      resolution || "Closed by client via the SOLU TI portal.";
    try {
      await createTicketNote({
        ticketId,
        title: "Closed by client",
        description: closeNote,
        contactId: contacts[0]?.id ?? ticket.contactID ?? null,
      });
    } catch {
      // Note is best-effort; still try to close
    }

    const { ticket: closed } = await closeTicket({
      ticketId,
      resolution: closeNote,
    });

    return res.status(200).json({
      configured: true,
      mock: false,
      ticket: closed,
      message: "Ticket closed in Autotask.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Server error";
    return res.status(500).json({
      error: message,
      configured: isAutotaskConfigured(),
    });
  }
}
