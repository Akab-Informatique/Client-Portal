import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body } from "../lib/validate.ts";
import { clientIp, rateLimit } from "../lib/http.ts";
import { config } from "../config.ts";
import { contactsList, contactOfToken, emailOfContact, isUnsubscribed, resubscribe, subscribers, unsubscribe } from "../lib/newsletter.ts";

/**
 * Newsletter. Public (the signed unsubscribe link, no sign-in): see and confirm. Staff / API key: the list of
 * subscribers with each one's unsubscribe link (`newsletter.view`), and manual opt-outs (`newsletter.manage`).
 */
const mask = (e: string) => e.replace(/^(.).*(@.*)$/, "$1***$2");

async function target(token: string) {
  const id = contactOfToken(token);
  const email = id ? await emailOfContact(id) : null;
  if (!email) throw new HTTPException(404, { message: "not_found" });
  return email;
}

export const newsletterRoutes = new Hono<AppEnv>()
  .get("/public/:token", async (c) => {
    if (!rateLimit(`nl-view:${clientIp(c)}`, 60, 10 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const email = await target(c.req.param("token"));
    return c.json({ email: mask(email), unsubscribed: await isUnsubscribed(email) });
  })
  .post("/public/:token/unsubscribe", async (c) => {
    if (!rateLimit(`nl-do:${clientIp(c)}`, 20, 10 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const email = await target(c.req.param("token"));
    await unsubscribe(email, "link");
    await audit(null, "newsletter.unsubscribed", mask(email), { via: "link" });
    return c.json({ ok: true });
  })
  .post("/public/:token/resubscribe", async (c) => {
    if (!rateLimit(`nl-do:${clientIp(c)}`, 20, 10 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const email = await target(c.req.param("token"));
    await resubscribe(email);
    await audit(null, "newsletter.resubscribed", mask(email), { via: "link" });
    return c.json({ ok: true });
  })

  .use("/subscribers", requireStaff)
  .use("/optouts", requireStaff)
  .use("/contacts", requireStaff)
  .use("/issues", requireStaff)
  .use("/issues/*", requireStaff)
  .get("/subscribers", requirePermission("newsletter.view"), async (c) => {
    if (!config.publicUrl) throw new HTTPException(409, { message: "public_url_missing" });
    const { list, unsubscribed } = await subscribers();
    return c.json({ count: list.length, unsubscribed, subscribers: list });
  })
  .post("/optouts", requirePermission("newsletter.manage"), async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ email: z.string().trim().toLowerCase().email().max(200), unsubscribed: z.boolean().default(true) }));
    if (p.unsubscribed) await unsubscribe(p.email, "staff");
    else await resubscribe(p.email);
    await audit(a.user.id, p.unsubscribed ? "newsletter.unsubscribed" : "newsletter.resubscribed", mask(p.email), { via: a.apiKey ? a.apiKey.name : "staff" });
    return c.json({ ok: true });
  })

  /** Every contact, subscribed or not (the team's tab) */
  .get("/contacts", requirePermission("newsletter.view"), async (c) => {
    if (!config.publicUrl) throw new HTTPException(409, { message: "public_url_missing" });
    return c.json(await contactsList());
  })

  /** The newsletters sent: recorded by the sending tool (Grok...) through the API */
  .get("/issues", requirePermission("newsletter.view"), async (c) => {
    const email = (c.req.query("email") ?? "").trim().toLowerCase();
    const rows = await db().select().from(schema.newsletterIssues).orderBy(desc(schema.newsletterIssues.sentAt));
    return c.json(
      rows
        .filter((r) => !email || r.recipients.some((x) => x.toLowerCase() === email))
        .map(({ body: _b, recipients, ...r }) => ({ ...r, recipientsListed: recipients.length })),
    );
  })
  .get("/issues/:id", requirePermission("newsletter.view"), async (c) => {
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HTTPException(404, { message: "not_found" });
    const [r] = await db().select().from(schema.newsletterIssues).where(eq(schema.newsletterIssues.id, id));
    if (!r) throw new HTTPException(404, { message: "not_found" });
    return c.json(r);
  })
  .post("/issues", requirePermission("newsletter.log"), async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        subject: z.string().trim().min(1).max(300),
        body: z.string().max(150_000).default(""),
        sentAt: z.string().datetime({ offset: true }).optional(),
        recipients: z.array(z.string().trim().toLowerCase().email().max(200)).max(3000).default([]),
        recipientCount: z.number().int().min(0).max(1_000_000).optional(),
      }),
    );
    const [row] = await db()
      .insert(schema.newsletterIssues)
      .values({ subject: p.subject, body: p.body, sentAt: p.sentAt ? new Date(p.sentAt) : new Date(), recipients: [...new Set(p.recipients)], recipientCount: p.recipientCount ?? p.recipients.length, recordedBy: a.apiKey ? a.apiKey.name : a.user.name })
      .returning({ id: schema.newsletterIssues.id });
    await audit(a.user.id, "newsletter.issue_recorded", row.id, { subject: p.subject, via: a.apiKey ? a.apiKey.name : "staff" });
    return c.json({ id: row.id }, 201);
  });
