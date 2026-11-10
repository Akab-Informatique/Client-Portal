import { Hono } from "hono";
import { config } from "../config.ts";
import { requireStaff, type AppEnv } from "../lib/auth.ts";
import { openApiSpec } from "../lib/openapi.ts";

/** GET /api/openapi.json: what an outside tool (Grok…) may call with an API key. Any signed-in staff or key. */
export const openApiRoutes = new Hono<AppEnv>().use(requireStaff).get("/", (c) => {
  const origin = config.publicUrl ? new URL(config.publicUrl).origin : new URL(c.req.url).origin;
  return c.json(openApiSpec(origin));
});
