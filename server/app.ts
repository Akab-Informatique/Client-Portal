import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";
import { config } from "./config.ts";
import { loadAuth, readOnlyViewAs, requireStaff, type AppEnv } from "./lib/auth.ts";
import { sameOriginJson } from "./lib/http.ts";
import { authRoutes } from "./routes/auth.ts";
import { meRoutes } from "./routes/me.ts";
import { adminRoutes } from "./routes/admin.ts";
import { integrationRoutes } from "./routes/integrations.ts";
import { emailRoutes } from "./routes/email.ts";
import { boardRoutes, messageRoutes } from "./routes/messages.ts";
import { dashboardRoutes } from "./routes/dashboard.ts";
import { dashboardsRoutes } from "./routes/dashboards.ts";
import { viewAsRoutes } from "./routes/viewAs.ts";
import { notificationRoutes } from "./routes/notifications.ts";
import { ticketRoutes } from "./routes/tickets.ts";

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
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
  api.use("*", bodyLimit({ maxSize: 256 * 1024 }));
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
  api.route("/admin", adminRoutes);
  api.use("/messages/*", requireStaff);
  api.route("/messages", messageRoutes);
  api.route("/board", boardRoutes);
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
    app.use("*", serveStatic({ root: path.relative(process.cwd(), dist) }));
    app.get("*", (c) => c.html(indexHtml));
  }

  return app;
}
