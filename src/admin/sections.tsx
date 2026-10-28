import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { toast } from "sonner";
import { ChevronRight, Loader2, Lock, Pencil, Plus, Search, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { dateTime, relativeTime } from "@/lib/format";
import type { AdminUser, Role } from "@/lib/types";
import { cn, initials } from "@/lib/utils";
import { permissionsFor, type Audience } from "@shared/permissions";
import { useAdminError, useAudit, useRoleDescription, useRoleName, useRoles, useStaff } from "./hooks";
import { PermissionMatrix } from "./PermissionMatrix";
import { NewUserDialog, UserSheet, UserStatusBadges } from "./UserPanels";
import { useOneShotParam } from "@/lib/useDeepLink";
import { useConfirm } from "@/components/ConfirmDialog";

export function SectionHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-2xl font-bold">{title}</h2>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={t("common.search")} className="pl-9" />
    </div>
  );
}

function UserRow({ u, roles, onClick }: { u: AdminUser; roles: Role[]; onClick: () => void }) {
  const roleName = useRoleName();
  const role = roles.find((r) => r.id === u.roleId);
  return (
    <motion.button
      layout
      type="button"
      onClick={onClick}
      className={cn("group flex w-full items-center gap-4 rounded-xl border bg-card/60 p-3 text-left transition-colors hover:border-[color:var(--gold)]/40", !u.active && "opacity-60")}
    >
      <Avatar className="size-10">
        <AvatarFallback className="bg-muted text-xs font-semibold">{initials(u.name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{u.name}</p>
        <p className="truncate text-xs text-muted-foreground">{u.email}</p>
      </div>
      <div className="hidden min-w-0 sm:block">{role && <Badge variant="secondary">{roleName(role)}</Badge>}</div>
      <div className="hidden md:block">
        <UserStatusBadges u={u} />
      </div>
      <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </motion.button>
  );
}

const match = (u: AdminUser, q: string) => `${u.name} ${u.email} ${u.title ?? ""}`.toLowerCase().includes(q.toLowerCase());

// ── Technicians ──────────────────────────────────────────────────────────────
export function StaffSection() {
  const { t } = useTranslation();
  const { data, isLoading } = useStaff();
  const { data: roles = [] } = useRoles();
  const [q, setQ] = useState("");
  const linkedUser = useOneShotParam("user");
  const [openId, setOpenId] = useState<string | null>(linkedUser);
  const [creating, setCreating] = useState(false);
  const list = (data ?? []).filter((u) => match(u, q));
  return (
    <div>
      <SectionHeader
        title={t("admin.staff.title")}
        subtitle={t("admin.staff.subtitle")}
        action={
          <Button onClick={() => setCreating(true)} className="bg-grad-gold font-semibold text-[#1a1204] glow-gold hover:brightness-105">
            <UserPlus className="size-4" /> {t("admin.staff.add")}
          </Button>
        }
      />
      <div className="mb-4 max-w-sm">
        <SearchBox value={q} onChange={setQ} />
      </div>
      <div className="space-y-2">
        {isLoading ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-16 rounded-xl" />) : list.map((u) => <UserRow key={u.id} u={u} roles={roles} onClick={() => setOpenId(u.id)} />)}
      </div>
      <NewUserDialog open={creating} onOpenChange={setCreating} kind="staff" />
      <UserSheet user={(data ?? []).find((u) => u.id === openId) ?? null} onClose={() => setOpenId(null)} />
    </div>
  );
}

// ── Clients ──────────────────────────────────────────────────────────────────
export function RolesSection() {
  const { t } = useTranslation();
  const { data: roles = [], isLoading } = useRoles();
  const [editing, setEditing] = useState<Role | "new" | null>(null);
  // technician roles only: each client's roles are managed in Clients (they are separate for every client)
  const staffRoles = roles.filter((r) => r.audience === "staff" && !r.clientId);
  return (
    <div>
      <SectionHeader
        title={t("admin.roles.title")}
        subtitle={t("admin.roles.subtitle")}
        action={
          <Button onClick={() => setEditing("new")} className="bg-grad-gold font-semibold text-[#1a1204] glow-gold hover:brightness-105">
            <Plus className="size-4" /> {t("admin.roles.add")}
          </Button>
        }
      />
      <div>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t("admin.roles.staffRoles")}</h3>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {isLoading ? [0, 1].map((i) => <Skeleton key={i} className="h-32 rounded-2xl" />) : staffRoles.map((r) => <RoleCard key={r.id} role={r} onEdit={() => setEditing(r)} />)}
        </div>
        <p className="mt-6 text-xs text-muted-foreground">{t("admin.roles.clientRolesElsewhere")}</p>
      </div>
      <RoleDialog role={editing} roles={staffRoles} onClose={() => setEditing(null)} />
    </div>
  );
}

export function RoleCard({ role, onEdit }: { role: Role; onEdit: () => void }) {
  const { t } = useTranslation();
  const roleName = useRoleName();
  const roleDesc = useRoleDescription();
  return (
    <motion.button
      layout
      type="button"
      onClick={onEdit}
      className="group relative flex flex-col overflow-hidden rounded-2xl border bg-card/60 p-4 text-left transition-colors hover:border-[color:var(--gold)]/40"
    >
      <div className="flex items-start gap-3">
        <span className={cn("flex size-9 items-center justify-center rounded-lg", role.locked ? "bg-grad-gold text-[#1a1204]" : "bg-muted")}>
          {role.locked ? <Lock className="size-4" /> : <ShieldCheck className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{roleName(role)}</p>
          <p className="line-clamp-2 text-xs text-muted-foreground">{roleDesc(role)}</p>
        </div>
        <Pencil className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-1.5 text-xs">
        <Badge variant={role.isSystem ? "secondary" : "outline"}>{role.isSystem ? t("admin.roles.system") : t("admin.roles.custom")}</Badge>
        <Badge variant="outline">{t("admin.roles.usersCount", { count: role.userCount })}</Badge>
        <span className="ml-auto font-mono text-muted-foreground">{role.permissions.length} ✓</span>
      </div>
    </motion.button>
  );
}

/**
 * Make or edit a role. Without `clientId` it is a technician role; with it, a
 * role of that one client (client roles are separate for every client).
 */
export function RoleDialog({ role, roles, clientId, onClose }: { role: Role | "new" | null; roles: Role[]; clientId?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const errText = useAdminError();
  const roleName = useRoleName();
  const isNew = role === "new";
  const existing = role && role !== "new" ? role : null;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [audience, setAudience] = useState<Audience>(clientId ? "client" : "staff");
  const [permissions, setPermissions] = useState<string[]>([]);
  useEffect(() => {
    if (!role) return;
    if (role === "new") {
      setName("");
      setDescription("");
      setAudience(clientId ? "client" : "staff");
      setPermissions([]);
    } else {
      setName(roleName(role));
      setDescription(role.description ?? "");
      setAudience(role.audience);
      setPermissions(role.permissions);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  const save = useMutation({
    mutationFn: () =>
      isNew
        ? api.post<Role>("/admin/roles", { name, description, audience, permissions, ...(clientId ? { clientId } : {}) })
        : api.patch<Role>(`/admin/roles/${existing!.id}`, existing!.isSystem ? { permissions } : { name, description, permissions }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      void qc.invalidateQueries({ queryKey: ["auth"] });
      toast.success(t("common.saved"));
      onClose();
    },
    onError: (e) => toast.error(errText(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/admin/roles/${existing!.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      onClose();
    },
    onError: (e) => toast.error(errText(e)),
  });
  const locked = Boolean(existing?.locked);

  return (
    <Dialog open={Boolean(role)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isNew ? t("admin.roles.newRole") : t("admin.roles.editRole")}</DialogTitle>
        </DialogHeader>
        {locked && (
          <p className="flex items-center gap-2 rounded-lg border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 px-3 py-2 text-sm">
            <Lock className="size-4 text-primary" /> {t("admin.roles.lockedText")}
          </p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
          className="space-y-5"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>{t("admin.roles.name")}</Label>
              <Input required disabled={Boolean(existing?.isSystem)} value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label>{t("admin.roles.description")}</Label>
              <Input disabled={Boolean(existing?.isSystem)} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            {isNew && (
              <div className="space-y-2 sm:col-span-2">
                <Label>{t("admin.roles.startFrom")}</Label>
                <Select onValueChange={(id) => setPermissions(id === "blank" ? [] : (roles.find((r) => r.id === id)?.permissions ?? []))}>
                  <SelectTrigger className="w-full"><SelectValue placeholder={t("admin.roles.blank")} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="blank">{t("admin.roles.blank")}</SelectItem>
                    {roles.filter((r) => r.audience === audience).map((r) => (
                      <SelectItem key={r.id} value={r.id}>{roleName(r)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <Label>{t("admin.roles.permissions")}</Label>
              {!locked && (
                <div className="flex gap-2 text-xs">
                  <button type="button" className="text-primary hover:underline" onClick={() => setPermissions(rolesAll(audience))}>{t("admin.roles.selectAll")}</button>
                  <button type="button" className="text-muted-foreground hover:underline" onClick={() => setPermissions([])}>{t("admin.roles.clearAll")}</button>
                </div>
              )}
            </div>
            <PermissionMatrix audience={audience} value={permissions} onChange={setPermissions} disabled={locked} />
          </div>
          <div className="flex flex-wrap justify-between gap-2 border-t pt-4">
            {existing && !existing.isSystem ? (
              <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => void confirm({ title: t("admin.roles.deleteConfirm"), destructive: true }).then((ok) => ok && remove.mutate())}>
                <Trash2 className="size-4" /> {t("common.delete")}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
              {!locked && (
                <Button type="submit" disabled={save.isPending}>{save.isPending && <Loader2 className="size-4 animate-spin" />} {isNew ? t("common.create") : t("common.save")}</Button>
              )}
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const rolesAll = (a: Audience) => permissionsFor(a) as string[];

// ── Activity ─────────────────────────────────────────────────────────────────
export function ActivitySection() {
  const { t } = useTranslation();
  const { data, isLoading } = useAudit();
  return (
    <div>
      <SectionHeader title={t("admin.activity.title")} subtitle={t("admin.activity.subtitle")} />
      {isLoading ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : !data?.length ? (
        <p className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">{t("admin.activity.empty")}</p>
      ) : (
        <ol className="relative space-y-1 border-l pl-6">
          {data.map((e) => (
            <li key={e.id} className="relative py-2">
              <span className="absolute -left-[29px] top-3.5 size-2.5 rounded-full border-2 border-background bg-grad-gold" />
              <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-medium">{e.actorName ?? t("admin.activity.system")}</span>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{e.action}</code>
                <span className="text-xs text-muted-foreground" title={dateTime(e.createdAt)}>{relativeTime(e.createdAt)}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
