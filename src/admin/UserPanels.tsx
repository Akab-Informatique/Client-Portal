import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Copy, KeyRound, Loader2, LockOpen, ShieldCheck, ShieldOff, UserRoundX, UserRoundCheck, MailCheck } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { dateTime } from "@/lib/format";
import type { AdminUser, Role } from "@/lib/types";
import { cn, initials } from "@/lib/utils";
import type { Audience } from "@shared/permissions";
import { useAdminError, useRoleName, useRoles } from "./hooks";
import { OverridesEditor, type OverrideMap } from "./PermissionMatrix";
import { useConfirm } from "@/components/ConfirmDialog";
import { O365Panel } from "./CalendarLinks";

function invalidateUsers(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ["admin"] });
  void qc.invalidateQueries({ queryKey: ["auth"] });
}

export function UserStatusBadges({ u }: { u: AdminUser }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1">
      {!u.active && <Badge variant="outline" className="text-muted-foreground">{t("common.inactive")}</Badge>}
      {u.locked && <Badge variant="destructive">{t("admin.users.locked")}</Badge>}
      {u.mfaEnabled ? (
        <Badge variant="outline" className="gap-1 border-success/40 text-success"><ShieldCheck className="size-3" /> MFA</Badge>
      ) : (
        <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-500"><ShieldOff className="size-3" /> MFA</Badge>
      )}
    </div>
  );
}

function RoleSelect({ audience, value, onChange, roles }: { audience: Audience; value: string | null; onChange: (v: string | null) => void; roles: Role[] }) {
  const { t } = useTranslation();
  const roleName = useRoleName();
  return (
    <Select value={value ?? "none"} onValueChange={(v) => onChange(v === "none" ? null : v)}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">{t("admin.users.noRole")}</SelectItem>
        {roles
          .filter((r) => r.audience === audience)
          .map((r) => (
            <SelectItem key={r.id} value={r.id}>
              {roleName(r)}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

// ── Temporary password reveal ────────────────────────────────────────────────
export function TempPasswordDialog({ password, email, onClose }: { password: string | null; email?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open={Boolean(password)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-5 text-primary" /> {t("admin.users.tempPassword")}
          </DialogTitle>
          <DialogDescription>{t("admin.users.tempPasswordText")}</DialogDescription>
        </DialogHeader>
        {email && <p className="font-mono text-xs text-muted-foreground">{email}</p>}
        <div className="flex items-center gap-2 rounded-xl border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 p-3">
          <code className="flex-1 select-all font-mono text-lg tracking-wider">{password}</code>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(password ?? "");
              setCopied(true);
            }}
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />} {copied ? t("common.copied") : t("common.copy")}
          </Button>
        </div>
        <div className="flex justify-end">
          <Button onClick={onClose}>{t("common.close")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Create user ──────────────────────────────────────────────────────────────
export function NewUserDialog({
  open,
  onOpenChange,
  kind,
  clientId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  kind: Audience;
  clientId?: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const errText = useAdminError();
  const { data: roles = [] } = useRoles();
  const defaultRole = roles.find((r) => r.slug === (kind === "staff" ? "technician" : "client-user"))?.id ?? null;
  const empty = { email: "", name: "", title: "", phone: "", roleId: defaultRole, locale: "fr" as "fr" | "en", notifyEmail: true, sendWelcome: true };
  const [form, setForm] = useState(empty);
  const [temp, setTemp] = useState<{ password: string; email: string } | null>(null);
  useEffect(() => {
    if (open) setForm({ ...empty, roleId: defaultRole });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultRole]);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ user: AdminUser; temporaryPassword: string; welcomeSent: boolean }>(
        kind === "staff" ? "/admin/staff" : `/admin/clients/${clientId}/users`,
        form,
      ),
    onSuccess: (r) => {
      invalidateUsers(qc);
      onOpenChange(false);
      // With the welcome email the person chooses their own password; otherwise show the temporary one
      if (r.welcomeSent) toast.success(t("admin.users.welcomeSent", { email: r.user.email }));
      else {
        if (form.sendWelcome) toast.error(t("admin.users.welcomeFailed"));
        setTemp({ password: r.temporaryPassword, email: r.user.email });
      }
    },
    onError: (e) => toast.error(errText(e)),
  });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{kind === "staff" ? t("admin.users.newStaff") : t("admin.users.newClientUser")}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              create.mutate();
            }}
            className="space-y-4"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t("common.name")}</Label>
                <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>{t("common.email")}</Label>
                <Input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>{t("common.title")}</Label>
                <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>{t("common.phone")}</Label>
                <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>{t("common.role")}</Label>
                <RoleSelect audience={kind} roles={roles} value={form.roleId} onChange={(v) => setForm({ ...form, roleId: v })} />
              </div>
              <div className="space-y-2">
                <Label>{t("common.language")}</Label>
                <Select value={form.locale} onValueChange={(v) => setForm({ ...form, locale: v as "fr" | "en" })}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fr">Français</SelectItem>
                    <SelectItem value="en">English</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {kind === "client" && (
              <label className="flex items-center justify-between gap-4 rounded-lg border p-3 text-sm">
                {t("admin.users.notify")}
                <Switch checked={form.notifyEmail} onCheckedChange={(v) => setForm({ ...form, notifyEmail: v })} />
              </label>
            )}
            <label className="flex items-center justify-between gap-4 rounded-lg border p-3 text-sm">
              <span>
                <span className="block font-medium">{t("admin.users.sendWelcome")}</span>
                <span className="block text-xs text-muted-foreground">{t("admin.users.sendWelcomeText")}</span>
              </span>
              <Switch checked={form.sendWelcome} onCheckedChange={(v) => setForm({ ...form, sendWelcome: v })} />
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.create")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <TempPasswordDialog password={temp?.password ?? null} email={temp?.email} onClose={() => setTemp(null)} />
    </>
  );
}

// ── User detail (profile / access / security) ────────────────────────────────
export function UserSheet({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const { t } = useTranslation();
  const roleName = useRoleName();
  const { data: roles = [] } = useRoles();
  const role = roles.find((r) => r.id === user?.roleId);
  return (
    <Sheet open={Boolean(user)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl">
        {user && (
          <>
            <SheetHeader className="border-b p-6">
              <div className="flex items-center gap-4">
                <Avatar className="size-12 ring-1 ring-[color:var(--gold)]/40">
                  <AvatarFallback className="bg-grad-gold font-bold text-[#1a1204]">{initials(user.name)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <SheetTitle className="truncate font-display text-xl">{user.name}</SheetTitle>
                  <SheetDescription className="truncate">{user.email}</SheetDescription>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {role && <Badge variant="secondary">{roleName(role)}</Badge>}
                    <UserStatusBadges u={user} />
                  </div>
                </div>
              </div>
            </SheetHeader>
            <Tabs defaultValue="profile" className="p-6">
              <TabsList className="w-full">
                <TabsTrigger value="profile">{t("admin.users.profile")}</TabsTrigger>
                <TabsTrigger value="access">{t("admin.users.access")}</TabsTrigger>
                <TabsTrigger value="security">{t("admin.users.security")}</TabsTrigger>
              </TabsList>
              <TabsContent value="profile" className="pt-4">
                <ProfileTab key={user.id} user={user} />
              </TabsContent>
              <TabsContent value="access" className="pt-4">
                <AccessTab key={user.id} user={user} roles={roles} />
              </TabsContent>
              <TabsContent value="security" className="pt-4">
                <SecurityTab user={user} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function ProfileTab({ user }: { user: AdminUser }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const errText = useAdminError();
  const me = useMe();
  const [form, setForm] = useState({
    name: user.name,
    email: user.email,
    title: user.title ?? "",
    phone: user.phone ?? "",
    mobile: user.mobile ?? "",
    locale: user.locale,
    notifyEmail: user.notifyEmail,
  });
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch<AdminUser>(`/admin/users/${user.id}`, patch),
    onSuccess: () => {
      invalidateUsers(qc);
      toast.success(t("common.saved"));
    },
    onError: (e) => toast.error(errText(e)),
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(form);
      }}
      className="space-y-4"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2 sm:col-span-2">
          <Label>{t("common.name")}</Label>
          <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label>{t("common.email")}</Label>
          <Input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div className="space-y-2">
          <Label>{t("common.title")}</Label>
          <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </div>
        {/* technicians: the cell phone only */}
        {user.kind === "client" && (
          <div className="space-y-2">
            <Label>{t("common.phone")}</Label>
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
        )}
        {user.kind === "staff" && (
          <div className="space-y-2">
            <Label>{t("profile.mobile")}</Label>
            <Input type="tel" value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} placeholder="+1 450 555-0123" />
          </div>
        )}
        <div className="space-y-2">
          <Label>{t("common.language")}</Label>
          <Select value={form.locale} onValueChange={(v) => setForm({ ...form, locale: v as "fr" | "en" })}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="fr">Français</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {user.kind === "staff" && can("admin.o365") && <O365Panel userId={user.id} />}
      {user.kind === "client" && (
        <label className="flex items-center justify-between gap-4 rounded-lg border p-3 text-sm">
          {t("admin.users.notify")}
          <Switch checked={form.notifyEmail} onCheckedChange={(v) => setForm({ ...form, notifyEmail: v })} />
        </label>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
        {user.id !== me.id ? (
          <Button
            type="button"
            variant="outline"
            className={cn(user.active ? "text-destructive hover:text-destructive" : "text-success hover:text-success")}
            onClick={() => save.mutate({ active: !user.active })}
          >
            {user.active ? <UserRoundX className="size-4" /> : <UserRoundCheck className="size-4" />}
            {user.active ? t("admin.users.deactivate") : t("admin.users.activate")}
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
        </Button>
      </div>
    </form>
  );
}

function AccessTab({ user, roles }: { user: AdminUser; roles: Role[] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const can = useCan();
  const errText = useAdminError();
  const [roleId, setRoleId] = useState<string | null>(user.roleId);
  const initial = useMemo(() => Object.fromEntries(user.overrides.map((o) => [o.permission, o.effect])) as OverrideMap, [user.overrides]);
  const [overrides, setOverrides] = useState<OverrideMap>(initial);
  const role = roles.find((r) => r.id === roleId);
  const canOverride = can("admin.roles");

  const save = useMutation({
    mutationFn: async () => {
      if (roleId !== user.roleId) await api.patch(`/admin/users/${user.id}`, { roleId });
      if (canOverride) {
        const list = Object.entries(overrides)
          .filter(([, v]) => v)
          .map(([key, effect]) => ({ key, effect }));
        await api.put(`/admin/users/${user.id}/permissions`, { overrides: list });
      }
    },
    onSuccess: () => {
      invalidateUsers(qc);
      toast.success(t("common.saved"));
    },
    onError: (e) => toast.error(errText(e)),
  });

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label>{t("common.role")}</Label>
        <RoleSelect audience={user.kind} roles={roles} value={roleId} onChange={setRoleId} />
      </div>
      <div>
        <p className="font-display text-sm font-semibold">{t("admin.access.overridesTitle")}</p>
        <p className="mb-3 text-xs text-muted-foreground">{canOverride ? t("admin.access.overridesText") : t("admin.access.needRolesPermission")}</p>
        <OverridesEditor audience={user.kind} rolePermissions={role?.permissions ?? []} value={overrides} onChange={setOverrides} disabled={!canOverride} />
      </div>
      <div className="flex justify-end border-t pt-4">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("admin.access.saveAccess")}
        </Button>
      </div>
    </div>
  );
}

function SecurityTab({ user }: { user: AdminUser }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const errText = useAdminError();
  const [temp, setTemp] = useState<string | null>(null);
  const resetPw = useMutation({
    mutationFn: () => api.post<{ temporaryPassword: string }>(`/admin/users/${user.id}/reset-password`),
    onSuccess: (r) => {
      invalidateUsers(qc);
      setTemp(r.temporaryPassword);
    },
    onError: (e) => toast.error(errText(e)),
  });
  const sendLink = useMutation({
    mutationFn: () => api.post(`/admin/users/${user.id}/send-reset-link`),
    onSuccess: () => toast.success(t("admin.users.resetLinkSent", { email: user.email })),
    onError: (e) => toast.error(errText(e)),
  });
  const resetMfa = useMutation({
    mutationFn: () => api.post(`/admin/users/${user.id}/reset-mfa`),
    onSuccess: () => {
      invalidateUsers(qc);
      toast.success(t("admin.users.mfaReset"));
    },
    onError: (e) => toast.error(errText(e)),
  });
  const unlock = useMutation({
    mutationFn: () => api.patch(`/admin/users/${user.id}`, { unlock: true }),
    onSuccess: () => invalidateUsers(qc),
    onError: (e) => toast.error(errText(e)),
  });
  const rows = [
    { label: t("admin.users.lastLogin"), value: user.lastLoginAt ? dateTime(user.lastLoginAt) : t("admin.users.never") },
    { label: "MFA", value: user.mfaEnabled ? t("admin.users.mfaOn") : t("admin.users.mfaOff") },
  ];
  return (
    <div className="space-y-4">
      <dl className="divide-y rounded-xl border">
        {rows.map((r) => (
          <div key={r.label} className="flex justify-between px-4 py-3 text-sm">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-2">
        <Button variant="outline" className="justify-start" disabled={!user.active || sendLink.isPending} onClick={() => sendLink.mutate()}>
          {sendLink.isPending ? <Loader2 className="size-4 animate-spin" /> : <MailCheck className="size-4" />} {t("admin.users.sendResetLink")}
        </Button>
        <Button variant="outline" className="justify-start" onClick={() => void confirm({ title: t("admin.users.resetPasswordConfirm"), destructive: true }).then((ok) => ok && resetPw.mutate())}>
          <KeyRound className="size-4" /> {t("admin.users.resetPassword")}
        </Button>
        <Button variant="outline" className="justify-start" disabled={!user.mfaEnabled} onClick={() => void confirm({ title: t("admin.users.resetMfaConfirm"), destructive: true }).then((ok) => ok && resetMfa.mutate())}>
          <ShieldOff className="size-4" /> {t("admin.users.resetMfa")}
        </Button>
        {user.locked && (
          <Button variant="outline" className="justify-start" onClick={() => unlock.mutate()}>
            <LockOpen className="size-4" /> {t("admin.users.unlock")}
          </Button>
        )}
      </div>
      <TempPasswordDialog password={temp} email={user.email} onClose={() => setTemp(null)} />
    </div>
  );
}
