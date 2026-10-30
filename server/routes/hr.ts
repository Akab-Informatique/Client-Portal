import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv, type AuthContext } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zUuid } from "../lib/validate.ts";
import { balances, hrProfile, moneyOf, hoursOf, negativeAccounts, warnNegative } from "../lib/hr.ts";

/**
 * Human resources: the RH tab of an employee. `hr.manage` (administrators) sees and changes everyone's; `hr.own` only
 * one's own file, read only. The hours bank and the vacation bank are in dollars, the sick days in hours.
 */
const canAll = (a: AuthContext) => a.permissions.includes("hr.manage");

/** Whose file: one's own (hr.own or hr.manage), or anyone's active or former staff member for hr.manage */
async function fileOf(a: AuthContext, asked: string): Promise<string> {
  const id = zUuid.parse(asked);
  if (id === a.user.id) {
    if (!a.permissions.includes("hr.own") && !canAll(a)) throw new HTTPException(403, { message: "Forbidden" });
    return id;
  }
  if (!canAll(a)) throw new HTTPException(403, { message: "Forbidden" });
  const [u] = await db().select({ kind: schema.users.kind }).from(schema.users).where(eq(schema.users.id, id));
  if (!u || u.kind !== "staff") throw new HTTPException(404, { message: "not_found" });
  return id;
}

async function fileView(userId: string) {
  const [profile, bal] = await Promise.all([hrProfile(userId), balances(userId)]);
  const wage = profile.hourlyWageCents;
  return {
    userId,
    hourlyWageCents: wage,
    overtimeAfterHours: profile.overtimeAfterX100 / 100,
    bankCents: bal.bankCents,
    /** The bank in hours at today's wage (for a picture; the money is what is kept) */
    bankHours: wage ? hoursOf(bal.bankCents, wage) / 100 : null,
    vacationCents: bal.vacationCents,
    vacationHours: wage ? hoursOf(bal.vacationCents, wage) / 100 : null,
    sickHours: bal.sickHoursX100 / 100,
    negative: await negativeAccounts(userId),
  };
}

export const hrRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  /** Everyone, for the RH page */
  .get("/people", requirePermission("hr.manage"), async (c) => {
    const users = await db()
      .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email, active: schema.users.active })
      .from(schema.users)
      .where(eq(schema.users.kind, "staff"))
      .orderBy(asc(schema.users.name));
    const out = [];
    for (const u of users) out.push({ ...u, ...(await fileView(u.id)) });
    return c.json(out);
  })
  .get("/:userId", requirePermission("hr.manage", "hr.own"), async (c) => {
    const a = auth(c);
    const id = await fileOf(a, c.req.param("userId"));
    return c.json({ ...(await fileView(id)), canEdit: canAll(a) });
  })
  /** What moved the accounts, newest first */
  .get("/:userId/ledger", requirePermission("hr.manage", "hr.own"), async (c) => {
    const id = await fileOf(auth(c), c.req.param("userId"));
    const rows = await db()
      .select({ l: schema.hrLedger, by: schema.users.name })
      .from(schema.hrLedger)
      .leftJoin(schema.users, eq(schema.users.id, schema.hrLedger.createdBy))
      .where(eq(schema.hrLedger.userId, id))
      .orderBy(desc(schema.hrLedger.createdAt))
      .limit(200);
    return c.json(rows.map((r) => ({ id: r.l.id, account: r.l.account, kind: r.l.kind, cents: r.l.cents, hours: r.l.hoursX100 == null ? null : r.l.hoursX100 / 100, weekStart: r.l.weekStart, note: r.l.note, by: r.by, at: r.l.createdAt })));
  })
  .put("/:userId/profile", requirePermission("hr.manage"), async (c) => {
    const a = auth(c);
    const id = await fileOf(a, c.req.param("userId"));
    const p = await body(c, z.object({ hourlyWage: z.number().min(0).max(10_000).nullable().optional(), overtimeAfterHours: z.number().min(1).max(168).optional() }));
    const cur = await hrProfile(id);
    const wage = p.hourlyWage === undefined ? cur.hourlyWageCents : p.hourlyWage === null || p.hourlyWage === 0 ? null : Math.round(p.hourlyWage * 100);
    const overtime = p.overtimeAfterHours === undefined ? cur.overtimeAfterX100 : Math.round(p.overtimeAfterHours * 100);
    await db()
      .insert(schema.hrProfiles)
      .values({ userId: id, hourlyWageCents: wage, overtimeAfterX100: overtime })
      .onConflictDoUpdate({ target: schema.hrProfiles.userId, set: { hourlyWageCents: wage, overtimeAfterX100: overtime, updatedAt: new Date() } });
    await audit(a.user.id, "hr.profile_changed", id, { wage: wage != null, overtimeAfter: overtime / 100 });
    return c.json(await fileView(id));
  })
  /**
   * A change by hand to one of the accounts. The confirmation box has to be ticked (`confirm: true`). The bank and the
   * vacation are changed in dollars (or, for the bank, in hours at the hourly wage); the sick days in hours. A positive
   * number adds, a negative one takes off; below zero is allowed (the admins are told).
   */
  .post("/:userId/adjust", requirePermission("hr.manage"), async (c) => {
    const a = auth(c);
    const id = await fileOf(a, c.req.param("userId"));
    const p = await body(
      c,
      z.object({
        account: z.enum(["bank", "vacation", "sick"]),
        amount: z.number().min(-1_000_000).max(1_000_000).optional(),
        hours: z.number().min(-10_000).max(10_000).optional(),
        note: z.string().trim().max(300).default(""),
        confirm: z.literal(true),
      }),
    );
    const { hourlyWageCents: wage } = await hrProfile(id);
    let cents: number | null = null;
    let hoursX100: number | null = null;
    if (p.account === "sick") {
      if (p.hours == null) throw new HTTPException(400, { message: "Validation failed" });
      hoursX100 = Math.round(p.hours * 100);
    } else if (p.amount != null) cents = Math.round(p.amount * 100);
    else if (p.hours != null) {
      if (!wage) throw new HTTPException(409, { message: "hr_wage_missing" });
      cents = moneyOf(Math.round(p.hours * 100), wage);
    } else throw new HTTPException(400, { message: "Validation failed" });
    if (!cents && !hoursX100) throw new HTTPException(400, { message: "Validation failed" });
    await db().insert(schema.hrLedger).values({ userId: id, account: p.account, kind: "manual", cents, hoursX100, note: p.note || null, createdBy: a.user.id });
    const negative = await negativeAccounts(id);
    await warnNegative(id, negative);
    await audit(a.user.id, "hr.adjusted", id, { account: p.account, cents, hoursX100, note: p.note });
    return c.json(await fileView(id), 201);
  });

