import { eq } from "drizzle-orm";
import { db, dbMode, dbReady, schema } from "@/db";
import { backfillUserStaffRoles, ensureDefaultStaffRoles } from "@/lib/roles";
import {
  ensureAllClientCompanyRoles,
  ensureClientUserRolesForCompany,
} from "@/lib/client-roles";

/**
 * Seed only when the database has zero users.
 * Production Postgres: runs once on first boot, then never again (data stays).
 * Local PGlite: same rule, keyed off the actual table — not a browser flag.
 */
export async function seedIfNeeded() {
  try {
    await dbReady;
  } catch (err) {
    // db/index may throw after exhausting fallbacks — surface and stop
    console.error("[akab] seedIfNeeded: dbReady failed", err);
    throw err;
  }
  if (!db) {
    throw new Error("Database client is not available");
  }

  // Production Postgres: server already ran migrations + bootstrap via /api/db/status.
  // Roles/backfill must never block portal open — staff page can repair later.
  if (dbMode === "postgres") {
    try {
      const existing = await db.select().from(schema.users).limit(1);
      if (existing.length > 0) {
        try {
          // Soft timeout so a slow/hung roles migrate cannot freeze boot
          await Promise.race([
            (async () => {
              await backfillUserStaffRoles();
              await ensureAllClientCompanyRoles();
              })(),
            new Promise<void>((_, reject) =>
              window.setTimeout(
                () => reject(new Error("role backfill timed out")),
                8000,
              ),
            ),
          ]);
        } catch (e) {
          console.warn("[akab] role backfill skipped:", e);
        }
        return;
      }
      // Empty despite server bootstrap attempt — try client seed once
      console.warn(
        "[akab] Postgres has zero users after server bootstrap — seeding from client",
      );
    } catch (err) {
      console.error("[akab] Postgres pre-seed check failed", err);
      throw err;
    }
  }

  // Always ensure system roles exist (idempotent — safe on every boot/upgrade)
  const { admin: adminRole, technician: techRole } =
    await ensureDefaultStaffRoles();
  const existing = await db.select().from(schema.users).limit(1);
  if (existing.length > 0) {
    await backfillUserStaffRoles();
    await ensureAllClientCompanyRoles();
    return;
  }

  // Empty DB — install demo/bootstrap data (first production boot or fresh PGlite)
  console.info(
    `[akab] Empty database (${dbMode}) — creating bootstrap admin + demo clients`,
  );

  const [solu] = await db
    .insert(schema.companies)
    .values({
      name: "AKAB Informatique",
      type: "internal",
      email: "admin@akab.local",
      phone: "1-888-765-8841",
      notes: "Internal management company",
      active: true,
    })
    .returning();

  const [acme] = await db
    .insert(schema.companies)
    .values({
      name: "Acme Manufacturing",
      type: "client",
      email: "it@acme.example",
      phone: "555-0100",
      notes: "Demo client company",
      autotask_company_id: "1001",
      active: true,
    })
    .returning();

  const [northstar] = await db
    .insert(schema.companies)
    .values({
      name: "Northstar Logistics",
      type: "client",
      email: "ops@northstar.example",
      phone: "555-0200",
      notes: "Second demo client",
      autotask_company_id: "1002",
      active: true,
    })
    .returning();

  const acmeRoles = await ensureClientUserRolesForCompany(acme.id);
  const northstarRoles = await ensureClientUserRolesForCompany(northstar.id);

  await db.insert(schema.users).values([
    {
      email: "admin@akab.local",
      password: "admin123",
      name: "Portal Admin",
      role: "admin",
      company_id: solu.id,
      active: true,
      staff_role_id: adminRole.id,
      job_title: "Portal Administrator",
      phone: "1-888-765-8841",
      bio: "AKAB internal administrator for the client portal.",
      locale: "en",
    },
    {
      email: "tech@akab.local",
      password: "tech123",
      name: "Alex Technician",
      role: "technician",
      company_id: solu.id,
      active: true,
      staff_role_id: techRole.id,
      job_title: "Service Technician",
      phone: "1-888-765-8841",
      bio: "Field and remote support technician at AKAB.",
      locale: "en",
    },
    {
      email: "client@acme.example",
      password: "client123",
      name: "Jordan Client",
      role: "client",
      company_id: acme.id,
      active: true,
      client_role_id: acmeRoles.standard.id,
      billing_access: null,
      job_title: "IT Coordinator",
      phone: "555-0100",
      bio: "Primary contact for Acme Manufacturing.",
      locale: "en",
    },
    {
      email: "ops@northstar.example",
      password: "client123",
      name: "Sam Northstar",
      role: "client",
      company_id: northstar.id,
      active: true,
      client_role_id: northstarRoles.standard.id,
      billing_access: null,
      job_title: "Operations Lead",
      phone: "555-0200",
      bio: "Operations contact for Northstar Logistics.",
      locale: "fr",
    },
  ]);

  const adminRows = await db.select().from(schema.users).limit(5);
  const admin =
    (adminRows as Array<{ id: number; name: string; role: string }>).find(
      (u) => u.role === "admin",
    ) ?? (adminRows[0] as { id: number; name: string; role: string });

  await db.insert(schema.board_messages).values([
    {
      company_id: acme.id,
      author_id: admin.id,
      author_name: admin.name,
      title: "Welcome to your AKAB portal",
      body: "This is your company message board. Updates from AKAB will appear here. Your team can use this space as future collaboration features roll out.",
      pinned: true,
    },
    {
      company_id: northstar.id,
      author_id: admin.id,
      author_name: admin.name,
      title: "Portal access activated",
      body: "Your Northstar Logistics zone is ready. Check back here for service notices and announcements from our team.",
      pinned: true,
    },
  ]);

  // No browser flag — emptiness of the users table is the only seed gate
  // so production Postgres is never re-seeded after the first boot.
}

/** Rename legacy SOLU TI internal company + demo accounts to AKAB (non-destructive). */
async function ensureDemoBrand() {
  const companies = await db.select().from(schema.companies);
  for (const c of companies) {
    if (c.type === "internal" && (c.name.includes("SOLU") || c.name === "SOLU TI INC.")) {
      await db
        .update(schema.companies)
        .set({ name: "AKAB Informatique", email: c.email?.includes("soluti") ? "admin@akab.local" : c.email })
        .where(eq(schema.companies.id, c.id));
    }
  }
  const users = await db.select().from(schema.users);
  for (const u of users) {
    const patch: { email?: string; phone?: string; bio?: string } = {};
    if (u.email === "admin@soluti.local") patch.email = "admin@akab.local";
    if (u.email === "tech@soluti.local") patch.email = "tech@akab.local";
    if (u.bio && u.bio.includes("SOLU TI")) {
      patch.bio = u.bio.split("SOLU TI").join("AKAB");
    }
    if (u.phone === "1-800-SOLU-TI") patch.phone = "1-888-765-8841";
    if (Object.keys(patch).length) {
      await db.update(schema.users).set(patch).where(eq(schema.users.id, u.id));
    }
  }
  const msgs = await db.select().from(schema.board_messages);
  for (const m of msgs) {
    const title = m.title?.includes("SOLU TI")
      ? m.title.split("SOLU TI").join("AKAB")
      : m.title;
    const body = m.body?.includes("SOLU TI")
      ? m.body.split("SOLU TI").join("AKAB")
      : m.body;
    if (title !== m.title || body !== m.body) {
      await db.update(schema.board_messages).set({ title, body }).where(eq(schema.board_messages.id, m.id));
    }
  }
}

/** Backfill Autotask IDs on demo clients if missing (existing local DBs). */
export async function ensureDemoAutotaskIds() {
  await dbReady;
  await ensureDemoBrand();

  // Roles are already ensured in seedIfNeeded(); keep a cheap no-op call
  // so standalone use of this helper still heals staff_role links.
  await ensureDefaultStaffRoles();
  await backfillUserStaffRoles();
  try {
    await ensureAllClientCompanyRoles();
    } catch (e) {
    console.warn("[akab] client role heal skipped:", e);
  }

  const companies = await db.select().from(schema.companies);
  for (const c of companies) {
    if (c.type !== "client") continue;
    if (c.autotask_company_id) continue;
    if (c.name === "Acme Manufacturing") {
      await db
        .update(schema.companies)
        .set({ autotask_company_id: "1001" })
        .where(eq(schema.companies.id, c.id));
    } else if (c.name === "Northstar Logistics") {
      await db
        .update(schema.companies)
        .set({ autotask_company_id: "1002" })
        .where(eq(schema.companies.id, c.id));
    }
  }

  // Soft-fill empty profile fields on known demo users (non-destructive)
  const users = await db.select().from(schema.users);
  for (const u of users) {
    const patch: {
      job_title?: string;
      phone?: string;
      bio?: string;
      locale?: string;
    } = {};
    if (!u.job_title) {
      if (u.role === "admin") patch.job_title = "Portal Administrator";
      else if (u.role === "technician") patch.job_title = "Service Technician";
      else if (u.email.includes("acme")) patch.job_title = "IT Coordinator";
      else if (u.email.includes("northstar")) patch.job_title = "Operations Lead";
    }
    if (!u.phone && u.role !== "client") patch.phone = "1-888-765-8841";
    if (!u.locale) {
      patch.locale = u.email.includes("northstar") ? "fr" : "en";
    }
    if (!u.bio) {
      if (u.role === "admin") {
        patch.bio = "AKAB internal administrator for the client portal.";
      } else if (u.role === "technician") {
        patch.bio = "Field and remote support technician at AKAB.";
      }
    }
    if (Object.keys(patch).length > 0) {
      await db
        .update(schema.users)
        .set(patch)
        .where(eq(schema.users.id, u.id));
    }
  }
}
