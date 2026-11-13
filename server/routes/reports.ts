import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body } from "../lib/validate.ts";
import { rateLimit } from "../lib/http.ts";
import { cadenceLabel, deliver, nextRunAfter, runReport, sourceList, SOURCE_KEYS, USAGE_KEY, type Lang } from "../lib/reports.ts";

/**
 * Reports. Reading (`reports.view`): the definitions, the schedules, the runs and their text. Changing
 * (`reports.manage`): custom reports, schedules, running a report now and sending it. Built-in reports cannot be
 * deleted or edited, only their schedule.
 */

const uuidOf = (v: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new HTTPException(404, { message: "not_found" });
  return v;
};

const channelsSchema = z.object({
  email: z.array(z.string().trim().toLowerCase().email().max(200)).max(10),
  sms: z.array(z.string().trim().min(7).max(30)).max(10),
  teams: z.boolean(),
});
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time_invalid");
const scheduleBody = z.object({
  frequency: z.enum(["daily", "weekly", "monthly"]),
  time: timeSchema,
  weekday: z.number().int().min(0).max(6).nullable(),
  dayOfMonth: z.number().int().min(1).max(28).nullable(),
  enabled: z.boolean(),
  channels: channelsSchema,
});
const sourceKey = z.string().refine((k) => SOURCE_KEYS.includes(k), "source_unknown");
const reportBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500),
  sources: z.array(sourceKey).min(1).max(SOURCE_KEYS.length),
  period: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  aiSummary: z.boolean(),
});

const RUN_LIST = {
  id: schema.reportRuns.id,
  reportId: schema.reportRuns.reportId,
  scheduleId: schema.reportRuns.scheduleId,
  trigger: schema.reportRuns.trigger,
  status: schema.reportRuns.status,
  startedAt: schema.reportRuns.startedAt,
  finishedAt: schema.reportRuns.finishedAt,
  summary: schema.reportRuns.summary,
  error: schema.reportRuns.error,
  delivered: schema.reportRuns.delivered,
};

/** One schedule as the screens show it: what it does, when next, and how the last run went. */
async function scheduleView(s: typeof schema.reportSchedules.$inferSelect, lang: Lang) {
  const [last] = await db()
    .select({ status: schema.reportRuns.status, startedAt: schema.reportRuns.startedAt })
    .from(schema.reportRuns)
    .where(eq(schema.reportRuns.scheduleId, s.id))
    .orderBy(desc(schema.reportRuns.startedAt))
    .limit(1);
  return {
    id: s.id,
    reportId: s.reportId,
    frequency: s.frequency,
    time: s.time,
    weekday: s.weekday,
    dayOfMonth: s.dayOfMonth,
    enabled: s.enabled,
    channels: s.channels,
    label: cadenceLabel(s, lang),
    nextRunAt: s.nextRunAt,
    lastRunAt: s.lastRunAt,
    lastStatus: last?.status ?? null,
  };
}

async function reportOr404(id: string) {
  const [def] = await db().select().from(schema.reportDefinitions).where(eq(schema.reportDefinitions.id, uuidOf(id)));
  if (!def) throw new HTTPException(404, { message: "not_found" });
  return def;
}

/** Schedule values with the defaults of the screen (a weekly one is on Monday, a monthly one the 1st). */
function cadenceOf(p: z.infer<typeof scheduleBody>) {
  return {
    frequency: p.frequency,
    time: p.time,
    weekday: p.frequency === "weekly" ? (p.weekday ?? 1) : null,
    dayOfMonth: p.frequency === "monthly" ? (p.dayOfMonth ?? 1) : null,
  };
}

async function listRuns(reportId: string | null, limit: number, before: Date | null) {
  const conds = [reportId ? eq(schema.reportRuns.reportId, reportId) : undefined, before ? lt(schema.reportRuns.startedAt, before) : undefined].filter(Boolean) as any[];
  const rows = await db()
    .select({ ...RUN_LIST, reportName: schema.reportDefinitions.name, reportKind: schema.reportDefinitions.kind })
    .from(schema.reportRuns)
    .innerJoin(schema.reportDefinitions, eq(schema.reportDefinitions.id, schema.reportRuns.reportId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.reportRuns.startedAt))
    .limit(limit);
  return { runs: rows, nextBefore: rows.length === limit ? rows[rows.length - 1].startedAt : null };
}

export const reportRoutes = new Hono<AppEnv>()
  /** Every report with its schedules and its last run; the sources a custom report can use. */
  .get("/", requirePermission("reports.view"), async (c) => {
    const a = auth(c);
    const lang = a.user.locale as Lang;
    const defs = await db().select().from(schema.reportDefinitions).orderBy(asc(schema.reportDefinitions.createdAt));
    const scheds = await db().select().from(schema.reportSchedules);
    const reports = await Promise.all(
      defs.map(async (d) => {
        const [last] = await db()
          .select(RUN_LIST)
          .from(schema.reportRuns)
          .where(eq(schema.reportRuns.reportId, d.id))
          .orderBy(desc(schema.reportRuns.startedAt))
          .limit(1);
        return {
          id: d.id,
          key: d.key,
          kind: d.kind,
          name: d.name,
          description: d.description,
          config: d.config,
          createdAt: d.createdAt,
          schedules: await Promise.all(scheds.filter((s) => s.reportId === d.id).map((s) => scheduleView(s, lang))),
          lastRun: last ?? null,
        };
      }),
    );
    return c.json({ reports, sources: sourceList(lang), usageKey: USAGE_KEY });
  })

  /** Everything scheduled: what, how often, when next, where it goes, how the last run went. */
  .get("/schedules", requirePermission("reports.view"), async (c) => {
    const lang = auth(c).user.locale as Lang;
    const rows = await db()
      .select({ s: schema.reportSchedules, name: schema.reportDefinitions.name, kind: schema.reportDefinitions.kind, key: schema.reportDefinitions.key })
      .from(schema.reportSchedules)
      .innerJoin(schema.reportDefinitions, eq(schema.reportDefinitions.id, schema.reportSchedules.reportId))
      .orderBy(asc(schema.reportSchedules.nextRunAt));
    return c.json(
      await Promise.all(
        rows.map(async (r) => ({ ...(await scheduleView(r.s, lang)), reportName: r.name, reportKind: r.kind, reportKey: r.key })),
      ),
    );
  })

  /** The history of all runs, newest first, 50 at a time (`before` = the start of the last one of the page). */
  .get("/runs", requirePermission("reports.view"), async (c) => {
    const reportId = c.req.query("reportId") ? uuidOf(c.req.query("reportId")!) : null;
    const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
    const before = c.req.query("before") ? new Date(c.req.query("before")!) : null;
    return c.json(await listRuns(reportId, limit, before && !Number.isNaN(before.getTime()) ? before : null));
  })

  /** One run in full: its text, its data and what each channel answered. */
  .get("/runs/:runId", requirePermission("reports.view"), async (c) => {
    const [run] = await db()
      .select({ ...RUN_LIST, body: schema.reportRuns.body, data: schema.reportRuns.data, reportName: schema.reportDefinitions.name })
      .from(schema.reportRuns)
      .innerJoin(schema.reportDefinitions, eq(schema.reportDefinitions.id, schema.reportRuns.reportId))
      .where(eq(schema.reportRuns.id, uuidOf(c.req.param("runId"))));
    if (!run) throw new HTTPException(404, { message: "not_found" });
    return c.json(run);
  })

  .get("/:id/runs", requirePermission("reports.view"), async (c) => {
    const def = await reportOr404(c.req.param("id"));
    const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
    const before = c.req.query("before") ? new Date(c.req.query("before")!) : null;
    return c.json(await listRuns(def.id, limit, before && !Number.isNaN(before.getTime()) ? before : null));
  })

  /** A custom report. */
  .post("/", requirePermission("reports.manage"), async (c) => {
    const a = auth(c);
    const p = await body(c, reportBody);
    const [row] = await db()
      .insert(schema.reportDefinitions)
      .values({ kind: "custom", name: p.name, description: p.description, config: { sources: p.sources, period: p.period, aiSummary: p.aiSummary }, createdBy: a.user.id })
      .returning();
    await audit(a.user.id, "report.created", row.id, { name: p.name, sources: p.sources.length });
    return c.json(row, 201);
  })

  .patch("/:id", requirePermission("reports.manage"), async (c) => {
    const a = auth(c);
    const def = await reportOr404(c.req.param("id"));
    if (def.kind !== "custom") throw new HTTPException(409, { message: "builtin_locked" });
    const p = await body(c, reportBody.partial());
    const config = { ...def.config, ...(p.sources ? { sources: p.sources } : {}), ...(p.period ? { period: p.period } : {}), ...(p.aiSummary !== undefined ? { aiSummary: p.aiSummary } : {}) };
    const [row] = await db()
      .update(schema.reportDefinitions)
      .set({ ...(p.name ? { name: p.name } : {}), ...(p.description !== undefined ? { description: p.description } : {}), config, updatedAt: new Date() })
      .where(eq(schema.reportDefinitions.id, def.id))
      .returning();
    await audit(a.user.id, "report.updated", def.id, { name: row.name });
    return c.json(row);
  })

  .delete("/:id", requirePermission("reports.manage"), async (c) => {
    const a = auth(c);
    const def = await reportOr404(c.req.param("id"));
    if (def.kind !== "custom") throw new HTTPException(409, { message: "builtin_locked" });
    await db().delete(schema.reportDefinitions).where(eq(schema.reportDefinitions.id, def.id));
    await audit(a.user.id, "report.deleted", def.id, { name: def.name });
    return c.json({ ok: true });
  })

  /**
   * Runs a report now and stores the run. `deliver: true` sends it to the channels given (or to a schedule's
   * channels when `scheduleId` is given). Rate limited: a run calls the AI when asked.
   */
  .post("/:id/run", requirePermission("reports.manage"), async (c) => {
    const a = auth(c);
    if (!rateLimit(`report-run:${a.user.id}`, 20, 10 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const def = await reportOr404(c.req.param("id"));
    const p = await body(c, z.object({ deliver: z.boolean().optional(), scheduleId: z.string().optional(), channels: channelsSchema.optional() }));
    const lang = a.user.locale as Lang;
    const run = await runReport(def.id, { trigger: "manual", startedBy: a.user.id, lang });
    let delivered = null;
    if (p.deliver && run.status === "ok") {
      let channels = p.channels ?? null;
      if (!channels && p.scheduleId) {
        const [s] = await db()
          .select()
          .from(schema.reportSchedules)
          .where(and(eq(schema.reportSchedules.id, uuidOf(p.scheduleId)), eq(schema.reportSchedules.reportId, def.id)));
        channels = s?.channels ?? null;
      }
      if (channels) {
        delivered = await deliver(run, def.name, channels, lang);
        await db().update(schema.reportRuns).set({ delivered }).where(eq(schema.reportRuns.id, run.id));
      }
    }
    await audit(a.user.id, "report.run", def.id, { trigger: "manual", status: run.status, delivered: Boolean(delivered) });
    return c.json({ run: { ...run, delivered: delivered ?? run.delivered }, delivered });
  })

  .post("/:id/schedules", requirePermission("reports.manage"), async (c) => {
    const a = auth(c);
    const def = await reportOr404(c.req.param("id"));
    const p = await body(c, scheduleBody);
    const cad = cadenceOf(p);
    const [row] = await db()
      .insert(schema.reportSchedules)
      .values({ reportId: def.id, ...cad, enabled: p.enabled, channels: p.channels, nextRunAt: nextRunAfter(cad, new Date()), createdBy: a.user.id })
      .returning();
    await audit(a.user.id, "report.schedule_created", def.id, { frequency: p.frequency, enabled: p.enabled });
    return c.json(await scheduleView(row, a.user.locale as Lang), 201);
  })

  .patch("/schedules/:sid", requirePermission("reports.manage"), async (c) => {
    const a = auth(c);
    const [old] = await db().select().from(schema.reportSchedules).where(eq(schema.reportSchedules.id, uuidOf(c.req.param("sid"))));
    if (!old) throw new HTTPException(404, { message: "not_found" });
    const p = await body(c, scheduleBody.partial());
    const merged = {
      frequency: p.frequency ?? old.frequency,
      time: p.time ?? old.time,
      weekday: p.weekday !== undefined ? p.weekday : old.weekday,
      dayOfMonth: p.dayOfMonth !== undefined ? p.dayOfMonth : old.dayOfMonth,
      enabled: p.enabled ?? old.enabled,
      channels: p.channels ?? old.channels,
    };
    const cad = cadenceOf(merged);
    const [row] = await db()
      .update(schema.reportSchedules)
      .set({ ...cad, enabled: merged.enabled, channels: merged.channels, nextRunAt: nextRunAfter(cad, new Date()), updatedAt: new Date() })
      .where(eq(schema.reportSchedules.id, old.id))
      .returning();
    await audit(a.user.id, "report.schedule_updated", old.reportId, { frequency: merged.frequency, enabled: merged.enabled });
    return c.json(await scheduleView(row, a.user.locale as Lang));
  })

  .delete("/schedules/:sid", requirePermission("reports.manage"), async (c) => {
    const a = auth(c);
    const [old] = await db().select().from(schema.reportSchedules).where(eq(schema.reportSchedules.id, uuidOf(c.req.param("sid"))));
    if (!old) throw new HTTPException(404, { message: "not_found" });
    await db().delete(schema.reportSchedules).where(eq(schema.reportSchedules.id, old.id));
    await audit(a.user.id, "report.schedule_deleted", old.reportId, {});
    return c.json({ ok: true });
  });
