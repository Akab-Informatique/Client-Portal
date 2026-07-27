import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  createTicketNote,
  fetchTicketById,
  fetchTicketNotes,
  findContactsByEmail,
  isAutotaskConfigured,
  mockAddTicketNote,
  mockGetTicketDetail,
  primeMockTickets,
} from "../../../_lib/autotask-client.js";

/**
 * POST /api/autotask/tickets/:id/notes
 * Body: { description, title?, email, autotaskCompanyId }
 *
 * Adds a client-visible reply note on the ticket.
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
      description?: string;
      title?: string;
      email?: string;
      userEmail?: string;
      autotaskCompanyId?: string;
      atCompanyId?: string;
    };

    const description = String(body.description ?? "").trim();
    const title = String(body.title ?? "Client reply").trim() || "Client reply";
    const email = String(body.email ?? body.userEmail ?? "")
      .trim()
      .toLowerCase();
    const autotaskCompanyId = String(
      body.autotaskCompanyId ?? body.atCompanyId ?? "",
    ).trim();

    if (!description) {
      return res.status(400).json({ error: "Reply message is required." });
    }
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
        });
      }

      const note = mockAddTicketNote({
        ticketId,
        title,
        description,
        autotaskCompanyId,
        userEmail: email,
        contactId: existing.ticket.contactID,
      });
      const updated = mockGetTicketDetail(ticketId, {
        autotaskCompanyId,
        userEmail: email,
      });
      return res.status(201).json({
        configured: false,
        mock: true,
        note,
        ticket: updated.ticket,
        notes: updated.notes,
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
    const contactIds = new Set(contacts.map((c) => c.id));
    if (contacts.length > 0) {
      const allowed =
        (ticket.contactID != null && contactIds.has(Number(ticket.contactID))) ||
        (ticket.createdByContactID != null &&
          contactIds.has(Number(ticket.createdByContactID)));
      if (!allowed) {
        return res.status(403).json({
          error: "You can only reply to tickets linked to your contact.",
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
      });
    }

    const contact =
      contacts.find((c) => c.isActive) ?? contacts[0] ?? null;
    const { noteId } = await createTicketNote({
      ticketId,
      title,
      description,
      // Prefer an active contact; inactive ones often fail createdByContactID
      contactId: contact?.isActive ? contact.id : null,
      userEmail: email,
      userName: contact
        ? [contact.firstName, contact.lastName].filter(Boolean).join(" ")
        : null,
    });

    // Return refreshed notes so the UI can update immediately
    const notesResult = await fetchTicketNotes(ticketId);

    return res.status(201).json({
      configured: true,
      mock: false,
      noteId,
      notes: notesResult.notes,
      message: "Reply posted to Autotask.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Server error";
    return res.status(500).json({
      error: message,
      configured: isAutotaskConfigured(),
    });
  }
}
