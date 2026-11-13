import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { notify } from "./notify.ts";

/**
 * Every minute: the bell rings once for each private reminder whose time has come (claimed before sending, so a restart never rings it
 * twice). Only the owner is told; the text is the reminder's own words.
 */
export async function noteTick(now = new Date()): Promise<number> {
  const due = await db()
    .select()
    .from(schema.personalNotes)
    .where(and(eq(schema.personalNotes.kind, "reminder"), isNotNull(schema.personalNotes.remindAt), lte(schema.personalNotes.remindAt, now), isNull(schema.personalNotes.notifiedAt), isNull(schema.personalNotes.doneAt)));
  let sent = 0;
  for (const n of due) {
    const claimed = await db().update(schema.personalNotes).set({ notifiedAt: now }).where(and(eq(schema.personalNotes.id, n.id), isNull(schema.personalNotes.notifiedAt))).returning({ id: schema.personalNotes.id });
    if (!claimed.length) continue;
    await notify([n.userId], { type: "note.reminder", data: { title: n.title, text: n.body.slice(0, 200) }, link: "/pipeline" });
    sent++;
  }
  return sent;
}
