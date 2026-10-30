import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zUuid } from "../lib/validate.ts";
import { todayQc } from "../lib/quotes.ts";
import {
  DEFAULT_RATE_PER_USER_CENTS,
  LOST_REASONS,
  SALES_KINDS,
  SALES_PERIODS,
  SALES_SOURCES,
  SALES_STAGES,
  STAGE_PROBABILITY,
  daysBetween,
  isOpenStage,
  monthlyCents,
  periodRange,
  type SalesPeriod,
  type SalesStage,
} from "../../shared/sales.ts";

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max: number) => z.string().trim().max(max).transform((s) => s || null).nullable();

const zOpportunity = z.object({
  companyName: z.string().trim().min(1).max(200),
  clientId: zUuid.nullable(),
  contactName: text(200),
  contactEmail: z.string().trim().toLowerCase().max(254).pipe(z.union([z.email(), z.literal("")])).transform((s) => s || null).nullable(),
  contactPhone: text(40),
  source: z.enum(SALES_SOURCES),
  kind: z.enum(SALES_KINDS),
  users: z.number().int().min(0).max(100_000).nullable(),
  ratePerUserCents: z.number().int().min(0).max(10_000_000),
  oneTimeCents: z.number().int().min(0).max(1_000_000_000).nullable(),
  stage: z.enum(SALES_STAGES),
  probability: z.number().int().min(0).max(100),
  openedOn: zDate,
  quoteSentOn: zDate.nullable(),
  closedOn: zDate.nullable(),
  nextFollowUp: zDate.nullable(),
  lostReason: z.enum(LOST_REASONS).nullable(),
  notes: text(4000),
  ownerId: zUuid.nullable(),
});
type OppInput = z.infer<typeof zOpportunity>;
type Row = typeof schema.salesOpportunities.$inferSelect;

/** The salesperson is an active staff member */
async function staffMember(id: string) {
  const [u] = await db().select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.id, id), eq(schema.users.kind, "staff"), eq(schema.users.active, true)));
  if (!u) throw new HTTPException(400, { message: "owner_invalid" });
}
async function clientExists(id: string) {
  const [c] = await db().select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.id, id));
  if (!c) throw new HTTPException(400, { message: "client_not_found" });
}

/**
 * What follows from a change, the same for a new opportunity and a moved card:
 * a new stage takes its usual probability (unless one was typed), "quote sent" dates
 * the quote, won / lost dates the closing (today unless given), an open stage clears it;
 * a lost deal needs its reason.
 */
export function settle(cur: Partial<Row> | null, patch: Partial<OppInput>, today: string): Partial<OppInput> {
  const prevStage = (cur?.stage ?? null) as SalesStage | null;
  const stage = (patch.stage ?? prevStage ?? "lead") as SalesStage;
  const out: Partial<OppInput> = { ...patch };
  const moved = stage !== prevStage;
  if (moved && patch.probability === undefined) out.probability = STAGE_PROBABILITY[stage];
  const quoteSentOn = patch.quoteSentOn !== undefined ? patch.quoteSentOn : (cur?.quoteSentOn ?? null);
  if (stage === "quote_sent" && !quoteSentOn) out.quoteSentOn = today;
  if (isOpenStage(stage)) {
    if (moved) {
      out.closedOn = null;
      out.lostReason = null;
    }
  } else {
    const wasClosed = prevStage !== null && !isOpenStage(prevStage);
    if (patch.closedOn === undefined && (!wasClosed || !cur?.closedOn)) out.closedOn = today;
    // nothing to follow up once it is settled
    if (patch.nextFollowUp === undefined) out.nextFollowUp = null;
    if (stage === "won") out.lostReason = null;
  }
  const lostReason = out.lostReason !== undefined ? out.lostReason : (cur?.lostReason ?? null);
  if (stage === "lost" && !lostReason) throw new HTTPException(400, { message: "lost_reason_required" });
  return out;
}

async function lookups() {
  const [people, clients] = await Promise.all([
    db().select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(eq(schema.users.kind, "staff")),
    db().select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients),
  ]);
  return { people: new Map(people.map((p) => [p.id, p.name])), clients: new Map(clients.map((x) => [x.id, x.name])) };
}

function view(r: Row, names: Awaited<ReturnType<typeof lookups>>, today: string) {
  return {
    ...r,
    monthlyCents: monthlyCents(r),
    ownerName: r.ownerId ? (names.people.get(r.ownerId) ?? null) : null,
    clientName: r.clientId ? (names.clients.get(r.clientId) ?? null) : null,
    overdue: isOpenStage(r.stage) && !!r.nextFollowUp && r.nextFollowUp < today,
  };
}

const inRange = (d: string | null, from: string, to: string) => !!d && d >= from && d <= to;
const mondayOf = (day: string) => {
  const t = Date.parse(`${day}T00:00:00Z`);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - dow * 86_400_000).toISOString().slice(0, 10);
};
const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

/** Vente › Ventes: opportunities (opportunities.view to see, opportunities.edit to change) and the dashboard. */
export const salesRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("opportunities.view"))

  /** Who an opportunity can be given to */
  .get("/staff", async (c) => {
    const rows = await db().select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(and(eq(schema.users.kind, "staff"), eq(schema.users.active, true))).orderBy(asc(schema.users.name));
    return c.json(rows);
  })

  /** The CRM clients an opportunity can be tied to (without needing the CRM right) */
  .get("/clients", async (c) => {
    const rows = await db().select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.active, true)).orderBy(asc(schema.clients.name));
    return c.json(rows);
  })

  /** Every opportunity (the board and the list filter on screen); optional filters for the list */
  .get("/opportunities", async (c) => {
    const today = todayQc();
    const q = c.req.query();
    const a = auth(c);
    const owner = q.owner === "me" ? a.user.id : q.owner && zUuid.safeParse(q.owner).success ? q.owner : null;
    const list = (s?: string) => (s ? s.split(",").filter(Boolean) : null);
    const stages = list(q.stage);
    const sources = list(q.source);
    const from = q.from && zDate.safeParse(q.from).success ? q.from : null;
    const to = q.to && zDate.safeParse(q.to).success ? q.to : null;
    const rows = await db().select().from(schema.salesOpportunities).orderBy(asc(schema.salesOpportunities.nextFollowUp), asc(schema.salesOpportunities.companyName));
    const names = await lookups();
    return c.json(
      rows
        .filter((r) => !owner || r.ownerId === owner)
        .filter((r) => !stages || stages.includes(r.stage))
        .filter((r) => !sources || sources.includes(r.source))
        .filter((r) => !q.kind || r.kind === q.kind)
        // in the period: opened in it, or won / lost in it
        .filter((r) => !from || !to || inRange(r.openedOn, from, to) || inRange(r.closedOn, from, to))
        .map((r) => view(r, names, today)),
    );
  })

  .post("/opportunities", requirePermission("opportunities.edit"), async (c) => {
    const a = auth(c);
    const today = todayQc();
    const p = await body(
      c,
      zOpportunity.partial().required({ companyName: true }),
    );
    const ownerId = p.ownerId === undefined ? a.user.id : p.ownerId;
    if (ownerId) await staffMember(ownerId);
    if (p.clientId) await clientExists(p.clientId);
    const values = {
      source: "other" as const,
      kind: "recurring" as const,
      ratePerUserCents: DEFAULT_RATE_PER_USER_CENTS,
      openedOn: today,
      ...p,
      ...settle(null, p, today),
    };
    const [row] = await db()
      .insert(schema.salesOpportunities)
      .values({ ...values, ownerId, createdBy: a.user.id })
      .returning();
    await audit(a.user.id, "sales.opportunity_created", row.id, { company: row.companyName, stage: row.stage });
    return c.json(view(row, await lookups(), today), 201);
  })

  .patch("/opportunities/:id", requirePermission("opportunities.edit"), async (c) => {
    const a = auth(c);
    const today = todayQc();
    const id = c.req.param("id");
    if (!zUuid.safeParse(id).success) throw new HTTPException(404, { message: "not_found" });
    const [cur] = await db().select().from(schema.salesOpportunities).where(eq(schema.salesOpportunities.id, id));
    if (!cur) throw new HTTPException(404, { message: "not_found" });
    const p = await body(c, zOpportunity.partial());
    if (p.ownerId) await staffMember(p.ownerId);
    if (p.clientId) await clientExists(p.clientId);
    const changes = settle(cur, p, today);
    const [row] = await db()
      .update(schema.salesOpportunities)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(schema.salesOpportunities.id, id))
      .returning();
    if (changes.stage && changes.stage !== cur.stage) await audit(a.user.id, "sales.opportunity_moved", id, { from: cur.stage, to: changes.stage });
    return c.json(view(row, await lookups(), today));
  })

  .delete("/opportunities/:id", requirePermission("opportunities.edit"), async (c) => {
    const a = auth(c);
    const id = c.req.param("id");
    if (!zUuid.safeParse(id).success) throw new HTTPException(404, { message: "not_found" });
    const [row] = await db().delete(schema.salesOpportunities).where(eq(schema.salesOpportunities.id, id)).returning({ id: schema.salesOpportunities.id, companyName: schema.salesOpportunities.companyName });
    if (!row) throw new HTTPException(404, { message: "not_found" });
    await audit(a.user.id, "sales.opportunity_deleted", id, { company: row.companyName });
    return c.json({ ok: true });
  })

  /**
   * The dashboard of a period (month, quarter or financial year around `day`):
   * results, pipeline, efficiency and activity. Optional `owner` (an id or "me").
   */
  .get("/dashboard", async (c) => {
    const a = auth(c);
    const today = todayQc();
    const q = c.req.query();
    const period: SalesPeriod = (SALES_PERIODS as readonly string[]).includes(q.period ?? "") ? (q.period as SalesPeriod) : "month";
    const day = q.day && zDate.safeParse(q.day).success ? q.day : today;
    const range = periodRange(period, day);
    const { from, to } = range;
    const owner = q.owner === "me" ? a.user.id : q.owner && zUuid.safeParse(q.owner).success ? q.owner : null;
    const names = await lookups();
    const all = (await db().select().from(schema.salesOpportunities)).filter((r) => !owner || r.ownerId === owner);

    const won = all.filter((r) => r.stage === "won");
    const wonIn = won.filter((r) => inRange(r.closedOn, from, to));
    const lostIn = all.filter((r) => r.stage === "lost" && inRange(r.closedOn, from, to));
    const open = all.filter((r) => isOpenStage(r.stage));
    const sum = (rows: Row[], f: (r: Row) => number) => rows.reduce((n, r) => n + f(r), 0);
    const recurringWon = won.filter((r) => r.kind === "recurring");
    // what is under contract at the end of the period (won up to then)
    const upTo = (end: string) => recurringWon.filter((r) => (r.closedOn ?? "") <= end);

    // MRR month by month: the 12 months ending with the period's last month
    const [ty, tm] = to.split("-").map(Number);
    const mrrSeries = Array.from({ length: 12 }, (_, i) => {
      const k = ty * 12 + (tm - 1) - (11 - i);
      const y = Math.floor(k / 12);
      const m = (k % 12) + 1;
      const end = monthEnd(y, m);
      const start = `${y}-${String(m).padStart(2, "0")}-01`;
      return {
        month: start.slice(0, 7),
        mrrCents: sum(upTo(end), monthlyCents),
        addedCents: sum(recurringWon.filter((r) => inRange(r.closedOn, start, end)), monthlyCents),
      };
    });

    // quotes sent: by week (month, quarter) or by month (financial year)
    const sentIn = all.filter((r) => inRange(r.quoteSentOn, from, to));
    const buckets: { start: string; count: number }[] = [];
    if (period === "year") {
      for (let d = from; d <= to; ) {
        const [y, m] = d.split("-").map(Number);
        const end = monthEnd(y, m);
        buckets.push({ start: d, count: sentIn.filter((r) => inRange(r.quoteSentOn, d, end)).length });
        d = new Date(Date.parse(`${end}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      }
    } else {
      for (let d = mondayOf(from); d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10)) {
        const end = new Date(Date.parse(`${d}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
        buckets.push({ start: d, count: sentIn.filter((r) => inRange(r.quoteSentOn, d, end)).length });
      }
    }

    const count = <K extends string>(rows: Row[], key: (r: Row) => K | null) => {
      const m = new Map<K, { count: number; mrrCents: number; oneTimeCents: number }>();
      for (const r of rows) {
        const k = key(r);
        if (!k) continue;
        const cur = m.get(k) ?? { count: 0, mrrCents: 0, oneTimeCents: 0 };
        cur.count += 1;
        cur.mrrCents += monthlyCents(r);
        cur.oneTimeCents += r.kind === "one_time" ? (r.oneTimeCents ?? 0) : 0;
        m.set(k, cur);
      }
      return [...m.entries()].map(([k, v]) => ({ key: k, ...v })).sort((x, y) => y.count - x.count);
    };
    const cycles = wonIn.filter((r) => r.closedOn).map((r) => daysBetween(r.openedOn, r.closedOn!));
    const closedCount = wonIn.length + lostIn.length;

    return c.json({
      period,
      ...range,
      today,
      results: {
        mrrAddedCents: sum(wonIn.filter((r) => r.kind === "recurring"), monthlyCents),
        mrrAddedDeals: wonIn.filter((r) => r.kind === "recurring").length,
        mrrTotalCents: sum(upTo(to), monthlyCents),
        usersUnderContract: sum(upTo(to), (r) => r.users ?? 0),
        oneTimeWonCents: sum(wonIn.filter((r) => r.kind === "one_time"), (r) => r.oneTimeCents ?? 0),
        oneTimeWonDeals: wonIn.filter((r) => r.kind === "one_time").length,
        mrrSeries,
      },
      pipeline: {
        openDeals: open.length,
        openMrrCents: sum(open, monthlyCents),
        weightedMrrCents: Math.round(sum(open, (r) => (monthlyCents(r) * r.probability) / 100)),
        openOneTimeCents: sum(open.filter((r) => r.kind === "one_time"), (r) => r.oneTimeCents ?? 0),
        weightedOneTimeCents: Math.round(sum(open.filter((r) => r.kind === "one_time"), (r) => ((r.oneTimeCents ?? 0) * r.probability) / 100)),
        byStage: SALES_STAGES.filter(isOpenStage).map((s) => {
          const rows = open.filter((r) => r.stage === s);
          return { stage: s, count: rows.length, mrrCents: sum(rows, monthlyCents) };
        }),
      },
      efficiency: {
        won: wonIn.length,
        lost: lostIn.length,
        conversionPct: closedCount ? Math.round((wonIn.length / closedCount) * 1000) / 10 : null,
        avgCycleDays: cycles.length ? Math.round(cycles.reduce((n, d) => n + d, 0) / cycles.length) : null,
        bySource: count(wonIn, (r) => r.source),
        lostReasons: count(lostIn, (r) => r.lostReason),
      },
      activity: {
        overdue: open
          .filter((r) => r.nextFollowUp && r.nextFollowUp < today)
          .sort((x, y) => (x.nextFollowUp! < y.nextFollowUp! ? -1 : 1))
          .map((r) => view(r, names, today)),
        dueToday: open.filter((r) => r.nextFollowUp === today).length,
        quotesSent: sentIn.length,
        quotesSentBy: period === "year" ? "month" : "week",
        quotesSentSeries: buckets,
      },
    });
  });
