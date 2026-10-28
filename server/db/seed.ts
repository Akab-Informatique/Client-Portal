import { eq, sql } from "drizzle-orm";
import { db, schema } from "./index.ts";
import { config } from "../config.ts";
import { hashPassword, temporaryPassword, passwordProblem } from "../lib/crypto.ts";
import { MASTER_ROLE, SYSTEM_ROLES, permissionsFor } from "../../shared/permissions.ts";

/**
 * Idempotent startup tasks:
 * - predefined roles exist (Administrator always gets every staff right, so
 *   new modules are granted to admins automatically)
 * - a first administrator exists (ADMIN_EMAIL / ADMIN_PASSWORD, or a random
 *   one-time password printed to the log)
 * - development only: demo clients, users and messages
 */
/** Names shown in the UI come from i18n (dashboards.builtin.<slug>). */
/** Built-in dashboards, in menu order. "akab" is everyone's default. */
export const BUILTIN_DASHBOARDS = [
  { slug: "akab", name: "Akab", visibility: "team" },
  { slug: "security", name: "Sécurité", visibility: "admins" },
  { slug: "clients", name: "Clients", visibility: "admins" },
  { slug: "finance", name: "Finances", visibility: "admins" },
] as const;

export async function seed(): Promise<void> {
  const d = db();
  for (const r of SYSTEM_ROLES) {
    const [existing] = await d.select().from(schema.roles).where(eq(schema.roles.slug, r.slug));
    if (!existing) {
      await d.insert(schema.roles).values({
        slug: r.slug,
        audience: r.audience,
        name: r.name.fr,
        description: r.description.fr,
        permissions: r.permissions,
        defaultsApplied: r.permissions,
        isSystem: true,
        locked: r.locked,
      });
    } else if (r.slug === MASTER_ROLE) {
      await d
        .update(schema.roles)
        // every right, and its name (it cannot be edited)
        .set({ name: r.name.fr, description: r.description.fr, permissions: permissionsFor("staff"), defaultsApplied: permissionsFor("staff"), locked: true, updatedAt: new Date() })
        .where(eq(schema.roles.id, existing.id));
    } else {
      // A right added to this role's defaults (e.g. texts for technicians) is
      // given once; a right an admin removed is not given back.
      const applied = new Set(existing.defaultsApplied ?? []);
      const added = r.permissions.filter((p) => !applied.has(p) && !existing.permissions.includes(p));
      if (added.length || !existing.defaultsApplied) {
        await d
          .update(schema.roles)
          .set({ permissions: [...existing.permissions, ...added], defaultsApplied: r.permissions, updatedAt: new Date() })
          .where(eq(schema.roles.id, existing.id));
      }
    }
  }

  // Built-in dashboards: empty, administrators only until an admin shares them
  for (const b of BUILTIN_DASHBOARDS) {
    const [existing] = await d.select({ id: schema.dashboards.id }).from(schema.dashboards).where(eq(schema.dashboards.slug, b.slug));
    if (!existing) await d.insert(schema.dashboards).values({ slug: b.slug, name: b.name, visibility: b.visibility });
  }

  const [{ count }] = await d
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.users)
    .where(eq(schema.users.kind, "staff"));
  if (count > 0) return;

  const adminRole = await roleBySlug(MASTER_ROLE);
  const demo = config.seedDemo && !config.production;
  const email = config.bootstrap.email || "admin@akab.local";
  if (config.bootstrap.password && config.production && passwordProblem(config.bootstrap.password)) {
    throw new Error("ADMIN_PASSWORD is too short (12 characters minimum): leave it empty to get a one-time password in the log");
  }
  const password = config.bootstrap.password || (demo ? "akab-dev-password" : temporaryPassword());
  await d.insert(schema.users).values({
    email,
    name: config.bootstrap.name,
    kind: "staff",
    roleId: adminRole,
    passwordHash: await hashPassword(password),
    // ADMIN_PASSWORD stays in .env: it is only a first password, changed at the first sign-in
    mustChangePassword: !demo,
    title: "Administrateur",
  });
  if (config.bootstrap.password) {
    console.log(`[seed] first administrator created: ${email} (password from ADMIN_PASSWORD)`);
  } else {
    console.log(`[seed] first administrator created: ${email}  one-time password: ${password}`);
    console.log("[seed] sign in, set up MFA and change the password, then clear your log history.");
  }

  if (demo) await seedDemo(adminRole);
}

async function roleBySlug(slug: string): Promise<string> {
  const [r] = await db().select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.slug, slug));
  if (!r) throw new Error(`role ${slug} missing`);
  return r.id;
}

async function seedDemo(adminRoleId: string): Promise<void> {
  const d = db();
  const devPassword = await hashPassword("akab-dev-password");
  const tech = await roleBySlug("technician");
  const clientAdmin = await roleBySlug("client-admin");
  const clientUser = await roleBySlug("client-user");
  void adminRoleId;

  await d.insert(schema.users).values({
    email: "tech@akab.local",
    name: "Alex Tremblay",
    kind: "staff",
    roleId: tech,
    passwordHash: devPassword,
    title: "Technicien",
  });

  const demoClients = [
    { name: "Boulangerie Lanaudière", code: "BLAN", email: "info@boulangerie.example", phone: "450-555-0101", portalEnabled: true },
    { name: "Clinique Rawdon", code: "CRAW", email: "admin@clinique.example", phone: "450-555-0102", portalEnabled: true },
    { name: "Transport Joliette", code: "TJOL", email: "it@transport.example", phone: "450-555-0103", portalEnabled: true },
  ];
  const created = await d.insert(schema.clients).values(demoClients).returning();
  for (const [i, cl] of created.entries()) {
    await d.insert(schema.users).values([
      {
        email: `responsable${i + 1}@client.example`,
        name: ["Marie Gagnon", "Luc Bergeron", "Sophie Roy"][i],
        kind: "client",
        clientId: cl.id,
        roleId: clientAdmin,
        passwordHash: devPassword,
        title: "Responsable TI",
      },
      {
        email: `employe${i + 1}@client.example`,
        name: ["Jean Côté", "Nadia Fortin", "Paul Ouellet"][i],
        kind: "client",
        clientId: cl.id,
        roleId: clientUser,
        passwordHash: devPassword,
        notifyEmail: false,
      },
    ]);
  }
  const [admin] = await d.select().from(schema.users).where(eq(schema.users.email, config.bootstrap.email || "admin@akab.local"));
  await d.insert(schema.messages).values([
    {
      title: "Bienvenue sur le portail AKAB",
      body: "Votre nouveau portail est en ligne. Vous y trouverez les annonces importantes de votre équipe TI.",
      pinned: true,
      audience: "all",
      authorId: admin?.id,
    },
    {
      title: "Maintenance planifiée — samedi 22 h",
      body: "Mise à jour des pare-feu entre 22 h et minuit. Courte interruption possible de l'accès à distance.",
      pinned: false,
      audience: "all",
      authorId: admin?.id,
    },
  ]);
  console.log("[seed] demo data created (dev). Users: admin@akab.local / tech@akab.local, password akab-dev-password");
}
