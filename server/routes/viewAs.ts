import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.ts";
import { isFullySignedIn, permissionsOf, type AppEnv, type AuthContext } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { body, zUuid } from "../lib/validate.ts";

/** The signed-in technician (not the client being viewed) must hold clientview.use. */
async function realTechnician(c: Context<AppEnv>): Promise<AuthContext> {
  const a = c.var.auth;
  if (!isFullySignedIn(a)) throw new HTTPException(401, { message: "Authentication required" });
  if (a.realUser.kind !== "staff") throw new HTTPException(403, { message: "Forbidden" });
  const perms = a.viewAs ? await permissionsOf(a.realUser) : a.permissions;
  if (!perms.includes("clientview.use")) throw new HTTPException(403, { message: "Forbidden" });
  return a;
}

export const viewAsRoutes = new Hono<AppEnv>()
  /** Active clients the technician can view as. */
  .get("/clients", async (c) => {
    await realTechnician(c);
    const rows = await db()
      .select({ id: schema.clients.id, name: schema.clients.name, code: schema.clients.code })
      .from(schema.clients)
      .where(eq(schema.clients.active, true))
      .orderBy(asc(schema.clients.name));
    return c.json(rows);
  })

  /** Start (or switch) the client view for this session. */
  .post("/", async (c) => {
    const a = await realTechnician(c);
    const { clientId } = await body(c, z.object({ clientId: zUuid }));
    const [client] = await db()
      .select()
      .from(schema.clients)
      .where(and(eq(schema.clients.id, clientId), eq(schema.clients.active, true)));
    if (!client) throw new HTTPException(400, { message: "invalid_client" });
    await db().update(schema.sessions).set({ viewAsClientId: client.id }).where(eq(schema.sessions.id, a.sessionId));
    await audit(a.realUser.id, "clientview.start", client.id, { client: client.name });
    return c.json({ ok: true, client: { id: client.id, name: client.name } });
  })

  /** Back to the technician view. */
  .delete("/", async (c) => {
    const a = c.var.auth;
    if (!a) throw new HTTPException(401, { message: "Authentication required" });
    if (a.viewAs) {
      await db().update(schema.sessions).set({ viewAsClientId: null }).where(eq(schema.sessions.id, a.sessionId));
      await audit(a.realUser.id, "clientview.stop", a.viewAs.clientId, { client: a.viewAs.clientName });
    }
    return c.json({ ok: true });
  });
