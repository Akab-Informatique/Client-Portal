import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";

/** The queues the meeting gauges count: the ones chosen, or every queue but the alert ones. */
export async function gaugeQueues(all: { value: string; label: string | null; kind?: string }[]) {
  const [row] = await db().select({ config: schema.integrations.config }).from(schema.integrations).where(eq(schema.integrations.provider, "meetings"));
  const chosen = (row?.config as { gaugeQueues?: string[] | null } | undefined)?.gaugeQueues;
  const custom = Array.isArray(chosen) && chosen.some((q) => all.some((x) => x.value === q));
  const counted = custom ? all.filter((q) => chosen!.includes(q.value)).map((q) => q.value) : all.filter((q) => q.kind !== "alerts").map((q) => q.value);
  return { all: all.map((q) => ({ value: q.value, label: q.label ?? q.value })), counted, custom };
}

/** YYYY-MM-DD plus n days */
export function addDay(day: string, n: number) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
