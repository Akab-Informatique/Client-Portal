import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  Receipt,
  Shield,
  Trash2,
  Users,
} from "lucide-react";
import {
  createClientUserRole,
  deleteClientRole,
  ensureAllClientCompanyRoles,
  ensureClientUserRolesForCompany,
  listClientRolesForCompany,
  listMembersForRole,
  updateClientRole,
} from "@/lib/client-roles";
import {
  CLIENT_PERMISSIONS,
  CLIENT_PERMISSION_META,
  STANDARD_CLIENT_PERMISSIONS,
  SYSTEM_CLIENT_ROLE_SLUGS,
  countClientGranted,
  parseClientPermissions,
  type ClientPermission,
  type ClientPermissionMap,
} from "@/lib/client-permissions";
import type { ClientRole, ClientRoleMember, Company } from "@/lib/types";
import { db, dbReady, schema } from "@/db";
import { useLocale } from "@/hooks/use-locale";
import { BlurFade } from "@/components/ui/blur-fade";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/EmptyState";

/**
 * Manage client USER roles — each client company has its own set.
 * Opened from Settings or deep-linked with ?company=<id>.
 */
export function ClientRolesPage() {
  const { t } = useLocale();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<number | null>(null);
  const [roles, setRoles] = useState<ClientRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ClientRole | null>(null);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [perms, setPerms] = useState<ClientPermissionMap>({
    ...STANDARD_CLIENT_PERMISSIONS,
  });
  /** Role ids with members panel expanded */
  const [expandedMembers, setExpandedMembers] = useState<
    Record<number, boolean>
  >({});
  const [membersByRole, setMembersByRole] = useState<
    Record<number, ClientRoleMember[]>
  >({});
  const [membersLoading, setMembersLoading] = useState<Record<number, boolean>>(
    {},
  );

  const selectedCompany = useMemo(
    () => companies.find((c) => c.id === companyId) ?? null,
    [companies, companyId],
  );

  const toggleMembers = async (roleId: number) => {
    const open = !expandedMembers[roleId];
    setExpandedMembers((prev) => ({ ...prev, [roleId]: open }));
    if (!open) return;
    if (membersByRole[roleId]) return;
    setMembersLoading((prev) => ({ ...prev, [roleId]: true }));
    try {
      const list = await listMembersForRole(roleId);
      setMembersByRole((prev) => ({ ...prev, [roleId]: list }));
    } catch {
      setMembersByRole((prev) => ({ ...prev, [roleId]: [] }));
    } finally {
      setMembersLoading((prev) => ({ ...prev, [roleId]: false }));
    }
  };

  const loadCompanies = async () => {
    await dbReady;
    try {
      await ensureAllClientCompanyRoles();
    } catch (e) {
      console.warn("[akab] ensureAllClientCompanyRoles", e);
    }
    const rows = (await db.select().from(schema.companies)) as Company[];
    const clients = rows
      .filter((c) => c.type === "client" && c.active)
      .sort((a, b) => a.name.localeCompare(b.name));
    setCompanies(clients);

    // Prefer ?company= from URL
    let preferred: number | null = null;
    try {
      const q = new URLSearchParams(window.location.search).get("company");
      if (q) {
        const n = Number(q);
        if (clients.some((c) => c.id === n)) preferred = n;
      }
    } catch {
      /* ignore */
    }
    setCompanyId((prev) => {
      if (preferred != null) return preferred;
      if (prev != null && clients.some((c) => c.id === prev)) return prev;
      return clients[0]?.id ?? null;
    });
  };

  const loadRoles = async (cid: number) => {
    setLoading(true);
    setError(null);
    setExpandedMembers({});
    setMembersByRole({});
    try {
      await ensureClientUserRolesForCompany(cid);
      setRoles(await listClientRolesForCompany(cid));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("clientRoles.loadFailed"));
      setRoles([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadCompanies();
  }, []);

  useEffect(() => {
    if (companyId != null) void loadRoles(companyId);
    else {
      setRoles([]);
      setLoading(false);
    }
  }, [companyId]);

  const openCreate = () => {
    setEditing(null);
    setName("");
    setDescription("");
    setPerms({ ...STANDARD_CLIENT_PERMISSIONS });
    setError(null);
    setOpen(true);
  };

  const openEdit = (role: ClientRole) => {
    setEditing(role);
    setName(role.name);
    setDescription(role.description ?? "");
    setPerms(parseClientPermissions(role.permissions));
    setError(null);
    setOpen(true);
  };

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    if (companyId == null) return;
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        await updateClientRole(editing.id, {
          name,
          description,
          permissions: perms,
        });
      } else {
        await createClientUserRole({
          companyId,
          name,
          description,
          permissions: perms,
        });
      }
      setOpen(false);
      await loadRoles(companyId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("clientRoles.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (role: ClientRole) => {
    if (companyId == null) return;
    if (role.is_system) return;
    if (!window.confirm(t("clientRoles.deleteConfirm", { name: role.name }))) {
      return;
    }
    setError(null);
    try {
      await deleteClientRole(role.id);
      await loadRoles(companyId);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("clientRoles.deleteFailed"),
      );
    }
  };

  if (!loading && companies.length === 0) {
    return (
      <EmptyState
        icon={<Building2 className="size-5" />}
        title={t("clientRoles.noClientsTitle")}
        description={t("clientRoles.noClientsDesc")}
        actionLabel={t("nav.clients")}
        onAction={() => {
          window.location.href = "/admin/clients";
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <BlurFade delay={0.04}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-bold tracking-tight">
                {t("clientRoles.title")}
              </h2>
              <Badge
                variant="outline"
                className="border-primary/40 bg-primary/10 text-primary"
              >
                {t("clientRoles.badge")}
              </Badge>
            </div>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {t("clientRoles.subtitle")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-56">
              <Select
                value={companyId != null ? String(companyId) : undefined}
                onValueChange={(v) => setCompanyId(Number(v))}
              >
                <SelectTrigger aria-label={t("clientRoles.pickClient")}>
                  <SelectValue placeholder={t("clientRoles.pickClient")} />
                </SelectTrigger>
                <SelectContent>
                  {companies.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              className="gap-1.5"
              disabled={companyId == null}
              onClick={openCreate}
            >
              <Plus className="size-4" />
              {t("clientRoles.add")}
            </Button>
          </div>
        </div>
      </BlurFade>

      {selectedCompany && (
        <BlurFade delay={0.06}>
          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
                  <Building2 className="size-5" />
                </div>
                <div>
                  <p className="font-semibold">{selectedCompany.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("clientRoles.scopedHint")}
                  </p>
                </div>
              </div>
              <Button asChild variant="outline" size="sm">
                <Link to="/admin/clients">{t("clientRoles.openClients")}</Link>
              </Button>
            </CardContent>
          </Card>
        </BlurFade>
      )}

      {error && (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <BlurFade delay={0.08}>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("common.loading")}
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {roles.map((role) => {
              const p = parseClientPermissions(role.permissions);
              const isStandard =
                role.slug === SYSTEM_CLIENT_ROLE_SLUGS.standard;
              const membersOpen = !!expandedMembers[role.id];
              const members = membersByRole[role.id];
              const loadingMembers = !!membersLoading[role.id];
              return (
                <Card key={role.id}>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                          <Shield className="size-5" />
                        </div>
                        <div>
                          <CardTitle className="text-base">{role.name}</CardTitle>
                          <CardDescription className="mt-0.5">
                            {role.description || t("clientRoles.noDescription")}
                          </CardDescription>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {isStandard && (
                          <Badge
                            variant="outline"
                            className="border-primary/40 bg-primary/10 text-[10px] text-primary"
                          >
                            {t("clientRoles.coreBadge")}
                          </Badge>
                        )}
                        {role.is_system && !isStandard && (
                          <Badge variant="outline" className="text-[10px]">
                            {t("clientRoles.builtIn")}
                          </Badge>
                        )}
                        {!isStandard && (
                          <Badge variant="outline" className="text-[10px]">
                            {t("clientRoles.additionalBadge")}
                          </Badge>
                        )}
                        {countClientGranted(p) > 0 && (
                          <Badge
                            variant="outline"
                            className="gap-1 border-primary/40 bg-primary/10 text-[10px] text-primary"
                          >
                            <Receipt className="size-3" />
                            {t("clientRoles.accessCount", {
                              count: String(countClientGranted(p)),
                            })}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        onClick={() => void toggleMembers(role.id)}
                      >
                        {membersOpen ? (
                          <ChevronDown className="size-3.5" />
                        ) : (
                          <ChevronRight className="size-3.5" />
                        )}
                        <Users className="size-3.5" />
                        {membersOpen
                          ? t("clientRoles.hideMembers")
                          : t("clientRoles.showMembers")}
                        {members && (
                          <span className="tabular-nums text-muted-foreground">
                            ({members.length})
                          </span>
                        )}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => openEdit(role)}
                      >
                        {t("common.edit")}
                      </Button>
                      {!role.is_system && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => void onDelete(role)}
                        >
                          <Trash2 className="size-3.5" />
                          {t("common.delete")}
                        </Button>
                      )}
                    </div>
                    {membersOpen && (
                      <div className="rounded-lg border border-border bg-muted/20 p-3">
                        <p className="mb-2 text-xs font-medium text-muted-foreground">
                          {t("clientRoles.membersTitle")}
                        </p>
                        {loadingMembers ? (
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Loader2 className="size-3.5 animate-spin" />
                            {t("common.loading")}
                          </div>
                        ) : !members || members.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            {t("clientRoles.membersEmpty")}
                          </p>
                        ) : (
                          <ul className="divide-y divide-border">
                            {members.map((m) => (
                              <li
                                key={m.user_id}
                                className="flex items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
                              >
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium">
                                    {m.name}
                                  </p>
                                  <p className="truncate text-xs text-muted-foreground">
                                    {m.email}
                                  </p>
                                </div>
                                <Badge
                                  variant="outline"
                                  className={
                                    m.active
                                      ? "shrink-0 border-primary/40 bg-primary/10 text-[10px] text-primary"
                                      : "shrink-0 text-[10px]"
                                  }
                                >
                                  {m.active
                                    ? t("common.active")
                                    : t("common.inactive")}
                                </Badge>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </BlurFade>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[92vh] w-[min(96vw,40rem)] max-w-xl flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
          <DialogHeader className="shrink-0 space-y-1.5 border-b border-border px-6 py-4 text-left">
            <DialogTitle>
              {editing
                ? editing.slug === SYSTEM_CLIENT_ROLE_SLUGS.standard
                  ? t("clientRoles.editCoreTitle")
                  : t("clientRoles.editTitle")
                : t("clientRoles.addTitle")}
            </DialogTitle>
            <DialogDescription>
              {editing?.slug === SYSTEM_CLIENT_ROLE_SLUGS.standard
                ? t("clientRoles.editCoreDesc")
                : selectedCompany
                  ? t("clientRoles.dialogDesc", { name: selectedCompany.name })
                  : t("clientRoles.dialogDescGeneric")}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={onSave} className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
              <div className="space-y-2">
                <Label htmlFor="cr-name">{t("common.name")}</Label>
                <Input
                  id="cr-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
                {editing?.slug === SYSTEM_CLIENT_ROLE_SLUGS.standard && (
                  <p className="text-xs text-muted-foreground">
                    {t("clientRoles.coreNameHint")}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="cr-desc">{t("common.description")}</Label>
                <Textarea
                  id="cr-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">
                  {t("clientRoles.permissions")}
                </p>
                {editing?.slug === SYSTEM_CLIENT_ROLE_SLUGS.standard && (
                  <p className="text-xs text-muted-foreground">
                    {t("clientRoles.corePermsHint")}
                  </p>
                )}
                <div className="grid gap-2 sm:grid-cols-2">
                  {CLIENT_PERMISSIONS.map((key) => {
                    const meta = CLIENT_PERMISSION_META[key as ClientPermission];
                    return (
                      <label
                        key={key}
                        className="flex items-start gap-3 rounded-lg border border-border bg-muted/20 p-3 text-sm"
                      >
                        <Checkbox
                          checked={!!perms[key]}
                          onCheckedChange={(v) =>
                            setPerms((p) => ({ ...p, [key]: v === true }))
                          }
                          className="mt-0.5"
                        />
                        <span>
                          <span className="font-medium">{t(meta.labelKey)}</span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {t(meta.hintKey)}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter className="shrink-0 border-t border-border px-6 py-4 sm:justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={saving} className="gap-1.5">
                {saving ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Check className="size-4" />
                )}
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
