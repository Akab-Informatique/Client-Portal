import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { auth, requirePermission, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { clearSmtpSettings, createTransport, saveSmtpSettings, sendMail, smtpSettings, type SmtpSettings } from "../lib/mail.ts";
import { templateRoutes } from "./emailTemplateRoutes.ts";
import { rateLimit } from "../lib/http.ts";
import { body, zEmail } from "../lib/validate.ts";

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

  .route("/", templateRoutes());
