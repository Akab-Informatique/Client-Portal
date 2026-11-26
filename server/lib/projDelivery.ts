import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { sql } from "drizzle-orm";
import { MASTER_ROLE } from "../../shared/permissions.ts";
import { audit } from "./audit.ts";
import { notifyTechs } from "./techNotify.ts";

/**
 * Who checks and bills a project when a technician marks it delivered: the people picked in the setting
 * (`integrations` provider `proj`, config `deliveryReviewers`), else the master administrators. Active staff only,
 * never the person who clicked.
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

const fmtH = (n: number) => n.toLocaleString("fr-CA", { maximumFractionDigits: 2 });

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
