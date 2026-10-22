import { passboltMenuShown } from "../lib/passbolt.ts";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requireAuth, type AppEnv, type AuthContext } from "../lib/auth.ts";
import { body, zName, zOptText, zPhone } from "../lib/validate.ts";
import { o365Ready } from "../lib/o365.ts";
import { SYSTEM_ROLES } from "../../shared/permissions.ts";

export type Me = Awaited<ReturnType<typeof loadMe>>;

export async function loadMe(a: AuthContext) {
  const u = a.user;
  const d = db();
  const [role] = u.roleId ? await d.select().from(schema.roles).where(eq(schema.roles.id, u.roleId)) : [];
  const [client] = u.clientId ? await d.select().from(schema.clients).where(eq(schema.clients.id, u.clientId)) : [];
  const [prefs] = await d.select().from(schema.userPreferences).where(eq(schema.userPreferences.userId, u.id));
  const sys = role?.slug ? SYSTEM_ROLES.find((r) => r.slug === role.slug) : undefined;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    kind: u.kind,
    title: u.title,
    phone: u.phone,
    mobile: u.mobile,
    /** Outlook calendar: allowed by an admin, and the integration on */
    o365: a.permissions.includes("tickets.o365") ? { mailbox: u.o365Email ?? u.email, active: u.kind === "staff" && (await o365Ready()) } : null,
    locale: u.locale,
    notifyEmail: u.notifyEmail,
    mfaEnabled: u.mfaEnabled,
    role: role ? { id: role.id, slug: role.slug, name: role.name, nameEn: sys?.name.en ?? role.name } : null,
    client: client ? { id: client.id, name: client.name } : null,
    permissions: a.permissions,
    isAdmin: a.isAdmin,
    /** Set while a technician views the portal as a client (read only). */
    viewAs: a.viewAs,
    realUser: a.viewAs ? { name: a.realUser.name, email: a.realUser.email } : null,
    /** Parts switched on for this server (Sécurité › Passbolt is off in production unless set) */
    features: { passbolt: await passboltMenuShown() },
    /** Fills in a weekly timesheet (otherwise the Timesheets entry is hidden, unless they manage everyone's) */
    timesheetRequired: u.timesheetRequired,
    preferences: { dashboard: prefs?.dashboard ?? null, theme: prefs?.theme ?? "dark", outlook: prefs?.outlook ?? false, bankHours: prefs?.bankHoursDefault ?? false, notify: prefs?.notifyDefaults ?? { email: true, sms: false, teams: false } },
  };
}

const widget = z.object({
  id: z.string().min(1).max(60),
  type: z.string().min(1).max(60),
  size: z.enum(["sm", "md", "lg"]),
});

export const meRoutes = new Hono<AppEnv>()
  .use(requireAuth)
  .get("/", async (c) => c.json(await loadMe(auth(c))))

  .patch("/", async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        name: zName.optional(),
        title: zOptText(120),
        phone: zOptText(40),
        mobile: zPhone,
        locale: z.enum(["fr", "en"]).optional(),
        notifyEmail: z.boolean().optional(),
      }),
    );
    await db()
      .update(schema.users)
      .set({ ...p, updatedAt: new Date() })
      .where(eq(schema.users.id, a.user.id));
    return c.json({ ok: true });
  })

  .put("/preferences", async (c) => {
    const a = auth(c);
    const p = await body(
      c,
      z.object({
        dashboard: z.array(widget).max(40).nullable().optional(),
        theme: z.enum(["dark", "light", "system"]).optional(),
        outlook: z.boolean().optional(),
        /** Hours worked are banked by default */
        bankHours: z.boolean().optional(),
        /** Channels ticked by default when notifying a technician */
        notify: z.object({ email: z.boolean(), sms: z.boolean(), teams: z.boolean() }).optional(),
      }),
    );
    if (p.outlook && !a.permissions.includes("outlook.view")) throw new HTTPException(403, { message: "forbidden" });
    await db()
      .insert(schema.userPreferences)
      .values({ userId: a.user.id, dashboard: p.dashboard ?? null, theme: p.theme ?? null, outlook: p.outlook ?? false, bankHoursDefault: p.bankHours ?? false, ...(p.notify ? { notifyDefaults: p.notify } : {}) })
      .onConflictDoUpdate({
        target: schema.userPreferences.userId,
        set: {
          ...(p.dashboard !== undefined ? { dashboard: p.dashboard } : {}),
          ...(p.theme !== undefined ? { theme: p.theme } : {}),
          ...(p.outlook !== undefined ? { outlook: p.outlook } : {}),
          ...(p.bankHours !== undefined ? { bankHoursDefault: p.bankHours } : {}),
          ...(p.notify !== undefined ? { notifyDefaults: p.notify } : {}),
          updatedAt: new Date(),
        },
      });
    return c.json({ ok: true });
  });
