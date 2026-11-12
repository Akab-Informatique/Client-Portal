import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { auth, requireAuth, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { rateLimit } from "../lib/http.ts";
import { canEnter, companiesOf } from "../lib/clientGrants.ts";
import { body, zUuid } from "../lib/validate.ts";

/** A client user signed in as themselves (not a technician viewing the portal, not an API key). */
const clientOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  const a = auth(c);
  if (a.realUser.kind !== "client" || !a.realUser.clientId || a.apiKey) throw new HTTPException(403, { message: "forbidden" });
  await next();
};

/**
 * Switching company (a client user with a grant on another company of their chain). `active` is the company
 * the session works as now (the home company when not switched).
 */
export const portalCompanyRoutes = new Hono<AppEnv>()
  .get("/companies", requireAuth, clientOnly, async (c) => {
    const a = auth(c);
    return c.json({ active: a.user.clientId, companies: await companiesOf(a.realUser) });
  })

  .put("/active-company", requireAuth, clientOnly, async (c) => {
    const a = auth(c);
    const p = await body(c, z.object({ clientId: zUuid.nullable() }));
    if (!rateLimit(`portal-company:${a.realUser.id}`, 30, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const home = a.realUser.clientId!;
    const to = p.clientId ?? home;
    if (!(await canEnter(a.realUser, to))) throw new HTTPException(403, { message: "forbidden" });
    const from = a.user.clientId;
    await db()
      .update(schema.sessions)
      .set({ activeClientId: to === home ? null : to })
      .where(eq(schema.sessions.id, a.sessionId));
    await audit(a.realUser.id, "portal.company_switched", a.realUser.id, { from, to });
    return c.json({ active: to, companies: await companiesOf(a.realUser) });
  });
