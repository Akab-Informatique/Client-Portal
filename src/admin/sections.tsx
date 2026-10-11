import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Building2, ChevronRight, Loader2, Lock, Pencil, Plus, Search, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { dateTime, relativeTime } from "@/lib/format";
import type { AdminUser, Client, Role } from "@/lib/types";
import { cn, initials } from "@/lib/utils";
import { permissionsFor, type Audience } from "@shared/permissions";
import { useAdminError, useAudit, useClients, useClientUsers, useRoleDescription, useRoleName, useRoles, useStaff } from "./hooks";
import { PermissionMatrix } from "./PermissionMatrix";
import { NewUserDialog, UserSheet, UserStatusBadges } from "./UserPanels";
import { useOneShotParam } from "@/lib/useDeepLink";
import { useConfirm } from "@/components/ConfirmDialog";

export function SectionHeader({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-2xl font-bold">{title}</h2>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
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
export function ClientsSection() {
  const { t } = useTranslation();
  const { data, isLoading } = useClients();
  const [q, setQ] = useState("");
  const linkedClient = useOneShotParam("client");
  const linkedUser = useOneShotParam("user");
  const [selectedId, setSelectedId] = useState<string | null>(linkedClient);
  const [creating, setCreating] = useState(false);
  const list = (data ?? []).filter((c) => `${c.name} ${c.code ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  const selected = (data ?? []).find((c) => c.id === selectedId) ?? null;
  useEffect(() => {
    if (!selectedId && data?.length) setSelectedId(data[0].id);
  }, [data, selectedId]);

  return (
    <div>
      <SectionHeader
        title={t("admin.clients.title")}
        subtitle={t("admin.clients.subtitle")}
        action={
          <Button onClick={() => setCreating(true)} className="bg-grad-gold font-semibold text-[#1a1204] glow-gold hover:brightness-105">
            <Plus className="size-4" /> {t("admin.clients.add")}
          </Button>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        <div className="space-y-3">
          <SearchBox value={q} onChange={setQ} />
          <ul className="space-y-1.5">
            {isLoading
              ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-14 rounded-xl" />)
              : list.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(c.id)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors",
                        selectedId === c.id ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10" : "bg-card/60 hover:bg-accent/50",
                        !c.active && "opacity-60",
                      )}
                    >
                      <span className="flex size-9 items-center justify-center rounded-lg bg-muted font-mono text-[11px] font-semibold">{c.code?.slice(0, 4) || <Building2 className="size-4" />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{c.name}</span>
                        <span className="block text-xs text-muted-foreground">{t("admin.clients.usersCount", { count: c.userCount })}</span>
                      </span>
                    </button>
                  </li>
                ))}
          </ul>
        </div>
        <div>{selected ? <ClientDetail key={selected.id} client={selected} openUser={selected.id === linkedClient ? linkedUser : null} /> : <p className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">{t("admin.clients.select")}</p>}</div>
      </div>
      <ClientFormDialog open={creating} onOpenChange={setCreating} onCreated={(c) => setSelectedId(c.id)} />
    </div>
  );
}

type ClientForm = { name: string; code: string; email: string; phone: string; address: string; notes: string };
const clientForm = (c?: Client): ClientForm => ({
  name: c?.name ?? "",
  code: c?.code ?? "",
  email: c?.email ?? "",
  phone: c?.phone ?? "",
  address: c?.address ?? "",
  notes: c?.notes ?? "",
});

function ClientFields({ form, setForm }: { form: ClientForm; setForm: (f: ClientForm) => void }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label>{t("common.name")}</Label>
        <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <div className="space-y-2">
        <Label>{t("admin.clients.code")}</Label>
        <Input value={form.code} maxLength={20} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} className="font-mono" />
      </div>
      <div className="space-y-2">
        <Label>{t("common.email")}</Label>
        <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      </div>
      <div className="space-y-2">
        <Label>{t("common.phone")}</Label>
        <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label>{t("admin.clients.address")}</Label>
        <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label>{t("admin.clients.notes")}</Label>
        <Textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </div>
    </div>
  );
}

function ClientFormDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (c: Client) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const errText = useAdminError();
  const [form, setForm] = useState(clientForm());
  useEffect(() => {
    if (open) setForm(clientForm());
  }, [open]);
  const create = useMutation({
    mutationFn: () => api.post<Client>("/admin/clients", form),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      onCreated(c);
      onOpenChange(false);
    },
    onError: (e) => toast.error(errText(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("admin.clients.add")}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            create.mutate();
          }}
          className="space-y-4"
        >
          <ClientFields form={form} setForm={setForm} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={create.isPending}>{create.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.create")}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ClientDetail({ client, openUser }: { client: Client; openUser?: string | null }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const errText = useAdminError();
  const { data: users, isLoading } = useClientUsers(client.id);
  const { data: roles = [] } = useRoles();
  const [form, setForm] = useState(clientForm(client));
  const [openId, setOpenId] = useState<string | null>(openUser ?? null);
  const [creating, setCreating] = useState(false);
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch<Client>(`/admin/clients/${client.id}`, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      toast.success(t("common.saved"));
    },
    onError: (e) => toast.error(errText(e)),
  });
  return (
    <motion.div initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} className="space-y-6">
      <div className="rounded-2xl border bg-card/60 p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-xl bg-grad-gold text-[#1a1204]">
              <Building2 className="size-5" />
            </span>
            <div>
              <h3 className="text-lg font-semibold">{client.name}</h3>
              <p className="text-xs text-muted-foreground">{t("admin.clients.details")}</p>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm" title={t("admin.clients.deactivateHint")}>
            <span className={client.active ? "text-success" : "text-muted-foreground"}>{client.active ? t("common.active") : t("common.inactive")}</span>
            <Switch checked={client.active} onCheckedChange={(v) => save.mutate({ active: v })} />
          </label>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(form);
          }}
          className="space-y-4"
        >
          <ClientFields form={form} setForm={setForm} />
          <div className="flex justify-end">
            <Button type="submit" disabled={save.isPending}>{save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}</Button>
          </div>
        </form>
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h4 className="flex items-center gap-2 font-display font-semibold">
            <Users className="size-4 text-primary" /> {t("admin.clients.users")}
          </h4>
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <UserPlus className="size-4" /> {t("admin.clients.addUser")}
          </Button>
        </div>
        <div className="space-y-2">
          {isLoading ? (
            <Skeleton className="h-16 rounded-xl" />
          ) : users?.length ? (
            users.map((u) => <UserRow key={u.id} u={u} roles={roles} onClick={() => setOpenId(u.id)} />)
          ) : (
            <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t("admin.clients.noUsers")}</p>
          )}
        </div>
      </div>
      <NewUserDialog open={creating} onOpenChange={setCreating} kind="client" clientId={client.id} />
      <UserSheet user={(users ?? []).find((u) => u.id === openId) ?? null} onClose={() => setOpenId(null)} />
    </motion.div>
  );
}

// ── Roles ────────────────────────────────────────────────────────────────────
export function RolesSection() {
  const { t } = useTranslation();
  const { data: roles = [], isLoading } = useRoles();
  const [editing, setEditing] = useState<Role | "new" | null>(null);
  const groups: { audience: Audience; title: string }[] = [
    { audience: "staff", title: t("admin.roles.staffRoles") },
    { audience: "client", title: t("admin.roles.clientRoles") },
  ];
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
      <div className="space-y-8">
        {groups.map((g) => (
          <div key={g.audience}>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{g.title}</h3>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {isLoading
                ? [0, 1].map((i) => <Skeleton key={i} className="h-32 rounded-2xl" />)
                : roles.filter((r) => r.audience === g.audience).map((r) => <RoleCard key={r.id} role={r} onEdit={() => setEditing(r)} />)}
            </div>
          </div>
        ))}
      </div>
      <RoleDialog role={editing} roles={roles} onClose={() => setEditing(null)} />
    </div>
  );
}

function RoleCard({ role, onEdit }: { role: Role; onEdit: () => void }) {
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

function RoleDialog({ role, roles, onClose }: { role: Role | "new" | null; roles: Role[]; onClose: () => void }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const errText = useAdminError();
  const roleName = useRoleName();
  const isNew = role === "new";
  const existing = role && role !== "new" ? role : null;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [audience, setAudience] = useState<Audience>("staff");
  const [permissions, setPermissions] = useState<string[]>([]);
  useEffect(() => {
    if (!role) return;
    if (role === "new") {
      setName("");
      setDescription("");
      setAudience("staff");
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
        ? api.post<Role>("/admin/roles", { name, description, audience, permissions })
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
            <div className="space-y-2">
              <Label>{t("admin.roles.audience")}</Label>
              <Select
                value={audience}
                disabled={!isNew}
                onValueChange={(v) => {
                  setAudience(v as Audience);
                  setPermissions([]);
                }}
              >
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="staff">{t("admin.roles.audienceStaff")}</SelectItem>
                  <SelectItem value="client">{t("admin.roles.audienceClient")}</SelectItem>
                </SelectContent>
              </Select>
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
