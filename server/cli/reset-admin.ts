/**
 * Server-side recovery for when nobody can sign in (lost one-time password,
 * no mail server yet). Run on the server, inside the app container:
 *
 *   docker compose exec app node --import tsx server/cli/reset-admin.ts
 *       → lists the staff accounts
 *   docker compose exec app node --import tsx server/cli/reset-admin.ts you@akab.ca
 *       → new one-time password for that account (unlocked, re-enabled);
 *         creates it as an administrator if it does not exist
 *   … reset-admin.ts you@akab.ca --mfa
 *       → also resets MFA (set it up again at the next sign-in)
 *
 * Only someone with shell access to the server can run this. The password is
 * printed once and must be changed at the first sign-in.
 */
import { eq, sql } from "drizzle-orm";
import { closeDb, db, initDb, schema } from "../db/index.ts";
import { audit } from "../lib/audit.ts";
import { revokeUserSessions } from "../lib/auth.ts";
import { hashPassword, temporaryPassword } from "../lib/crypto.ts";

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith("--"))?.trim().toLowerCase();
const resetMfa = args.includes("--mfa");

await initDb();
try {
  if (!email) {
    const staff = await db()
      .select({ email: schema.users.email, name: schema.users.name, active: schema.users.active, mfa: schema.users.mfaEnabled, role: schema.roles.slug })
      .from(schema.users)
      .leftJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
      .where(eq(schema.users.kind, "staff"));
    console.log(staff.length ? "Staff accounts:" : "No staff account yet.");
    for (const s of staff) {
      console.log(`  ${s.email.padEnd(36)} ${(s.role ?? "-").padEnd(14)} ${s.active ? "active" : "DISABLED"}  MFA ${s.mfa ? "on" : "off"}`);
    }
    console.log("\nReset one: node --import tsx server/cli/reset-admin.ts <email> [--mfa]");
  } else {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Invalid email: ${email}`);
    const password = temporaryPassword();
    const passwordHash = await hashPassword(password);
    const [user] = await db().select().from(schema.users).where(sql`lower(${schema.users.email}) = ${email}`);
    if (user && user.kind !== "staff") throw new Error(`${email} is a client account, not a technician.`);

    if (user) {
      await db()
        .update(schema.users)
        .set({
          passwordHash,
          mustChangePassword: true,
          active: true,
          failedLogins: 0,
          lockedUntil: null,
          ...(resetMfa ? { mfaEnabled: false, mfaSecret: null, mfaLastStep: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, user.id));
      await revokeUserSessions(user.id);
      await audit(null, "cli.password_reset", user.id, { mfaReset: resetMfa || undefined });
      console.log(`\nAccount reset: ${user.email}${resetMfa ? " (MFA reset)" : ""}`);
    } else {
      const [role] = await db().select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.slug, "administrator"));
      if (!role) throw new Error("Administrator role missing: start the portal once (docker compose up -d), then run this again.");
      const [created] = await db()
        .insert(schema.users)
        .values({ email, name: "Administrateur AKAB", kind: "staff", roleId: role.id, passwordHash, mustChangePassword: true, title: "Administrateur" })
        .returning({ id: schema.users.id });
      await audit(null, "cli.admin_created", created.id, { email });
      console.log(`\nAdministrator created: ${email}`);
    }
    console.log(`One-time password: ${password}`);
    console.log("Sign in through the HTTPS address, set up MFA, then choose your own password.\n");
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await closeDb();
}
