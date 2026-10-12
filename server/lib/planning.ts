import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { permissionsOf } from "./auth.ts";
import { notify } from "./notify.ts";
import { createEvent, deleteEvent, O365Error, o365Ready, updateEvent } from "./o365.ts";

/**
 * Planning side effects: the Microsoft 365 calendar of technicians who sync
 * (right tickets.o365), and the alerts before an event.
 */
export type Block = typeof schema.calendarBlocks.$inferSelect;
export type Pin = typeof schema.ticketPins.$inferSelect;

/** The mailbox to sync for this technician, or null (no right, integration off). */
export async function o365MailboxOf(userId: string): Promise<string | null> {
  if (!(await o365Ready())) return null;
  const [u] = await db().select().from(schema.users).where(eq(schema.users.id, userId));
  if (!u || !u.active || u.kind !== "staff") return null;
  return (await permissionsOf(u)).includes("tickets.o365") ? (u.o365Email ?? u.email) : null;
}

const KIND_LABEL = { work: "Billet", onsite: "Appel de service sur place", slot: "Temps réservé" } as const;

function blockEvent(b: Block) {
  const subject = b.ticketNumber ? `[${b.ticketNumber}] ${b.title}` : b.title;
  const lines = [
    KIND_LABEL[b.kind],
    b.companyName ? `Client : ${b.companyName}` : "",
    b.note,
    b.ticketId ? `Billet ${b.ticketNumber ?? b.ticketId} — portail AKAB` : "Portail AKAB",
  ].filter(Boolean);
  return {
    subject: b.kind === "onsite" ? `📍 ${subject}` : subject,
    body: lines.join("\n"),
    startsAt: b.startsAt,
    endsAt: b.endsAt,
    location: b.kind === "onsite" ? b.companyName : null,
    reminderMinutes: b.reminderMinutes,
  };
}

/** Create / update the technician's Outlook event for this block. Returns a warning, or null. */
export async function syncBlock(b: Block): Promise<string | null> {
  const email = await o365MailboxOf(b.technicianId);
  if (!email) return null;
  try {
    if (b.o365EventId) {
      await updateEvent(email, b.o365EventId, blockEvent(b));
    } else {
      const id = await createEvent(email, blockEvent(b));
      await db().update(schema.calendarBlocks).set({ o365EventId: id }).where(eq(schema.calendarBlocks.id, b.id));
    }
    return null;
  } catch (e) {
    return o365Warning(e);
  }
}

export async function unsyncBlock(b: Block): Promise<string | null> {
  if (!b.o365EventId) return null;
  const email = await o365MailboxOf(b.technicianId);
  if (!email) return null;
  try {
    await deleteEvent(email, b.o365EventId);
    return null;
  } catch (e) {
    return o365Warning(e);
  }
}

/** A priority of the day: an all-day event in Outlook (removed when done or no longer of the day). */
export async function syncPin(p: Pin): Promise<string | null> {
  const email = await o365MailboxOf(p.technicianId);
  if (!email) return null;
  try {
    const wanted = p.horizon === "day" && !p.doneAt;
    if (!wanted) {
      if (p.o365EventId) {
        await deleteEvent(email, p.o365EventId);
        await db().update(schema.ticketPins).set({ o365EventId: null }).where(eq(schema.ticketPins.id, p.id));
      }
      return null;
    }
    const day = new Date(`${p.forDate}T12:00:00Z`);
    const next = new Date(day.getTime() + 86_400_000);
    const ev = {
      subject: `★ Priorité : [${p.ticketNumber}] ${p.ticketTitle}`,
      body: [p.note, `Billet ${p.ticketNumber} — portail AKAB`].filter(Boolean).join("\n"),
      startsAt: day,
      endsAt: next,
      allDay: true,
    };
    if (p.o365EventId) await updateEvent(email, p.o365EventId, ev);
    else {
      const id = await createEvent(email, ev);
      await db().update(schema.ticketPins).set({ o365EventId: id }).where(eq(schema.ticketPins.id, p.id));
    }
    return null;
  } catch (e) {
    return o365Warning(e);
  }
}

export async function unsyncPin(p: Pin): Promise<void> {
  if (!p.o365EventId) return;
  const email = await o365MailboxOf(p.technicianId);
  if (email) await deleteEvent(email, p.o365EventId).catch(() => undefined);
}

function o365Warning(e: unknown): string {
  const code = e instanceof O365Error ? e.code : "api";
  console.warn("[o365]", e instanceof Error ? e.message : e);
  return `o365_${code}`;
}

/**
 * Alerts before an event: a notification to the technician when the block
 * starts within its reminder delay (sent once; reset when the time changes).
 */
export async function sendReminders(now = new Date()): Promise<number> {
  const due = await db()
    .select()
    .from(schema.calendarBlocks)
    .where(
      and(
        isNull(schema.calendarBlocks.reminderSentAt),
        gt(schema.calendarBlocks.reminderMinutes, 0),
        gt(schema.calendarBlocks.startsAt, now),
        lte(sql`${schema.calendarBlocks.startsAt} - make_interval(mins => ${schema.calendarBlocks.reminderMinutes})`, now),
      ),
    );
  for (const b of due) {
    const [claimed] = await db()
      .update(schema.calendarBlocks)
      .set({ reminderSentAt: now })
      .where(and(eq(schema.calendarBlocks.id, b.id), isNull(schema.calendarBlocks.reminderSentAt)))
      .returning({ id: schema.calendarBlocks.id });
    if (!claimed) continue;
    await notify([b.technicianId], {
      type: "calendar.reminder",
      data: {
        title: b.title,
        number: b.ticketNumber ?? "",
        kind: b.kind,
        company: b.companyName ?? "",
        startsAt: b.startsAt.toISOString(),
        minutes: String(Math.max(1, Math.round((b.startsAt.getTime() - now.getTime()) / 60_000))),
      },
      link: b.ticketId ? `/tickets?ticket=${b.ticketId}` : "/tickets",
    });
  }
  return due.length;
}
