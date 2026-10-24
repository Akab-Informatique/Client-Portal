import { Hono } from "hono";
import { z } from "zod";
import { auth, requirePermission, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { BILLING_TEMPLATE_KEYS, REMINDER_LEVELS } from "../lib/emailTemplates.ts";
import { invoiceSender, mailSettings, saveMailSettings } from "../lib/invoiceMail.ts";
import { body, zEmail } from "../lib/validate.ts";
import { templateRoutes } from "./emailTemplateRoutes.ts";

/** Admin › Facturation › Courriels (admin.billing): the invoicing email templates and when they go out. */
export const billingMailRoutes = new Hono<AppEnv>()
  .use(requirePermission("admin.billing"))
  .get("/settings", async (c) => {
    const { lastRun, ...s } = await mailSettings();
    return c.json({ ...s, lastRun, levelsAvailable: REMINDER_LEVELS });
  })
  .put("/settings", async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        autoSend: z.boolean().optional(),
        remindersAuto: z.boolean().optional(),
        levels: z.array(z.number().int()).max(10).optional(),
        remindersFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        fromEmail: zEmail.optional(),
        fromName: z.string().trim().max(80).nullable().optional(),
      }),
    );
    const levels = p.levels?.filter((n) => (REMINDER_LEVELS as readonly number[]).includes(n));
    const next = await saveMailSettings({ ...(p.autoSend !== undefined ? { autoSend: p.autoSend } : {}), ...(p.remindersAuto !== undefined ? { remindersAuto: p.remindersAuto } : {}), ...(levels ? { levels } : {}), ...(p.remindersFrom !== undefined ? { remindersFrom: p.remindersFrom } : {}), ...(p.fromEmail ? { fromEmail: p.fromEmail } : {}), ...(p.fromName !== undefined ? { fromName: p.fromName || null } : {}) });
    await audit(a.user.id, "billing.mail_settings", null, { autoSend: next.autoSend, remindersAuto: next.remindersAuto, levels: next.levels, remindersFrom: next.remindersFrom });
    return c.json({ ...next, levelsAvailable: REMINDER_LEVELS });
  })
  .route("/", templateRoutes((key) => (BILLING_TEMPLATE_KEYS as string[]).includes(key), invoiceSender));
