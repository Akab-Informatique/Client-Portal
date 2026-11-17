import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { contractTypes } from "./contracts.ts";
import { recordContractEvent } from "./contractEvents.ts";
import { todayQc } from "./timesheets.ts";

/**
 * The two hourly contracts every client starts with:
 *  - Contrat de soutien, 100 $/h, no end date — the client's default support contract, unless the client already has
 *    one (its own, or a shared contract of its parent): then it is made inactive and not the default;
 *  - Application development, 150 $/h, no end date — active everywhere, never the default.
 * Both start on the first day of the month. A contract that already exists by that name is never made twice.
 */
export const DEFAULT_CONTRACTS = {
  support: { name: "Contrat de soutien", rateCents: 10_000 },
  development: { name: "Application development", rateCents: 15_000 },
} as const;

const norm = (s: string) => s.trim().toLowerCase();

export type DefaultContractsResult = { created: number; supportActive: boolean | null };

export async function ensureDefaultContracts(clientId: string, by: { userId?: string | null } = {}): Promise<DefaultContractsResult> {
  const d = db();
  const types = await contractTypes();
  // the usual "hourly" type, else any hourly one (even turned off: the two contracts must exist), else the type is made
  let type = types.find((t) => t.kind === "hourly" && t.active && t.key === "hourly") ?? types.find((t) => t.kind === "hourly" && t.active) ?? types.find((t) => t.kind === "hourly");
  if (!type) {
    [type] = await d.insert(schema.contractTypes).values({ key: "hourly", name: "Taux horaire", kind: "hourly", position: types.length }).onConflictDoNothing().returning();
    type ??= (await contractTypes()).find((t) => t.kind === "hourly");
    if (!type) return { created: 0, supportActive: null };
  }
  const [client] = await d.select().from(schema.clients).where(eq(schema.clients.id, clientId));
  if (!client) return { created: 0, supportActive: null };
  const own = await d.select().from(schema.clientContracts).where(eq(schema.clientContracts.clientId, clientId));
  const has = (name: string) => own.some((k) => norm(k.name) === norm(name));
  // already a default: one of its own active contracts marked so, or a shared contract of the parent it points to
  let hasDefault = own.some((k) => k.active && (k.supportDefault || k.isDefault));
  if (!hasDefault && client.supportContractId && client.parentId) {
    const [shared] = await d.select({ id: schema.clientContracts.id }).from(schema.clientContracts).where(and(eq(schema.clientContracts.id, client.supportContractId), eq(schema.clientContracts.clientId, client.parentId), eq(schema.clientContracts.active, true), eq(schema.clientContracts.sharedWithChildren, true)));
    hasDefault = Boolean(shared);
  }
  const monthStart = `${todayQc().slice(0, 7)}-01`;
  let created = 0;
  let supportActive: boolean | null = null;
  const make = async (spec: { name: string; rateCents: number }, active: boolean, supportDefault: boolean) => {
    const [row] = await d
      .insert(schema.clientContracts)
      .values({
        clientId,
        autotaskId: `local-${crypto.randomUUID()}`,
        name: spec.name,
        type: type.name,
        typeKey: type.key,
        billingMode: "hourly",
        billingPeriod: "monthly",
        hourlyRateCents: spec.rateCents,
        active,
        supportDefault,
        startDate: monthStart,
        endDate: null,
        syncedAt: new Date(),
      })
      .returning({ id: schema.clientContracts.id });
    await recordContractEvent(row.id, "created", { name: spec.name, type: type.name, startDate: monthStart, endDate: null, billingPeriod: "monthly", auto: true }, { userId: by.userId ?? null });
    created++;
  };
  if (!has(DEFAULT_CONTRACTS.support.name)) {
    supportActive = !hasDefault;
    await make(DEFAULT_CONTRACTS.support, supportActive, supportActive);
  }
  if (!has(DEFAULT_CONTRACTS.development.name)) await make(DEFAULT_CONTRACTS.development, true, false);
  return { created, supportActive };
}

/** Every active client gets the two contracts (the Admin › Clients button). */
export async function ensureDefaultContractsForAll(by: { userId?: string | null } = {}) {
  const ids = await db().select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.active, true));
  let clients = 0;
  let created = 0;
  let supportInactive = 0;
  // parents first so a child sees its parent's shared contract (none are shared by default, but the order costs nothing)
  for (const { id } of ids) {
    const r = await ensureDefaultContracts(id, by);
    if (r.created) clients++;
    created += r.created;
    if (r.supportActive === false) supportInactive++;
  }
  return { companies: ids.length, clients, created, supportInactive };
}

/** How many active clients still lack one of the two contracts (for the confirmation). */
export async function missingDefaultContracts(): Promise<number> {
  const d = db();
  const ids = (await d.select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.active, true))).map((c) => c.id);
  if (!ids.length) return 0;
  const rows = await d.select({ clientId: schema.clientContracts.clientId, name: schema.clientContracts.name }).from(schema.clientContracts).where(inArray(schema.clientContracts.clientId, ids));
  const names = new Map<string, Set<string>>();
  for (const r of rows) (names.get(r.clientId) ?? names.set(r.clientId, new Set()).get(r.clientId)!).add(norm(r.name));
  return ids.filter((id) => !names.get(id)?.has(norm(DEFAULT_CONTRACTS.support.name)) || !names.get(id)?.has(norm(DEFAULT_CONTRACTS.development.name))).length;
}
