import { and, eq } from "drizzle-orm";
import { db, dbReady, schema } from "@/db";
import type { PublicProfile, User } from "@/lib/types";

function toPublic(row: User): PublicProfile {
  const {
    password: _pw,
    mfa_totp_secret: _s,
    mfa_recovery_codes: _r,
    mfa_email_code_hash: _h,
    mfa_email_code_expires: _e,
    ...rest
  } = row;
  return {
    ...rest,
    staff_role_id: row.staff_role_id ?? null,
    job_title: row.job_title ?? null,
    phone: row.phone ?? null,
    mobile: row.mobile ?? null,
    bio: row.bio ?? null,
    locale: row.locale ?? null,
    mfa_enabled: Boolean(row.mfa_enabled && row.mfa_totp_secret),
  };
}

/**
 * Load a profile only if the viewer is in the SAME company.
 * Cross-company access always returns null (no leak).
 */
export async function getProfileInCompany(
  profileUserId: number,
  viewerCompanyId: number | null | undefined,
): Promise<PublicProfile | null> {
  if (viewerCompanyId == null) return null;
  await dbReady;
  const rows = (await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, profileUserId))
    .limit(1)) as User[];
  const found = rows[0];
  if (!found || !found.active) return null;
  if (found.company_id == null || found.company_id !== viewerCompanyId) {
    return null;
  }
  return toPublic(found);
}

/** Active users in the same company (never crosses company boundary). */
export async function listCompanyDirectory(
  companyId: number | null | undefined,
): Promise<PublicProfile[]> {
  if (companyId == null) return [];
  await dbReady;
  const rows = (await db
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.company_id, companyId),
        eq(schema.users.active, true),
      ),
    )) as User[];
  return rows
    .map(toPublic)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export type ProfileUpdate = {
  name?: string;
  job_title?: string | null;
  phone?: string | null;
  mobile?: string | null;
  bio?: string | null;
  locale?: string | null;
  itglue_user_id?: string | null;
  board_email_opt_in?: boolean | null;
};

/** Self-only profile update. */
export async function updateOwnProfile(
  userId: number,
  patch: ProfileUpdate,
): Promise<PublicProfile | null> {
  await dbReady;
  const [updated] = (await db
    .update(schema.users)
    .set({
      ...(patch.name != null ? { name: patch.name.trim() } : {}),
      ...(patch.job_title !== undefined
        ? { job_title: patch.job_title?.trim() || null }
        : {}),
      ...(patch.phone !== undefined
        ? { phone: patch.phone?.trim() || null }
        : {}),
      ...(patch.mobile !== undefined
        ? { mobile: patch.mobile?.trim() || null }
        : {}),
      ...(patch.bio !== undefined ? { bio: patch.bio?.trim() || null } : {}),
      ...(patch.locale !== undefined
        ? { locale: patch.locale?.trim() || null }
        : {}),
      ...(patch.itglue_user_id !== undefined
        ? { itglue_user_id: patch.itglue_user_id?.trim() || null }
        : {}),
      ...(patch.board_email_opt_in !== undefined
        ? { board_email_opt_in: patch.board_email_opt_in !== false }
        : {}),
    })
    .where(eq(schema.users.id, userId))
    .returning()) as User[];
  return updated ? toPublic(updated) : null;
}

export async function changeOwnPassword(
  userId: number,
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; error: "wrong" | "short" }> {
  if (newPassword.trim().length < 6) {
    return { ok: false, error: "short" };
  }
  await dbReady;
  const rows = (await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1)) as User[];
  const found = rows[0];
  if (!found || found.password !== currentPassword) {
    return { ok: false, error: "wrong" };
  }
  await db
    .update(schema.users)
    .set({ password: newPassword })
    .where(eq(schema.users.id, userId));
  return { ok: true };
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
