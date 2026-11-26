import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { sql } from "drizzle-orm";
import { MASTER_ROLE } from "../../shared/permissions.ts";
import { audit } from "./audit.ts";
import { notifyTechs } from "./techNotify.ts";

/**
 * Who checks and bills a project when a technician marks it delivered: the people picked in the setting
 * (`integrations` provider `proj`, config `deliveryReviewers`), else the master administrators (also when the picked ones are gone).
 * Active staff only; the person who clicked is told too when they are a reviewer.
 */
export const PROJ_PROVIDER = "proj";

async function activeOf(ids: string[]): Promise<{ id: string; name: string }[]> {
  if (!ids.length) return [];
  return db()
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(and(inArray(schema.users.id, ids), eq(schema.users.kind, "staff"), eq(schema.users.active, true)));
}

/** The ids saved in the setting (may name people who are gone since) */
export async function configuredReviewers(): Promise<string[]> {
  const [row] = await db().select({ config: schema.integrations.config }).from(schema.integrations).where(eq(schema.integrations.provider, PROJ_PROVIDER));
  const v = (row?.config as { deliveryReviewers?: unknown } | null)?.deliveryReviewers;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function setReviewers(ids: string[]): Promise<void> {
  const [row] = await db().select({ config: schema.integrations.config }).from(schema.integrations).where(eq(schema.integrations.provider, PROJ_PROVIDER));
  const config = { ...((row?.config ?? {}) as Record<string, unknown>), deliveryReviewers: [...new Set(ids)] };
  if (row) await db().update(schema.integrations).set({ config, updatedAt: new Date() }).where(eq(schema.integrations.provider, PROJ_PROVIDER));
  else await db().insert(schema.integrations).values({ provider: PROJ_PROVIDER, enabled: true, config }).onConflictDoNothing();
}

/** The people who are told, as the setting stands now (default: the master administrators) */
export async function effectiveReviewers(): Promise<{ id: string; name: string }[]> {
  const picked = await activeOf(await configuredReviewers());
  if (picked.length) return picked;
  const [role] = await db().select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.slug, MASTER_ROLE));
  if (!role) return [];
  return db()
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(and(eq(schema.users.roleId, role.id), eq(schema.users.kind, "staff"), eq(schema.users.active, true)));
}

export type DeliveryBilling = { status: "created" | "already" | "time_lines" | "nothing"; reason?: string };

/** Delivered = to Approbation: the project's single line (hours sold / price sold), else its time lines are copied. Never throws, never bills twice. */
export async function billOnDelivery(projectId: string): Promise<DeliveryBilling> {
  try {
    const { billProj, ProjBillError } = await import("./projBilling.ts");
    try {
      await billProj(projectId);
      const { syncBillablesNow } = await import("./billables.ts");
      await syncBillablesNow();
      return { status: "created" };
    } catch (e) {
      if (!(e instanceof ProjBillError)) throw e;
      if (e.message === "project_billed") return { status: "already" };
      if (e.message === "project_not_sold") {
        // an hourly project with no hours sold: its time is emitted entry by entry, just copy it
        const { syncBillablesNow } = await import("./billables.ts");
        await syncBillablesNow();
        return { status: "time_lines" };
      }
      return { status: "nothing", reason: e.message };
    }
  } catch (e) {
    console.warn("[proj] billing on delivery failed", e);
    return { status: "nothing", reason: "failed" };
  }
}

/** Undo: the line the delivery made is removed while it is still all pending; an approved / invoiced one stays. */
export async function unbillOnDelivery(projectId: string, deliveredAt: Date | null): Promise<{ removed: boolean; kept?: boolean }> {
  const d = db();
  const [p] = await d.select().from(schema.projProjects).where(eq(schema.projProjects.id, projectId));
  if (!p?.invoicedAt || (deliveredAt && p.invoicedAt < deliveredAt)) return { removed: false };
  const lines = await d.select({ id: schema.billingItems.id, status: schema.billingItems.status }).from(schema.billingItems).where(sql`${schema.billingItems.sourceId} like ${`project:${projectId}%`}`);
  if (!lines.length) return { removed: false };
  if (lines.some((l) => l.status !== "pending")) return { removed: false, kept: true };
  await d.delete(schema.billingItems).where(inArray(schema.billingItems.id, lines.map((l) => l.id)));
  await d.update(schema.projProjects).set({ invoicedAt: null }).where(eq(schema.projProjects.id, projectId));
  return { removed: true };
}

const fmtH =(n: number) => n.toLocaleString("fr-CA", { maximumFractionDigits: 2 });

/**
 * Called after time is added to or removed from a project, or its hours sold change: when the hours worked pass the hours sold the
 * reviewers are told once (bell + email); back under, the mark is cleared so a later crossing tells again. Never throws.
 */
export async function checkOverrun(projectId: string): Promise<void> {
  try {
    const d = db();
    const [p] = await d.select().from(schema.projProjects).where(eq(schema.projProjects.id, projectId));
    if (!p) return;
    const sold = p.soldHoursX100 ?? 0;
    const [{ w }] = await d.select({ w: sql<number>`coalesce(sum(${schema.timesheetEntries.hoursX100}), 0)::int` }).from(schema.timesheetEntries).where(eq(schema.timesheetEntries.projId, p.id));
    const worked = Number(w);
    if (sold <= 0 || worked <= sold) {
      if (p.overrunNotifiedAt) await d.update(schema.projProjects).set({ overrunNotifiedAt: null }).where(eq(schema.projProjects.id, p.id));
      return;
    }
    if (p.overrunNotifiedAt) return;
    // claimed before telling, so two entries at once tell once
    const claimed = await d
      .update(schema.projProjects)
      .set({ overrunNotifiedAt: new Date() })
      .where(and(eq(schema.projProjects.id, p.id), sql`${schema.projProjects.overrunNotifiedAt} is null`))
      .returning({ id: schema.projProjects.id });
    if (!claimed.length) return;
    let client = "";
    if (p.clientId) client = (await d.select({ name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.id, p.clientId)))[0]?.name ?? "";
    const text = `${fmtH(worked / 100)} h travaillées sur ${fmtH(sold / 100)} h vendues`;
    const ids = (await effectiveReviewers()).map((x) => x.id);
    const told = ids.length
      ? await notifyTechs(
          { id: 0, number: p.number, title: p.name, company: { name: client }, link: `/pipeline?section=tickets&pj=${p.id}`, headFull: `Projet ${p.number} — ${p.name}${client ? ` (${client})` : ""} : ${text}`, bellMessage: text, bellType: "proj.overrun" },
          { id: "", name: "AKAB" },
          ids,
          "",
          { email: true, sms: false, teams: false, bell: true },
        )
      : [];
    await audit(null, "proj.overrun_notified", p.id, { number: p.number, worked: worked / 100, sold: sold / 100, notified: told.map((x) => x.id) });
  } catch (e) {
    console.warn("[proj] overrun check failed", e);
  }
}
