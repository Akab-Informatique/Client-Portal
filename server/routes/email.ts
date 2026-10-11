import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { clearSmtpSettings, createTransport, saveSmtpSettings, sendMail, smtpSettings, type SmtpSettings } from "../lib/mail.ts";
import { render, TEMPLATES, templateDef, templateText, type Locale, type TemplateDef } from "../lib/emailTemplates.ts";
import { rateLimit } from "../lib/http.ts";
import { body, zEmail } from "../lib/validate.ts";

const zLocale = z.enum(["fr", "en"]);
const zTemplateText = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10_000),
  action: z.string().trim().max(80).default(""),
});

function smtpView(s: SmtpSettings) {
  // The password never leaves the server
  return {
    source: s.source,
    host: s.host,
    port: s.port,
    security: s.security,
    user: s.user,
    hasPassword: Boolean(s.pass),
    from: s.from,
    fromName: s.fromName,
  };
}

function getDef(key: string): TemplateDef {
  const def = templateDef(key);
  if (!def) throw new HTTPException(404, { message: "not_found" });
  return def;
}

/** Admin › Email (admin.email): mail server and templates. */
export const emailRoutes = new Hono<AppEnv>()
  .use(requirePermission("admin.email"))

  .get("/smtp", async (c) => c.json(smtpView(await smtpSettings())))

  .put("/smtp", async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        host: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .regex(/^[A-Za-z0-9.-]+$/),
        port: z.number().int().min(1).max(65535),
        security: z.enum(["starttls", "tls", "none"]),
        user: z.string().trim().max(255).default(""),
        pass: z.string().max(500).optional(),
        from: zEmail,
        fromName: z.string().trim().min(1).max(120),
      }),
    );
    await saveSmtpSettings(a.user.id, p);
    await audit(a.user.id, "email.smtp.updated", null, {
      host: p.host,
      port: p.port,
      security: p.security,
      user: p.user,
      from: p.from,
      passwordChanged: p.pass !== undefined || undefined,
    });
    return c.json(smtpView(await smtpSettings()));
  })

  /** Back to the SMTP_* values of .env */
  .delete("/smtp", async (c) => {
    await clearSmtpSettings();
    await audit(auth(c).user.id, "email.smtp.cleared");
    return c.json(smtpView(await smtpSettings()));
  })

  /** Check the server connection and send a test email to the signed-in admin. */
  .post("/smtp/test", async (c) => {
    const a = auth(c);
    if (!rateLimit(`smtp-test:${a.user.id}`, 10, 15 * 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const s = await smtpSettings();
    if (s.source === "none") return c.json({ ok: false, error: "not_configured" });
    try {
      const t = createTransport(s);
      await t.verify();
      t.close();
    } catch (e) {
      return c.json({ ok: false, error: "connection", detail: e instanceof Error ? e.message.slice(0, 200) : "" });
    }
    const fr = a.user.locale !== "en";
    const ok = await sendMail({
      to: a.user.email,
      subject: fr ? "Test d'envoi — Portail AKAB" : "Test email — AKAB Portal",
      text: fr ? "Ce courriel confirme que l'envoi fonctionne." : "This email confirms that sending works.",
      html: `<p style="font-family:Arial,sans-serif">${fr ? "Ce courriel confirme que l'envoi fonctionne." : "This email confirms that sending works."}</p>`,
    });
    return c.json(ok ? { ok: true, to: a.user.email } : { ok: false, error: "send" });
  })

  .get("/templates", async (c) => {
    const edited = await db().select({ key: schema.emailTemplates.key, locale: schema.emailTemplates.locale }).from(schema.emailTemplates);
    return c.json(
      TEMPLATES.map((t) => ({
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
