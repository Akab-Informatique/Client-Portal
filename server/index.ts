import { serve } from "@hono/node-server";
import { config } from "./config.ts";
import { initDb } from "./db/index.ts";
import { seed } from "./db/seed.ts";
import { createApp } from "./app.ts";
import { purgeExpiredSessions } from "./lib/auth.ts";
import { purgeOldNotifications } from "./lib/notify.ts";
import { smtpSettings } from "./lib/mail.ts";
import { keepTicketsWarm } from "./lib/ticketSource.ts";
import { CRM_SYNC_EVERY, syncCrm } from "./lib/crm.ts";
import { sweepTimers } from "./lib/timers.ts";
import { sendReminders } from "./lib/planning.ts";
import { autoTickets } from "./lib/sms.ts";

await initDb();
await seed();

const app = createApp();
const smtp = await smtpSettings();
const host = process.env.HOST || (config.production ? "0.0.0.0" : "127.0.0.1");
// Autotask: load the ticket list now and keep it fresh while the portal is used
keepTicketsWarm();

// CRM: the portal keeps its own copy of the clients, contacts and contracts (Autotask is the reference while linked)
void syncCrm();
setInterval(() => void syncCrm(), CRM_SYNC_EVERY).unref();

// CRM: the portal keeps its own copy of the clients, contacts and contracts (Autotask is the reference while linked)
void syncCrm();
setInterval(() => void syncCrm(), CRM_SYNC_EVERY).unref();

serve({ fetch: app.fetch, port: config.port, hostname: host }, (info) => {
  console.log(`AKAB Portal API on http://${info.address}:${info.port}`);
  console.log(`  database : ${config.db.kind}${config.db.kind === "pglite" ? ` (${config.db.pgliteDir})` : ""}`);
  console.log(`  email    : ${smtp.source === "none" ? (config.production ? "not configured" : "not configured (printed to console)") : `SMTP ${smtp.host} (${smtp.source})`}`);
  console.log(`  MFA      : ${config.requireMfa ? "required" : "optional"}`);
  if (config.production && !config.publicUrl) console.warn("  WARN: PUBLIC_URL is not set — email links use the request address");
});

// Texts with no technician reply in time become tickets
setInterval(() => void autoTickets().catch((e) => console.warn("[sms] auto tickets:", e instanceof Error ? e.message : e)), 60_000).unref();

// Alerts before calendar events
setInterval(() => void sendReminders().catch((e) => console.warn("[planning] reminders:", e instanceof Error ? e.message : e)), 60_000).unref();

// Timers whose page was closed become entries to validate
setInterval(() => void sweepTimers().catch(() => undefined), 30_000).unref();

setInterval(() => {
  void purgeExpiredSessions().catch(() => undefined);
  void purgeOldNotifications().catch(() => undefined);
}, 60 * 60_000).unref();
