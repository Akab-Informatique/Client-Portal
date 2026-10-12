import { and, eq, isNotNull, lt } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { notify } from "./notify.ts";

/**
 * Ticket timers. A running timer is kept alive by its page (heartbeat every
 * 30 s). When the page stops answering (tab or browser closed), the timer is
 * stopped at its last sign of life and becomes "pending": a time entry the
 * technician validates on their next visit (with a bell notification).
 */
export const BEAT_TIMEOUT_MS = 90_000;

export type TimerRow = typeof schema.ticketTimers.$inferSelect;

export function elapsedMs(t: TimerRow, now = Date.now()): number {
  return t.accumulatedMs + (t.state === "running" && t.runningSince ? Math.max(0, now - t.runningSince.getTime()) : 0);
}

export function timerView(t: TimerRow) {
  return {
    id: t.id,
    ticketId: t.ticketId,
    ticketNumber: t.ticketNumber,
    ticketTitle: t.ticketTitle,
    state: t.state,
    elapsedMs: elapsedMs(t),
    startedAt: t.startedAt,
    endedAt: t.endedAt,
  };
}

/** Running timers with no heartbeat for a while → pending, stopped at the last beat. */
export async function sweepTimers(onlyUserId?: string): Promise<number> {
  const cutoff = new Date(Date.now() - BEAT_TIMEOUT_MS);
  const conds = [eq(schema.ticketTimers.state, "running"), isNotNull(schema.ticketTimers.lastBeatAt), lt(schema.ticketTimers.lastBeatAt, cutoff)];
  if (onlyUserId) conds.push(eq(schema.ticketTimers.userId, onlyUserId));
  const stale = await db()
    .select()
    .from(schema.ticketTimers)
    .where(and(...conds));
  for (const t of stale) {
    const endedAt = t.lastBeatAt!;
    const total = t.accumulatedMs + (t.runningSince ? Math.max(0, endedAt.getTime() - t.runningSince.getTime()) : 0);
    const done = await db()
      .update(schema.ticketTimers)
      .set({ state: "pending", accumulatedMs: total, runningSince: null, endedAt, updatedAt: new Date() })
      .where(and(eq(schema.ticketTimers.id, t.id), eq(schema.ticketTimers.state, "running")))
      .returning({ id: schema.ticketTimers.id });
    if (done.length) {
      await notify([t.userId], {
        type: "timer.pending",
        data: { ticketId: String(t.ticketId), number: t.ticketNumber, title: t.ticketTitle, minutes: String(Math.max(1, Math.round(total / 60_000))) },
        link: "/tickets?timers=1",
      });
    }
  }
  return stale.length;
}
