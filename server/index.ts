import { serve } from "@hono/node-server";
import { config } from "./config.ts";
import { initDb, closeDb } from "./db/index.ts";
import { seed } from "./db/seed.ts";
import { createApp } from "./app.ts";
import { purgeExpiredSessions } from "./lib/auth.ts";
import { purgeOldNotifications } from "./lib/notify.ts";
import { smtpSettings } from "./lib/mail.ts";
import { CRM_SYNC_EVERY, syncCrm } from "./lib/crm.ts";
import { quickbooksTick } from "./lib/quickbooks.ts";
import { syncBillables } from "./lib/billables.ts";
import { sweepTimers } from "./lib/timers.ts";
import { sendReminders } from "./lib/planning.ts";
import { autoTickets } from "./lib/sms.ts";
import { runIntake } from "./lib/mailIntake.ts";
import { workflowTick } from "./lib/workflows.ts";
import { pipelineTick } from "./lib/pipeline.ts";

await initDb();
await seed();

const app = createApp();
const smtp = await smtpSettings();
const host = process.env.HOST || (config.production ? "0.0.0.0" : "127.0.0.1");

// CRM and the work to bill (time, charges, expenses, contracts, milestones)
const syncAll = () =>
  syncCrm()
    .then(() => syncBillables())
    .catch((e) => console.warn("[billing] work to bill not copied:", e instanceof Error ? e.message : e));
void syncAll();
setInterval(() => void syncAll(), CRM_SYNC_EVERY).unref();
// QuickBooks: payments made there brought onto the portal's invoices
setInterval(() => void quickbooksTick(), 15 * 60_000).unref();


const server = serve({ fetch: app.fetch, port: config.port, hostname: host }, (info) => {
  console.log(`AKAB Portal API on http://${info.address}:${info.port}`);
  console.log(`  database : ${config.db.kind}${config.db.kind === "pglite" ? ` (${config.db.pgliteDir})` : ""}`);
  console.log(`  email    : ${smtp.source === "none" ? (config.production ? "not configured" : "not configured (printed to console)") : `SMTP ${smtp.host} (${smtp.source})`}`);
  console.log(`  MFA      : ${config.requireMfa ? "required" : "optional"}`);
  if (config.production && !config.publicUrl) console.error("  ERROR: PUBLIC_URL is not set — password and welcome emails are not sent (set it to https://your-portal)");
  if (config.production && config.publicUrl && !config.publicUrl.startsWith("https://")) console.warn("  WARN: PUBLIC_URL should start with https://");
  if (config.production && !config.requireMfa) console.warn("  WARN: REQUIRE_MFA is off in production");
  if (config.production && !config.cookieSecure) console.warn("  WARN: COOKIE_SECURE is off in production (session cookie sent over plain HTTP)");
  if (config.production && !config.trustedProxies.length) console.warn("  WARN: TRUSTED_PROXY_IPS is not set — behind Nginx Proxy Manager every visitor shares its IP (rate limits, audit)");
});

// Texts with no technician reply in time become tickets
setInterval(() => void autoTickets().catch((e) => console.warn("[sms] auto tickets:", e instanceof Error ? e.message : e)), 60_000).unref();

// Emails to the support mailbox become tickets (switched on in Admin › Courriel entrant)
setInterval(() => void runIntake().catch((e) => console.warn("[mail-intake] pass:", e instanceof Error ? e.message : e)), 60_000).unref();

// Automatic workflows (switched on in Admin › Flux de travail): the new tickets get their reply
setInterval(() => void workflowTick().catch((e) => console.warn("[workflow] tick:", e instanceof Error ? e.message : e)), 60_000).unref();
// Pipeline: each morning (at the chosen time, work days) everyone's day is planned and texted
setInterval(() => void pipelineTick().catch((e) => console.warn("[pipeline] tick:", e instanceof Error ? e.message : e)), 60_000).unref();

// Alerts before calendar events
setInterval(() => void sendReminders().catch((e) => console.warn("[planning] reminders:", e instanceof Error ? e.message : e)), 60_000).unref();

// Timers whose page was closed become entries to validate
setInterval(() => void sweepTimers().catch(() => undefined), 30_000).unref();

setInterval(() => {
  void purgeExpiredSessions().catch(() => undefined);
  void purgeOldNotifications().catch(() => undefined);
}, 60 * 60_000).unref();

// Docker stops the container with SIGTERM: stop taking requests, let the ones in progress end, close the database
let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    console.log(`[server] ${sig}: stopping`);
    const force = setTimeout(() => process.exit(0), 8000);
    force.unref();
    server.close(() => {
      void closeDb().finally(() => process.exit(0));
    });
  });
}
