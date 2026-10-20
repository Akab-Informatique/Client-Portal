import { and, eq, inArray, like } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { ticketSource } from "./ticketSource.ts";
import { todayQc } from "./timesheets.ts";

/**
 * What the ticket view shows about a ticket's client: its classification
 * (Admin › Classifications) and the hours worked for it this month (Québec),
 * counted from the time entries of its tickets kept in the portal. Time typed
 * straight in Autotask is not in this count until time entries come local.
 * `goal` is where the contract's monthly hours will go; none for now.
 */
export type ClientInfo = {
  class: { key: string; name: string; color: string } | null;
  month: string;
  hours: number;
  goal: number | null;
};

export async function clientInfo(companyId: number): Promise<ClientInfo> {
  const d = db();
  const month = todayQc().slice(0, 7);
  const [row] = await d
    .select({ key: schema.clientClasses.key, name: schema.clientClasses.name, color: schema.clientClasses.color })
    .from(schema.clients)
    .innerJoin(schema.clientClasses, eq(schema.clientClasses.key, schema.clients.classKey))
    .where(eq(schema.clients.autotaskId, companyId));
  const src = await ticketSource();
  // the client's tickets: the source's list (open and recent) and its older, completed ones
  const [now, old] = await Promise.all([src.list(), src.companyHistory(companyId)]);
  const ids = [...new Set([...now.filter((t) => t.company.id === companyId), ...old].map((t) => t.id))];
  let x100 = 0;
  if (ids.length) {
    const rows = await d
      .select({ h: schema.timesheetEntries.hoursX100 })
      .from(schema.timesheetEntries)
      .where(and(inArray(schema.timesheetEntries.ticketId, ids), like(schema.timesheetEntries.date, `${month}-%`)));
    x100 = rows.reduce((n, r) => n + r.h, 0);
  }
  return { class: row ?? null, month, hours: Math.round(x100) / 100, goal: null };
}
