import { Hono } from "hono";
import { config } from "../config.ts";
import { rateLimit, clientIp } from "../lib/http.ts";
import { checkoutFor, invoiceOfToken } from "../lib/payLink.ts";
import type { AppEnv } from "../lib/auth.ts";

/** The "Pay online" link of an invoice email: public, signed, sends the client to a Stripe page for what is left to pay. */
export const payRoutes = new Hono<AppEnv>().get("/:token", async (c) => {
  const back = (cancelled: boolean) => c.redirect(`${config.publicUrl || ""}/paiement-recu${cancelled ? "?annule=1" : ""}`);
  if (!rateLimit(`pay-link:${clientIp(c)}`, 30, 10 * 60_000).ok) return back(true);
  const id = invoiceOfToken(c.req.param("token"));
  if (!id) return back(true);
  try {
    const url = await checkoutFor(id);
    // nothing left to pay: the page that says so
    return url ? c.redirect(url) : back(false);
  } catch {
    return back(true);
  }
});
