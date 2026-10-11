import { serve } from "@hono/node-server";
import { config } from "./config.ts";
import { initDb } from "./db/index.ts";
import { seed } from "./db/seed.ts";
import { createApp } from "./app.ts";
import { purgeExpiredSessions } from "./lib/auth.ts";
import { purgeOldNotifications } from "./lib/notify.ts";
import { mailConfigured } from "./lib/mail.ts";

await initDb();
await seed();

const app = createApp();
const host = process.env.HOST || (config.production ? "0.0.0.0" : "127.0.0.1");
serve({ fetch: app.fetch, port: config.port, hostname: host }, (info) => {
  console.log(`AKAB Portal API on http://${info.address}:${info.port}`);
  console.log(`  database : ${config.db.kind}${config.db.kind === "pglite" ? ` (${config.db.pgliteDir})` : ""}`);
  console.log(`  email    : ${mailConfigured() ? `SMTP ${config.smtp.host}` : "not configured (printed to console)"}`);
  console.log(`  MFA      : ${config.requireMfa ? "required" : "optional"}`);
  if (config.production && !config.publicUrl) console.warn("  WARN: PUBLIC_URL is not set — email links are omitted");
});

setInterval(() => {
  void purgeExpiredSessions().catch(() => undefined);
  void purgeOldNotifications().catch(() => undefined);
}, 60 * 60_000).unref();
