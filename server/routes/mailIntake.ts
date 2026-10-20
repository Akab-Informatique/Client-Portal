import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zEmail, zUuid } from "../lib/validate.ts";
import { O365Error, o365Ready } from "../lib/o365.ts";
import { checkMailbox, intakeSettings, matchSender, recentIntake, runIntake, saveIntakeSettings, settlePending } from "../lib/mailIntake.ts";

/**
 * Admin › Courriel entrant: tickets from the support mailbox. Reading a mailbox
 * with the organisation's access is a master-admin right (outlook.anyMailbox).
 */
export const mailIntakeAdminRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("outlook.anyMailbox"))

  .get("/", async (c) => {
    const [settings, ready, counts, recent] = await Promise.all([
      intakeSettings(),
      o365Ready(),
      db().select({ status: schema.mailIntake.status, n: sql<number>`count(*)::int` }).from(schema.mailIntake).groupBy(schema.mailIntake.status),
      recentIntake(20),
    ]);
    return c.json({
      ...settings,
      o365Ready: ready,
      counts: Object.fromEntries(counts.map((r) => [r.status, r.n])),
      recent: recent.map((r) => ({ id: r.id, from: r.fromName ? `${r.fromName} <${r.fromAddress}>` : r.fromAddress, subject: r.subject, status: r.status, ticketId: r.ticketId, ticketNumber: r.ticketNumber, note: r.note, at: r.createdAt })),
    });
  })

  .put("/", async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ enabled: z.boolean().optional(), mailbox: zEmail.optional(), markRead: z.boolean().optional(), replies: z.boolean().optional() }));
    const cur = await intakeSettings();
    const mailbox = p.mailbox ?? cur.mailbox;
    if (p.enabled && !mailbox) throw new HTTPException(409, { message: "intake_no_mailbox" });
    if (p.enabled && !(await o365Ready())) throw new HTTPException(409, { message: "intake_no_o365" });
    // the mailbox must be readable before it is switched on
    if ((p.enabled || (cur.enabled && p.mailbox)) && mailbox) {
      try {
        await checkMailbox(mailbox);
      } catch (e) {
        throw new HTTPException(409, { message: "intake_mailbox_unreadable", cause: [{ path: "mailbox", message: e instanceof O365Error ? `${e.code}${e.detail ? `: ${e.detail}` : ""}` : "error" }] });
      }
    }
    await saveIntakeSettings(a.user.id, { ...p, mailbox });
    await audit(a.user.id, "mail_intake.settings", null, { enabled: p.enabled, mailbox: p.mailbox });
    return c.json(await intakeSettings());
  })

  /** A pass now (only when it is switched on). */
  .post("/run", async (c) => {
    const a = auth(c);
    const s = await intakeSettings();
    if (!s.enabled) throw new HTTPException(409, { message: "intake_off" });
    const r = await runIntake();
    await audit(a.user.id, "mail_intake.run", null, { ok: r?.ok });
    return c.json(r ?? { ok: false });
  });

/** What technicians see: the emails nobody could be matched to, waiting for a decision. */
export const mailIntakeRoutes = new Hono<AppEnv>()
  .use(requireStaff)
  .use(requirePermission("tickets.edit"))

  .get("/pending", async (c) => {
    const rows = await db().select().from(schema.mailIntake).where(eq(schema.mailIntake.status, "pending")).orderBy(desc(schema.mailIntake.receivedAt)).limit(100);
    // a client may be known by now: suggest it
    const items = await Promise.all(
      rows.map(async (r) => {
        const m = r.fromAddress ? await matchSender(r.fromAddress).catch(() => null) : null;
        return {
          id: r.id,
          from: r.fromAddress,
          fromName: r.fromName,
          subject: r.subject ?? "",
          body: r.body ?? "",
          receivedAt: r.receivedAt,
          companyId: m?.company?.id ?? null,
          contactId: m?.contact?.contactId ?? null,
        };
      }),
    );
    return c.json({ items });
  })

  /** The technician made a ticket from it. */
  .post("/:id/ticket", async (c) => {
    const p = await body(c, z.object({ ticketId: z.number().int().positive(), ticketNumber: z.string().max(40).nullable().optional() }));
    const r = await settlePending(zUuid.parse(c.req.param("id")), { ticketId: p.ticketId, ticketNumber: p.ticketNumber ?? null }, auth(c).user.id);
    if (!r) throw new HTTPException(404, { message: "not_found" });
    return c.json({ ok: true });
  })

  .post("/:id/ignore", async (c) => {
    const r = await settlePending(zUuid.parse(c.req.param("id")), "ignored", auth(c).user.id);
    if (!r) throw new HTTPException(404, { message: "not_found" });
    return c.json({ ok: true });
  });
