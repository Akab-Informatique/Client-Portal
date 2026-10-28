import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Building2, ChevronDown, ChevronRight, KeyRound, Loader2, Plus, Search, ShieldCheck, UserPlus } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useCan } from "@/lib/session";
import type { AdminUser, Role } from "@/lib/types";
import { cn, initials } from "@/lib/utils";
import { useClients, useClientRoles, useClientUsers, useRoleName } from "./hooks";
import { RoleCard, RoleDialog, SectionHeader } from "./sections";
import { NewUserDialog, UserSheet, UserStatusBadges } from "./UserPanels";

/** What the panels need to know of a client. */
export type ClientRef = { id: string; name: string; active: boolean; portalEnabled: boolean };

/**
 * The client portal for the whole company. Every contact with an email already
 * has an account; nobody can sign in until this is switched on, which also sends
 * each of them the welcome email (unless unticked). Off again closes everyone.
 */
export function CompanyPortalSwitch({ client, ready, noEmail = 0, onChange }: { client: ClientRef; ready: number; noEmail?: number; onChange?: () => void }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [welcome, setWelcome] = useState(true);
  const set = useMutation({
    mutationFn: (enabled: boolean) => api.put<{ enabled: boolean; sent?: number; failed?: number }>(`/crm/clients/${client.id}/portal`, { enabled, sendWelcome: welcome }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["crm"] });
      void qc.invalidateQueries({ queryKey: ["admin"] });
      onChange?.();
      if (!r.enabled) toast.success(t("crm.portal.company.closed"));
      else if (r.failed) toast.warning(t("crm.portal.company.openedMailFailed", { sent: r.sent ?? 0, failed: r.failed }));
      else toast.success(t("crm.portal.company.opened", { count: r.sent ?? 0 }));
    },
    onError: (e) => toast.error(e instanceof ApiError && e.code === "portal_inactive" ? t("crm.portal.errors.portal_inactive") : t("common.error")),
  });
  const change = async (on: boolean) => {
    const ok = await confirm(
      on
        ? { title: t("crm.portal.company.openTitle", { name: client.name }), description: t("crm.portal.company.openText", { count: ready }), confirmLabel: t("crm.portal.company.open") }
        : { title: t("crm.portal.company.closeTitle", { name: client.name }), description: t("crm.portal.company.closeText"), confirmLabel: t("crm.portal.company.close"), destructive: true },
    );
    if (ok) set.mutate(on);
  };
  return (
    <div className={cn("rounded-xl border p-3", client.portalEnabled ? "border-emerald-500/40 bg-emerald-500/[0.06]" : "bg-background/30")}>
      <div className="flex items-start gap-3">
        <KeyRound className={cn("mt-0.5 size-4 shrink-0", client.portalEnabled ? "text-emerald-400" : "text-muted-foreground")} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("crm.portal.company.title")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {client.portalEnabled ? t("crm.portal.company.onText", { count: ready }) : t("crm.portal.company.offText", { count: ready })}
            {noEmail > 0 && <span className="text-amber-400"> {t("crm.portal.company.noEmail", { count: noEmail })}</span>}
          </p>
          {!client.portalEnabled && (
            <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox checked={welcome} onCheckedChange={(v) => setWelcome(v === true)} /> {t("crm.portal.company.sendWelcome")}
            </label>
          )}
        </div>
        {set.isPending ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : <Switch checked={client.portalEnabled} onCheckedChange={(v) => void change(v)} aria-label={t("crm.portal.company.title")} disabled={!client.active} />}
      </div>
    </div>
  );
}

/**
 * This client's own roles: the built-in ones (copied for the client, so changing
 * one changes nothing at another client) and the custom ones made for it.
 */
function ClientRolesPanel({ client, roles }: { client: ClientRef; roles: Role[] }) {
  const { t } = useTranslation();
  const can = useCan();
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState<Role | "new" | null>(null);
  return (
    <div className="rounded-xl border bg-card/40">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex flex-1 items-center gap-2 text-left">
          <ShieldCheck className="size-4 text-primary" />
          <span className="text-sm font-medium">{t("admin.clientAccess.rolesTitle", { name: client.name })}</span>
          <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", !open && "-rotate-90")} />
        </button>
        {can("admin.clients") && (
          <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
            <Plus className="size-3.5" /> {t("admin.clientAccess.newRole")}
          </Button>
        )}
      </div>
      {open && (
        <div className="space-y-2 border-t p-3">
          <p className="text-xs text-muted-foreground">{t("admin.clientAccess.rolesHint")}</p>
          <div className="grid gap-3 md:grid-cols-2">
            {roles.map((r) => (
              <RoleCard key={r.id} role={r} onEdit={() => setEditing(r)} />
            ))}
          </div>
        </div>
      )}
      <RoleDialog role={editing} roles={roles} clientId={client.id} onClose={() => setEditing(null)} />
    </div>
  );
}
function ClientUserRow({ u, role, portalOpen, onClick }: { u: AdminUser; role: Role | undefined; portalOpen: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  const roleName = useRoleName();
  const allowed = u.overrides.filter((o) => o.effect === "allow").length;
  const denied = u.overrides.filter((o) => o.effect === "deny").length;
  return (
    <button type="button" onClick={onClick} className={cn("group flex w-full items-center gap-3 rounded-xl border bg-card/60 p-3 text-left transition-colors hover:border-[color:var(--gold)]/40", !u.active && "opacity-60")}>
      <Avatar className="size-9">
        <AvatarFallback className="bg-muted text-xs font-semibold">{initials(u.name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{u.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {u.email}
          {u.lastLoginAt && <span> · {t("crm.portal.lastLogin", { when: relativeTime(u.lastLoginAt) })}</span>}
        </p>
      </div>
      <div className="hidden flex-wrap items-center justify-end gap-1.5 sm:flex">
        {role ? <Badge variant="secondary">{roleName(role)}</Badge> : <Badge variant="outline">{t("admin.users.noRole")}</Badge>}
        {(allowed > 0 || denied > 0) && (
          <Badge variant="outline" className="font-mono text-[10px]" title={t("admin.clientAccess.granular")}>
            {allowed > 0 && <span className="text-emerald-400">+{allowed}</span>}
            {allowed > 0 && denied > 0 && " "}
            {denied > 0 && <span className="text-red-400">−{denied}</span>}
          </Badge>
        )}
        {u.active && !portalOpen && <Badge variant="outline" className="text-muted-foreground">{t("crm.portal.ready")}</Badge>}
        {u.active && portalOpen && u.mustChangePassword && <Badge variant="outline" className="border-amber-500/40 text-amber-400">{t("crm.portal.pending")}</Badge>}
      </div>
      <div className="hidden md:block">
        <UserStatusBadges u={u} />
      </div>
      <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

/**
 * One client's people and rights: the company switch, its users with their role
 * and granular rights (open one to change them), add a user, and what each role
 * allows. The same panel is in Admin › Clients and on the client's page.
 */
export function ClientUsersPanel({ client }: { client: ClientRef }) {
  const { t } = useTranslation();
  const can = useCan();
  const { data: users = [], isLoading } = useClientUsers(client.id);
  const { data: roles = [] } = useClientRoles(client.id);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const shown = users.filter((u) => `${u.name} ${u.email} ${u.title ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()));
  const ready = users.filter((u) => u.active).length;
  return (
    <div className="space-y-4">
      {can("admin.clients") && <CompanyPortalSwitch client={client} ready={ready} />}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-48 max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("common.search")} className="pl-9" />
        </div>
        <span className="text-xs text-muted-foreground">{t("admin.clientAccess.users", { count: users.length })}</span>
        {can("admin.clients") && (
          <Button onClick={() => setCreating(true)} disabled={!client.active} className="ml-auto bg-grad-gold font-semibold text-[#1a1204] glow-gold hover:brightness-105">
            <UserPlus className="size-4" /> {t("admin.clientAccess.add")}
          </Button>
        )}
      </div>
      <div className="space-y-2">
        {isLoading ? (
          [0, 1].map((i) => <Skeleton key={i} className="h-16 rounded-xl" />)
        ) : shown.length ? (
          shown.map((u) => <ClientUserRow key={u.id} u={u} role={roles.find((r) => r.id === u.roleId)} portalOpen={client.portalEnabled} onClick={() => setOpenId(u.id)} />)
        ) : (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t("admin.clientAccess.none")}</p>
        )}
      </div>
      <ClientRolesPanel client={client} roles={roles} />
      <NewUserDialog open={creating} onOpenChange={setCreating} kind="client" clientId={client.id} />
      <UserSheet user={users.find((u) => u.id === openId) ?? null} onClose={() => setOpenId(null)} />
    </div>
  );
}

/** Admin › Roles and users › Clients: pick a client, see and manage its users, roles and rights. */
export function ClientAccessSection() {
  const { t } = useTranslation();
  const { data: clients = [], isLoading } = useClients();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const list = clients.filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase()));
  const client = clients.find((c) => c.id === selected) ?? null;
  return (
    <div>
      <SectionHeader title={t("admin.clientAccess.title")} subtitle={t("admin.clientAccess.subtitle")} />
      <div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("admin.clientAccess.findClient")} className="pl-9" />
          </div>
          <div className="max-h-[60vh] space-y-1 overflow-y-auto pr-1">
            {isLoading
              ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-12 rounded-xl" />)
              : list.map((c) => {
                  const open = c.portalEnabled;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setSelected(c.id)}
                      className={cn("flex w-full items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors hover:border-[color:var(--gold)]/40", selected === c.id ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10" : "bg-card/50", !c.active && "opacity-60")}
                    >
                      <Building2 className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{c.name}</span>
                        <span className="block text-[11px] text-muted-foreground">{t("admin.clientAccess.users", { count: c.userCount })}</span>
                      </span>
                      <span className={cn("size-2 shrink-0 rounded-full", open ? "bg-emerald-500" : "bg-muted-foreground/40")} title={open ? t("admin.clientAccess.portalOpen") : t("admin.clientAccess.portalClosed")} />
                    </button>
                  );
                })}
          </div>
        </aside>
        <section className="min-w-0">
          {client ? (
            <>
              <h3 className="mb-3 flex items-center gap-2 font-display text-lg font-bold">
                <Building2 className="size-5 text-primary" /> {client.name}
              </h3>
              <ClientUsersPanel client={{ id: client.id, name: client.name, active: client.active, portalEnabled: client.portalEnabled }} />
            </>
          ) : (
            <p className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">{t("admin.clientAccess.pick")}</p>
          )}
        </section>
      </div>
    </div>
  );
}
