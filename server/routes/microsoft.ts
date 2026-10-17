import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { config } from "../config.ts";
import { db, schema } from "../db/index.ts";
import { auth, isFullySignedIn, requireStaff, type AppEnv } from "../lib/auth.ts";
import { audit } from "../lib/audit.ts";
import { rateLimit } from "../lib/http.ts";
import { O365Error, o365Ready } from "../lib/o365.ts";
import { completeSignIn, linkOwnMailbox, redirectUriFor, signInUrl, signOutMicrosoft } from "../lib/msauth.ts";

/** The address Microsoft sends people back to (shown to the admin, registered in Entra). */
export function microsoftRedirectUri(origin?: string | null): string | null {
  const base = config.publicUrl || origin || "";
  return base ? redirectUriFor(base) : null;
}

/**
 * A technician's own Microsoft 365 sign-in (profile › Microsoft 365): linked
 * by themselves, used for their mailbox in Outlook and their calendar.
 */
export const microsoftRoutes = new Hono<AppEnv>()
  /**
   * Back from Microsoft (a browser redirect, so a GET): only for the person
   * who started it, in this same portal session. Then back to the portal.
   */
  .get("/callback", async (c) => {
    const back = (q: string) => c.redirect(`/?microsoft=${q}`, 302);
    const a = c.var.auth;
    if (!isFullySignedIn(a) || a.realUser.kind !== "staff") return back("signin");
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    // refused on Microsoft's side (cancelled, consent missing…)
    if (c.req.query("error") || !state || !code) return back(c.req.query("error") === "access_denied" ? "cancelled" : "error");
    try {
      const r = await completeSignIn(a.realUser.id, state.slice(0, 200), code.slice(0, 4000));
      if (a.permissions.includes("outlook.view")) {
        await linkOwnMailbox(a.realUser.id, r);
        await audit(a.realUser.id, "outlook.linked", a.realUser.id, { address: r.email, via: "user" });
      }
      await audit(a.realUser.id, "microsoft.connected", a.realUser.id, { email: r.email });
      return back("connected");
    } catch (e) {
      console.warn("[microsoft] sign-in:", e instanceof O365Error ? e.code : e instanceof Error ? e.message : e);
      return back("error");
    }
  })

  .use(requireStaff)
  .get("/", async (c) => {
    const a = auth(c);
    const [conn] = await db().select().from(schema.msConnections).where(eq(schema.msConnections.userId, a.realUser.id));
    return c.json({
      available: await o365Ready(),
      connection: conn ? { email: conn.email, displayName: conn.displayName, connectedAt: conn.connectedAt, needsReconnect: conn.lastError === "reconnect" } : null,
    });
  })
  /** Start: the Microsoft sign-in address to open. */
  .post("/connect", async (c) => {
    const a = auth(c);
    if (!rateLimit(`ms-connect:${a.realUser.id}`, 10, 60_000).ok) throw new HTTPException(429, { message: "rate_limited" });
    const redirectUri = microsoftRedirectUri(c.req.header("origin"));
    if (!redirectUri) throw new HTTPException(409, { message: "microsoft_no_public_url" });
    try {
      return c.json({ url: await signInUrl(a.realUser.id, redirectUri, a.realUser.o365Email ?? a.realUser.email) });
    } catch (e) {
      if (e instanceof O365Error && e.code === "not_configured") throw new HTTPException(409, { message: "microsoft_not_configured" });
      throw e;
    }
  })
  .delete("/", async (c) => {
    const a = auth(c);
    await signOutMicrosoft(a.realUser.id);
    await audit(a.realUser.id, "microsoft.disconnected", a.realUser.id);
    return c.json({ ok: true });
  });
