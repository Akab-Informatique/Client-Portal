import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "@/lib/api";
import type { AdminUser, AuditEntry, Client, Role } from "@/lib/types";
import { SYSTEM_ROLES } from "@shared/permissions";

export const useRoles = () => useQuery({ queryKey: ["admin", "roles"], queryFn: () => api.get<Role[]>("/admin/roles") });
export const useStaff = () => useQuery({ queryKey: ["admin", "staff"], queryFn: () => api.get<AdminUser[]>("/admin/staff") });
export const useClients = () => useQuery({ queryKey: ["admin", "clients"], queryFn: () => api.get<Client[]>("/admin/clients") });
export const useClientUsers = (clientId: string | null) =>
  useQuery({
    queryKey: ["admin", "clients", clientId, "users"],
    queryFn: () => api.get<AdminUser[]>(`/admin/clients/${clientId}/users`),
    enabled: Boolean(clientId),
  });
export const useAudit = () => useQuery({ queryKey: ["admin", "audit"], queryFn: () => api.get<AuditEntry[]>("/admin/audit") });

/** Localized role name: predefined roles follow the UI language. */
export function useRoleName() {
  const { i18n } = useTranslation();
  return (role: Pick<Role, "slug" | "name"> | null | undefined) => {
    if (!role) return "";
    const sys = role.slug ? SYSTEM_ROLES.find((r) => r.slug === role.slug) : undefined;
    return sys ? (i18n.language === "en" ? sys.name.en : sys.name.fr) : role.name;
  };
}

export function useRoleDescription() {
  const { i18n } = useTranslation();
  return (role: Pick<Role, "slug" | "description"> | null | undefined) => {
    if (!role) return "";
    const sys = role.slug ? SYSTEM_ROLES.find((r) => r.slug === role.slug) : undefined;
    return sys ? (i18n.language === "en" ? sys.description.en : sys.description.fr) : (role.description ?? "");
  };
}

/** Maps API error codes to friendly text. */
export function useAdminError() {
  const { t } = useTranslation();
  return (e: unknown) => {
    const code = e instanceof ApiError ? e.code : "";
    switch (code) {
      case "email_taken":
        return t("admin.users.emailTaken");
      case "last_admin":
        return t("admin.users.lastAdmin");
      case "cannot_disable_self":
        return t("admin.users.cannotDisableSelf");
      case "role_in_use":
        return t("admin.roles.inUse");
      case "role_locked":
        return t("admin.roles.lockedText");
      default:
        return t("common.error");
    }
  };
}
