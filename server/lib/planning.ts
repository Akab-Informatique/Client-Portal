import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { permissionsOf } from "./auth.ts";
import { notify } from "./notify.ts";
import { asConnection, createEvent, deleteEvent, O365Error, o365Ready, updateEvent } from "./o365.ts";

/**
 * Planning side effects: the Microsoft 365 calendar of technicians who sync
 * (right tickets.o365), and the alerts before an event.
 */
export type Block = typeof schema.calendarBlocks.$inferSelect;
export type Pin = typeof schema.ticketPins.$inferSelect;

/** A calendar shown in a technician's planning (see calendar_links). */
export type CalendarTarget = {
  id: string | null;
  source: "user" | "app";
  /** Whose calendar, when known (their Microsoft sign-in for "user") */
  ownerId: string | null;
  /** Null: the owner has not signed in to Microsoft (yet, or any more) */
  mailbox: string | null;
  calendarId: string | null;
  calendarName: string | null;
  label: string;
  display: "details" | "busy";
  push: boolean;
};

/**
 * The calendars of a technician's planning: the ones a master admin linked,
 * or by default their own (through their sign-in, else the organisation
 * access), in detail, receiving the portal's blocks. None without the right
 * tickets.o365 or with Microsoft 365 off.
 */
export async function calendarsOf(technicianId: string): Promise<CalendarTarget[]> {
  if (!(await o365Ready())) return [];
  const [u] = await db().select().from(schema.users).where(eq(schema.users.id, technicianId));
  if (!u || !u.active || u.kind !== "staff") return [];
  if (!(await permissionsOf(u)).includes("tickets.o365")) return [];
  const links = await db().select().from(schema.calendarLinks).where(eq(schema.calendarLinks.technicianId, technicianId)).orderBy(schema.calendarLinks.createdAt);
  const conns = await db().select({ userId: schema.msConnections.userId, email: schema.msConnections.email }).from(schema.msConnections);
  const signIn = (id: string | null) => conns.find((c) => c.userId === id)?.email ?? null;
  if (!links.length) {
    const own = signIn(u.id);
    return [{ id: null, source: own ? "user" : "app", ownerId: u.id, mailbox: own ?? u.o365Email ?? u.email, calendarId: null, calendarName: null, label: u.name, display: "details", push: true }];
  }
  return links.map((l) => ({
    id: l.id,
    source: l.source,
    ownerId: l.ownerId,
    mailbox: l.source === "user" ? signIn(l.ownerId) : l.mailbox,
    calendarId: l.calendarId,
    calendarName: l.calendarName,
    label: l.label,
    display: l.display,
    push: l.push,
  }));
}

/** The calendar that receives the technician's blocks and priorities, if any. */
async function pushTarget(technicianId: string): Promise<(CalendarTarget & { mailbox: string }) | null> {
  const t = (await calendarsOf(technicianId)).find((c) => c.push);
  return t?.mailbox ? (t as CalendarTarget & { mailbox: string }) : null;
}

/** Graph calls for this calendar: as its owner (their sign-in) or with the organisation access. */
export function onCalendar<T>(t: CalendarTarget, fn: () => Promise<T>): Promise<T> {
  return asConnection(t.source === "user" ? t.ownerId : null, fn);
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
  const target = await pushTarget(b.technicianId);
  if (!target) return null;
  try {
    await onCalendar(target, async () => {
      if (b.o365EventId) {
        await updateEvent(target.mailbox, b.o365EventId, blockEvent(b));
      } else {
        const id = await createEvent(target.mailbox, blockEvent(b), target.calendarId);
        await db().update(schema.calendarBlocks).set({ o365EventId: id }).where(eq(schema.calendarBlocks.id, b.id));
      }
    });
    return null;
  } catch (e) {
    return o365Warning(e);
  }
}

export async function unsyncBlock(b: Block): Promise<string | null> {
  if (!b.o365EventId) return null;
  const target = await pushTarget(b.technicianId);
  if (!target) return null;
  try {
    await onCalendar(target, () => deleteEvent(target.mailbox, b.o365EventId!));
    return null;
  } catch (e) {
    return o365Warning(e);
  }
}

/** A priority of the day: an all-day event in Outlook (removed when done or no longer of the day). */
export async function syncPin(p: Pin): Promise<string | null> {
  const target = await pushTarget(p.technicianId);
  if (!target) return null;
  return onCalendar(target, () => syncPinIn(target.mailbox, target.calendarId, p));
}
async function syncPinIn(email: string, calendarId: string | null, p: Pin): Promise<string | null> {
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
      const id = await createEvent(email, ev, calendarId);
      await db().update(schema.ticketPins).set({ o365EventId: id }).where(eq(schema.ticketPins.id, p.id));
    }
    return null;
  } catch (e) {
    return o365Warning(e);
  }
}

export async function unsyncPin(p: Pin): Promise<void> {
  if (!p.o365EventId) return;
  const target = await pushTarget(p.technicianId);
  if (target) await onCalendar(target, () => deleteEvent(target.mailbox, p.o365EventId!)).catch(() => undefined);
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
