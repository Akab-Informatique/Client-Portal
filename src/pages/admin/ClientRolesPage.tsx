import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Check,
  Loader2,
  Plus,
  Receipt,
  Shield,
  Trash2,
  Users,
} from "lucide-react";
import {
  createClientRole,
  deleteClientRole,
  ensureDefaultClientRoles,
  listClientRoles,
  updateClientRole,
} from "@/lib/client-roles";
import {
  BILLING_CLIENT_PERMISSIONS,
  STANDARD_CLIENT_PERMISSIONS,
  type ClientPermissionMap,
} from "@/lib/client-permissions";
import type { ClientRole } from "@/lib/types";
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
import { EmptyState } from "@/components/EmptyState";

export function ClientRolesPage() {
  const { t } = useLocale();
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

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      await ensureDefaultClientRoles();
      setRoles(await listClientRoles());
    } catch (e) {
      setError(e instanceof Error ? e.message : t("clientRoles.loadFailed"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

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
    try {
      const parsed = JSON.parse(role.permissions) as ClientPermissionMap;
      setPerms({
        billing: !!parsed.billing,
      });
    } catch {
      setPerms({ ...STANDARD_CLIENT_PERMISSIONS });
    }
    setError(null);
    setOpen(true);
  };

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
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
        await createClientRole({ name, description, permissions: perms });
      }
      setOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("clientRoles.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (role: ClientRole) => {
    if (role.is_system) return;
    if (!window.confirm(t("clientRoles.deleteConfirm", { name: role.name }))) {
      return;
    }
    setError(null);
    try {
      await deleteClientRole(role.id);
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("clientRoles.deleteFailed"),
      );
    }
  };

  const sorted = useMemo(
    () =>
      [...roles].sort((a, b) => {
        if (a.is_system !== b.is_system) return a.is_system ? -1 : 1;
        return a.name.localeCompare(b.name);
      }),
    [roles],
  );

  return (
    <div className="space-y-6">
      <BlurFade delay={0.04}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-xl font-bold tracking-tight">
              {t("clientRoles.title")}
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {t("clientRoles.subtitle")}
            </p>
          </div>
          <Button onClick={openCreate} className="gap-2">
            <Plus className="size-4" />
            {t("clientRoles.add")}
          </Button>
        </div>
      </BlurFade>

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
        ) : sorted.length === 0 ? (
          <EmptyState
            icon={<Users className="size-5" />}
            title={t("clientRoles.emptyTitle")}
            description={t("clientRoles.emptyDesc")}
            actionLabel={t("clientRoles.add")}
            onAction={openCreate}
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {sorted.map((role) => {
              let billing = false;
              try {
                billing = !!(JSON.parse(role.permissions) as ClientPermissionMap)
                  .billing;
              } catch {
                billing = false;
              }
              return (
                <Card key={role.id}>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                          <Shield className="size-4 text-primary" />
                          {role.name}
                          {role.is_system && (
                            <Badge variant="outline" className="text-[10px]">
                              {t("clientRoles.system")}
                            </Badge>
                          )}
                        </CardTitle>
                        <CardDescription className="mt-1">
                          {role.description || t("clientRoles.noDesc")}
                        </CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                      <Badge
                        variant="outline"
                        className={
                          billing
                            ? "border-primary/40 bg-primary/10 text-primary"
                            : "text-muted-foreground"
                        }
                      >
                        <Receipt className="mr-1 size-3" />
                        {billing
                          ? t("clientRoles.billingOn")
                          : t("clientRoles.billingOff")}
                      </Badge>
                      <Badge variant="outline" className="text-muted-foreground">
                        {role.slug}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openEdit(role)}
                      >
                        {t("common.edit")}
                      </Button>
                      {!role.is_system && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-destructive hover:text-destructive"
                          onClick={() => void onDelete(role)}
                        >
                          <Trash2 className="mr-1 size-3.5" />
                          {t("common.delete")}
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </BlurFade>

      <Card className="border-dashed">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{t("clientRoles.howTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>{t("clientRoles.how1")}</p>
          <p>{t("clientRoles.how2")}</p>
          <p>{t("clientRoles.how3")}</p>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing ? t("clientRoles.edit") : t("clientRoles.add")}
            </DialogTitle>
            <DialogDescription>{t("clientRoles.formDesc")}</DialogDescription>
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
              <Label>{t("clientRoles.defaults")}</Label>
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
              <button
                type="button"
                className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                onClick={() => setPerms({ ...BILLING_CLIENT_PERMISSIONS })}
              >
                {t("clientRoles.useBillingTemplate")}
              </button>
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
              <Button type="submit" disabled={saving || !name.trim()}>
                {saving ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    {t("common.saving")}
                  </>
                ) : (
                  <>
                    <Check className="mr-2 size-4" />
                    {t("common.save")}
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
