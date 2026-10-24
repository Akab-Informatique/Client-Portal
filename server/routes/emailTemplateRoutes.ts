import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { sendMail } from "../lib/mail.ts";
import { render, TEMPLATES, templateDef, templateText, type Locale, type TemplateDef } from "../lib/emailTemplates.ts";
import { rateLimit } from "../lib/http.ts";
import { body } from "../lib/validate.ts";

const zLocale = z.enum(["fr", "en"]);
const zTemplateText = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10_000),
  action: z.string().trim().max(80).default(""),
});

/**
 * The email template routes (list, read, save, restore, preview, test). Admin › Email gets them all; Admin › Facturation
 * gets only the invoicing ones (`allowed`), under its own right.
 */
export function templateRoutes(allowed: (key: string) => boolean = () => true) {
  const getDef = (key: string): TemplateDef => {
    const def = templateDef(key);
    if (!def || !allowed(def.key)) throw new HTTPException(404, { message: "not_found" });
    return def;
  };
  const list = TEMPLATES.filter((t) => allowed(t.key));
  return new Hono<AppEnv>()
  .get("/templates", async (c) => {
    const edited = await db().select({ key: schema.emailTemplates.key, locale: schema.emailTemplates.locale }).from(schema.emailTemplates);
    return c.json(
      list.map((t) => ({
        key: t.key,
        variables: t.variables,
        edited: { fr: edited.some((e) => e.key === t.key && e.locale === "fr"), en: edited.some((e) => e.key === t.key && e.locale === "en") },
      })),
    );
  })

  .get("/templates/:key", async (c) => {
    const def = getDef(c.req.param("key"));
    const edited = await db().select().from(schema.emailTemplates).where(eq(schema.emailTemplates.key, def.key));
    const out = {} as Record<Locale, { current: { subject: string; body: string; action: string }; default: typeof def.defaults.fr; edited: boolean }>;
    for (const l of ["fr", "en"] as const) {
      out[l] = { current: await templateText(def.key, l), default: def.defaults[l], edited: edited.some((e) => e.locale === l) };
    }
    return c.json({ key: def.key, variables: def.variables, hasButton: Boolean(def.linkVar), locales: out });
  })

  .put("/templates/:key/:locale", async (c) => {
    const a = auth(c);
    const def = getDef(c.req.param("key"));
    const locale = zLocale.parse(c.req.param("locale"));
    const p = await body(c, zTemplateText);
    const values = { subject: p.subject, body: p.body, action: p.action, updatedBy: a.user.id, updatedAt: new Date() };
    await db()
      .insert(schema.emailTemplates)
      .values({ key: def.key, locale, ...values })
      .onConflictDoUpdate({ target: [schema.emailTemplates.key, schema.emailTemplates.locale], set: values });
    await audit(a.user.id, "email.template.updated", def.key, { locale });
    return c.json({ ok: true });
  })

  /** Restore the default text. */
  .delete("/templates/:key/:locale", async (c) => {
    const def = getDef(c.req.param("key"));
    const locale = zLocale.parse(c.req.param("locale"));
    await db().delete(schema.emailTemplates).where(and(eq(schema.emailTemplates.key, def.key), eq(schema.emailTemplates.locale, locale)));
    await audit(auth(c).user.id, "email.template.reset", def.key, { locale });
    return c.json({ ok: true });
  })

  /** Render the (unsaved) text with sample values. */
  .post("/templates/:key/:locale/preview", async (c) => {
    const def = getDef(c.req.param("key"));
    const locale = zLocale.parse(c.req.param("locale"));
    const p = await body(c, zTemplateText);
    const r = render(def, locale, p, def.sample[locale]);
    return c.json({ subject: r.subject, html: r.html });
  })

  /** Send the (unsaved) text, with sample values, to the signed-in admin. */
  .post("/templates/:key/:locale/test", async (c) => {
    const a = auth(c);
    if (!rateLimit(`smtp-test:${a.user.id}`, 10, 15 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const def = getDef(c.req.param("key"));
    const locale = zLocale.parse(c.req.param("locale"));
    const p = await body(c, zTemplateText);
    const r = render(def, locale, p, def.sample[locale]);
    const ok = await sendMail({ to: a.user.email, subject: `[TEST] ${r.subject}`, text: r.text, html: r.html });
    return c.json(ok ? { ok: true, to: a.user.email } : { ok: false, error: "send" });
  });
}
