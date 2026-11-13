import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { isStale, watchDays } from "../../shared/watch.ts";

export type WatchKind = "ticket" | "task" | "proj";

const qcDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(d);

/** Opening an item, or the reset button: the count of quiet days starts again */
export async function resetWatch(kind: WatchKind, id: string | number): Promise<void> {
  const item = String(id);
  await db()
    .insert(schema.watchState)
    .values({ kind, itemId: item, resetAt: new Date() })
    .onConflictDoUpdate({ target: [schema.watchState.kind, schema.watchState.itemId], set: { resetAt: new Date() } });
}

/** The delay set on one item (null: back to the default) */
export async function setWatchDays(kind: WatchKind, id: string | number, days: number | null): Promise<void> {
  const item = String(id);
  await db()
    .insert(schema.watchState)
    .values({ kind, itemId: item, days, resetAt: new Date() })
    .onConflictDoUpdate({ target: [schema.watchState.kind, schema.watchState.itemId], set: { days, resetAt: new Date() } });
}

export type WatchInput = { id: string | number; /** YYYY-MM-DD or an ISO date */ due: string | null; /** the last real activity */ activityAt: Date | string | null; open: boolean };
export type WatchInfo = { stale: boolean; watchDays: number; watchOwn: number | null };

/** For each item: the delay and whether it is quiet for longer (open items only; never for a closed one) */
export async function watchOf(kind: WatchKind, items: WatchInput[]): Promise<Map<string, WatchInfo>> {
  const out = new Map<string, WatchInfo>();
  if (!items.length) return out;
  const today = qcDay(new Date());
  const state = new Map<string, { resetAt: Date; days: number | null }>();
  const ids = items.map((i) => String(i.id));
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db()
      .select()
      .from(schema.watchState)
      .where(and(eq(schema.watchState.kind, kind), inArray(schema.watchState.itemId, ids.slice(i, i + 500))));
    for (const r of rows) state.set(r.itemId, { resetAt: r.resetAt, days: r.days });
  }
  for (const it of items) {
    const key = String(it.id);
    const s = state.get(key);
    const own = s?.days ?? null;
    const days = watchDays(it.due ? it.due.slice(0, 10) : null, today, own);
    const act = it.activityAt ? new Date(it.activityAt) : null;
    const last = [act, s?.resetAt ?? null].filter((x): x is Date => Boolean(x) && !Number.isNaN(x!.getTime())).sort((a, b) => b.getTime() - a.getTime())[0];
    out.set(key, { stale: it.open && Boolean(last) && isStale(qcDay(last), today, days), watchDays: days, watchOwn: own });
  }
  return out;
}
