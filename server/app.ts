import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { serveStatic } from "@hono/node-server/serve-static";
import { config } from "./config.ts";
import { loadAuth, readOnlyViewAs, requireStaff, type AppEnv } from "./lib/auth.ts";
import { sameOriginJson } from "./lib/http.ts";
import { authRoutes } from "./routes/auth.ts";
import { meRoutes } from "./routes/me.ts";
import { adminRoutes } from "./routes/admin.ts";
import { integrationRoutes } from "./routes/integrations.ts";
import { workflowRoutes } from "./routes/workflows.ts";
import { queueRoutes } from "./routes/queues.ts";
import { contractTypeRoutes } from "./routes/contractTypes.ts";
import { vendorRoutes } from "./routes/vendors.ts";
import { serviceRoutes } from "./routes/services.ts";
import { classRoutes } from "./routes/classes.ts";
import { ticketSetupRoutes } from "./routes/ticketSetup.ts";
import { mailIntakeAdminRoutes, mailIntakeRoutes } from "./routes/mailIntake.ts";
import { emailRoutes } from "./routes/email.ts";
import { boardRoutes, messageRoutes } from "./routes/messages.ts";
import { dashboardRoutes } from "./routes/dashboard.ts";
import { dashboardsRoutes } from "./routes/dashboards.ts";
import { viewAsRoutes } from "./routes/viewAs.ts";
import { notificationRoutes } from "./routes/notifications.ts";
import { ticketRoutes } from "./routes/tickets.ts";
import { storeRoutes } from "./routes/store.ts";
import { pipelineRoutes } from "./routes/pipeline.ts";
import { planningRoutes } from "./routes/planning.ts";
import { smsHookRoutes, smsRoutes } from "./routes/sms.ts";
import { outlookRoutes } from "./routes/outlook.ts";
import { portalRoutes } from "./routes/portal.ts";
import { microsoftRoutes } from "./routes/microsoft.ts";
import { meetingRoutes } from "./routes/meetings.ts";
import { breakroomRoutes } from "./routes/breakroom.ts";
import { crmRoutes } from "./routes/crm.ts";
import { billingRoutes, stripeHookRoutes } from "./routes/billing.ts";
import { billablesRoutes } from "./routes/billables.ts";
import { timeRoutes } from "./routes/time.ts";

export function createApp() {
  const app = new Hono<AppEnv>();
  // gzip/deflate responses (JSON lists, HTML, JS) when the browser accepts it
  app.use("*", compress());

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https://i.ytimg.com"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        // the coffee break videos (youtube-nocookie: no tracking cookie until played)
        frameSrc: ["https://www.youtube-nocookie.com"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
      },
      strictTransportSecurity: config.production ? "max-age=31536000; includeSubDomains" : false,
      referrerPolicy: "strict-origin-when-cross-origin",
      crossOriginEmbedderPolicy: false,
    }),
  );

  const api = new Hono<AppEnv>();
  // Small JSON everywhere; Outlook sends and ticket attachments carry files
  const smallBody = bodyLimit({ maxSize: 256 * 1024 });
  const mailBody = bodyLimit({ maxSize: 7 * 1024 * 1024 });
  api.use("*", (c, next) => (c.req.path.startsWith("/api/outlook/") || c.req.path.startsWith("/api/time/expenses") || /^\/api\/(tickets|portal\/tickets)\/\d+\/attachments$/.test(c.req.path) || /^\/api\/pipeline\/tasks\/[0-9a-f-]{36}\/files$/.test(c.req.path) ? mailBody(c, next) : smallBody(c, next)));
  api.use("*", sameOriginJson);
  api.use("*", loadAuth);
  api.use("*", readOnlyViewAs);
  api.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  api.get("/health", (c) => c.json({ ok: true }));
  api.route("/auth", authRoutes);
  api.route("/me", meRoutes);
  api.route("/view-as", viewAsRoutes);
  api.route("/notifications", notificationRoutes);
  api.use("/admin/*", requireStaff);
  api.route("/admin/integrations", integrationRoutes);
  api.route("/admin/email", emailRoutes);
  api.route("/admin/workflows", workflowRoutes);
  api.route("/admin/queues", queueRoutes);
  api.route("/admin/contract-types", contractTypeRoutes);
  api.route("/admin/vendors", vendorRoutes);
  api.route("/admin/client-classes", classRoutes);
  api.route("/admin/ticket-setup", ticketSetupRoutes);
  api.route("/admin/mail-intake", mailIntakeAdminRoutes);
  api.route("/mail-intake", mailIntakeRoutes);
  api.route("/admin", adminRoutes);
  api.use("/messages/*", requireStaff);
  api.route("/store", storeRoutes);
  api.route("/pipeline", pipelineRoutes);
  api.route("/services", serviceRoutes);
  api.route("/planning", planningRoutes);
  // VoIP.ms calls this one (secret token, no session); the rest is for technicians
  api.route("/sms/hook", smsHookRoutes);
  api.route("/sms", smsRoutes);
  api.route("/outlook", outlookRoutes);
  api.route("/microsoft", microsoftRoutes);
  api.route("/meetings", meetingRoutes);
  api.route("/breakroom", breakroomRoutes);
  api.route("/crm", crmRoutes);
  // Stripe calls this one (signed, no session)
  api.route("/stripe/hook", stripeHookRoutes);
  api.route("/billing", billingRoutes);
  api.route("/billables", billablesRoutes);
  api.route("/time", timeRoutes);
  api.route("/messages", messageRoutes);
  api.route("/board", boardRoutes);
  api.route("/portal", portalRoutes);
  api.use("/dashboard/*", requireStaff);
  api.route("/dashboard", dashboardRoutes);
  api.use("/tickets/*", requireStaff);
  api.use("/tickets", requireStaff);
  api.route("/tickets", ticketRoutes);
  api.use("/dashboards/*", requireStaff);
  api.use("/dashboards", requireStaff);
  api.route("/dashboards", dashboardsRoutes);
  api.all("*", (c) => c.json({ error: "not_found" }, 404));

  api.onError((err, c) => {
    if (err instanceof HTTPException) {
      const fields = Array.isArray(err.cause) ? err.cause : undefined;
      return c.json({ error: err.message, ...(fields ? { fields } : {}) }, err.status);
    }
    console.error("[api]", c.req.method, c.req.path, err);
    return c.json({ error: "server_error" }, 500);
  });

  app.route("/api", api);

  // Production: serve the built SPA from ./dist with an index.html fallback.
  const dist = path.join(config.root, "dist");
  if (fs.existsSync(path.join(dist, "index.html"))) {
    const indexHtml = fs.readFileSync(path.join(dist, "index.html"), "utf8");
    app.use(
      "/assets/*",
      serveStatic({
        root: path.relative(process.cwd(), dist),
        onFound: (_p, c) => {
          c.header("Cache-Control", "public, max-age=31536000, immutable");
        },
      }),
    );
    // Other files and the page itself: always revalidated, so an update shows
    // up right away (the hashed /assets above stay cached for a year)
    app.use(
      "*",
      serveStatic({
        root: path.relative(process.cwd(), dist),
        onFound: (_p, c) => {
          c.header("Cache-Control", "no-cache");
        },
      }),
    );
    app.get("*", (c) => {
      c.header("Cache-Control", "no-cache");
      return c.html(indexHtml);
    });
  }

  return app;
}
