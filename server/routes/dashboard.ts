import { Hono } from "hono";
import { desc, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { auth, requirePermission, type AppEnv } from "../lib/auth.ts";
import { mailConfigured } from "../lib/mail.ts";
import { config } from "../config.ts";

const count = (q: Promise<{ n: number }[]>) => q.then((r) => r[0]?.n ?? 0);

export const dashboardRoutes = new Hono<AppEnv>().get("/summary", requirePermission("dashboard.view"), async (c) => {
  const a = auth(c);
  const d = db();
  const n = sql<number>`count(*)::int`;
  const canMessages = a.permissions.includes("messages.view");
  const [clients, clientUsers, staff, messages, pinned, recent] = await Promise.all([
    count(d.select({ n }).from(schema.clients).where(eq(schema.clients.active, true))),
    count(d.select({ n }).from(schema.users).where(sql`${schema.users.kind} = 'client' and ${schema.users.active}`)),
    count(d.select({ n }).from(schema.users).where(sql`${schema.users.kind} = 'staff' and ${schema.users.active}`)),
    canMessages ? count(d.select({ n }).from(schema.messages)) : Promise.resolve(0),
    canMessages ? count(d.select({ n }).from(schema.messages).where(eq(schema.messages.pinned, true))) : Promise.resolve(0),
    canMessages
      ? d
          .select({
            id: schema.messages.id,
            title: schema.messages.title,
            pinned: schema.messages.pinned,
            audience: schema.messages.audience,
            createdAt: schema.messages.createdAt,
          })
          .from(schema.messages)
          .orderBy(desc(schema.messages.createdAt))
          .limit(6)
      : Promise.resolve([]),
  ]);
  return c.json({
    counts: { clients, clientUsers, staff, messages, pinned },
    recentMessages: recent,
    services: { database: config.db.kind, email: mailConfigured() },
  });
});
