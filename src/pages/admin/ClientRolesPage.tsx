import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  Building2,
  Check,
  Loader2,
  Plus,
  Receipt,
  Shield,
  Trash2,
} from "lucide-react";
import {
  createClientUserRole,
  deleteClientRole,
  ensureAllClientCompanyRoles,
  ensureClientUserRolesForCompany,
  listClientRolesForCompany,
  updateClientRole,
} from "@/lib/client-roles";
import {
  STANDARD_CLIENT_PERMISSIONS,
  parseClientPermissions,
  type ClientPermissionMap,
} from "@/lib/client-permissions";
import type { ClientRole, Company } from "@/lib/types";
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

  const selectedCompany = useMemo(
    () => companies.find((c) => c.id === companyId) ?? null,
    [companies, companyId],
  );

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
                        {role.is_system && (
                          <Badge variant="outline" className="text-[10px]">
                            {t("clientRoles.builtIn")}
                          </Badge>
                        )}
                        {p.billing && (
                          <Badge
                            variant="outline"
                            className="gap-1 border-primary/40 bg-primary/10 text-[10px] text-primary"
                          >
                            <Receipt className="size-3" />
                            {t("clientRoles.permBilling")}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-2">
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
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </BlurFade>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing ? t("clientRoles.editTitle") : t("clientRoles.addTitle")}
            </DialogTitle>
            <DialogDescription>
              {selectedCompany
                ? t("clientRoles.dialogDesc", { name: selectedCompany.name })
                : t("clientRoles.dialogDescGeneric")}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={onSave} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cr-name">{t("common.name")}</Label>
              <Input
                id="cr-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                disabled={!!editing?.is_system}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cr-desc">{t("common.description")}</Label>
              <Textarea
                id="cr-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">{t("clientRoles.permissions")}</p>
              <label className="flex items-start gap-3 rounded-lg border border-border bg-muted/20 p-3 text-sm">
                <Checkbox
                  checked={perms.billing}
                  onCheckedChange={(v) =>
                    setPerms((p) => ({ ...p, billing: v === true }))
                  }
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">
                    {t("clientRoles.permBilling")}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {t("clientRoles.permBillingHint")}
                  </span>
                </span>
              </label>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
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
