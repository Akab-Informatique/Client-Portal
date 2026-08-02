import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { eq } from "drizzle-orm";
import {
  Check,
  Pencil,
  Plus,
  Search,
  Shield,
  ShieldCheck,
  Trash2,
  Wrench,
} from "lucide-react";
import { db, dbReady, schema } from "@/db";
import type { StaffRole, User } from "@/lib/types";
import {
  STAFF_PERMISSIONS,
  TECHNICIAN_PERMISSIONS,
  countGranted,
  parsePermissions,
  type PermissionMap,
  type StaffPermission,
} from "@/lib/permissions";
import {
  createStaffRole,
  deleteStaffRole,
  listStaffRoles,
  portalRoleFromStaffRole,
  updateStaffRole,
} from "@/lib/roles";
import { deleteUserById } from "@/lib/deletes";
import { useAuth } from "@/lib/auth";
import { useLocale } from "@/hooks/use-locale";
import { EmptyState } from "@/components/EmptyState";
import { BlurFade } from "@/components/ui/blur-fade";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const emptyTechForm = {
  name: "",
  email: "",
  password: "",
  active: true,
  staff_role_id: "" as string,
  /** Linked IT Glue user id — passwords filtered to what this IT Glue user may access */
  itglue_user_id: "",
};

const emptyRoleForm = {
  name: "",
  description: "",
  permissions: { ...TECHNICIAN_PERMISSIONS } as PermissionMap,
  active: true,
};

const PERM_LABEL: Record<StaffPermission, string> = {
  dashboard: "staffRoles.permDashboard",
  clients: "staffRoles.permClients",
  technicians: "staffRoles.permTechnicians",
  roles: "staffRoles.permRoles",
  users: "staffRoles.permUsers",
  messages: "staffRoles.permMessages",
  documentation: "staffRoles.permDocumentation",
  passwords: "staffRoles.permPasswords",
  directory: "staffRoles.permDirectory",
  profiles: "staffRoles.permProfiles",
};

const PERM_DESC: Record<StaffPermission, string> = {
  dashboard: "staffRoles.permDescDashboard",
  clients: "staffRoles.permDescClients",
  technicians: "staffRoles.permDescTechnicians",
  roles: "staffRoles.permDescRoles",
  users: "staffRoles.permDescUsers",
  messages: "staffRoles.permDescMessages",
  documentation: "staffRoles.permDescDocumentation",
  passwords: "staffRoles.permDescPasswords",
  directory: "staffRoles.permDescDirectory",
  profiles: "staffRoles.permDescProfiles",
};

export function TechniciansPage() {
  const { t, can, refreshUser, user } = useAuthWithLocale();
  const [searchParams, setSearchParams] = useSearchParams();
  const canManageTech = can("technicians");
  const canManageRoles = can("roles");

  const initialTab =
    searchParams.get("tab") === "roles" && canManageRoles
      ? "roles"
      : canManageTech
        ? "staff"
        : "roles";

  const [tab, setTab] = useState(initialTab);

  // ── Staff list ──────────────────────────────────────────────
  const [technicians, setTechnicians] = useState<User[]>([]);
  const [roles, setRoles] = useState<StaffRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [form, setForm] = useState(emptyTechForm);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // ── Roles editor ────────────────────────────────────────────
  const [roleOpen, setRoleOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<StaffRole | null>(null);
  const [roleForm, setRoleForm] = useState(emptyRoleForm);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [roleSaving, setRoleSaving] = useState(false);
  const [roleFlash, setRoleFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await dbReady;
      // Load users first so the table can render even if roles bootstrap is slow
      const rows = (await db.select().from(schema.users)) as User[];
      setTechnicians(
        rows
          .filter((u) => u.role === "technician" || u.role === "admin")
          .sort((a, b) => a.name.localeCompare(b.name)),
      );

      try {
        const roleRows = await listStaffRoles();
        setRoles(roleRows);
      } catch (roleErr) {
        console.error("[akab] listStaffRoles failed", roleErr);
        setError(
          roleErr instanceof Error
            ? roleErr.message
            : "Could not load staff roles.",
        );
        // Best-effort plain read so the Roles tab is not empty forever
        try {
          const fallback = (await db
            .select()
            .from(schema.staff_roles)) as StaffRole[];
          setRoles(
            fallback.sort((a, b) => {
              if (a.is_system !== b.is_system) return a.is_system ? -1 : 1;
              return a.name.localeCompare(b.name);
            }),
          );
        } catch {
          setRoles([]);
        }
      }
    } catch (err) {
      console.error("[akab] Staff & Roles load failed", err);
      setError(
        err instanceof Error ? err.message : "Could not load staff directory.",
      );
    } finally {
      // ALWAYS clear loading — never leave "Loading portal" / skeleton forever
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tab === "roles") {
      setSearchParams({ tab: "roles" }, { replace: true });
    } else {
      setSearchParams({}, { replace: true });
    }
  }, [tab, setSearchParams]);

  const roleById = useMemo(() => {
    const m = new Map<number, StaffRole>();
    for (const r of roles) m.set(r.id, r);
    return m;
  }, [roles]);

  const activeRoles = useMemo(
    () => roles.filter((r) => r.active),
    [roles],
  );

  const defaultTechRoleId = useMemo(() => {
    const tech = roles.find((r) => r.slug === "technician");
    return tech ? String(tech.id) : roles[0] ? String(roles[0].id) : "";
  }, [roles]);

  // ── Tech CRUD ───────────────────────────────────────────────
  const openCreate = () => {
    setEditing(null);
    setForm({ ...emptyTechForm, staff_role_id: defaultTechRoleId });
    setError(null);
    setOpen(true);
  };

  const openEdit = (u: User) => {
    setEditing(u);
    setForm({
      name: u.name,
      email: u.email,
      password: "",
      active: u.active,
      staff_role_id: u.staff_role_id ? String(u.staff_role_id) : defaultTechRoleId,
      itglue_user_id: u.itglue_user_id ?? "",
    });
    setError(null);
    setOpen(true);
  };

  const handleDeleteStaff = async (tech: User) => {
    setError(null);
    if (
      !window.confirm(
        t("staffRoles.deleteStaffConfirm", { name: tech.name }),
      )
    ) {
      return;
    }
    try {
      const result = await deleteUserById(tech.id, { actorId: user?.id });
      if (!result.ok) {
        if (/own account/i.test(result.error)) {
          setError(t("admin.deleteUserSelf"));
        } else if (/last active admin/i.test(result.error)) {
          setError(t("admin.deleteUserLastAdmin"));
        } else {
          setError(result.error || t("staffRoles.deleteStaffFailed"));
        }
        return;
      }
      await load();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t("staffRoles.deleteStaffFailed"),
      );
    }
  };

  const saveTech = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!form.name.trim() || !form.email.trim()) {
      setError(t("staffRoles.errNameEmail"));
      return;
    }
    if (!editing && !form.password.trim()) {
      setError(t("staffRoles.errPassword"));
      return;
    }
    if (!form.staff_role_id) {
      setError(t("staffRoles.errRoleRequired"));
      return;
    }

    const email = form.email.trim().toLowerCase();
    const staffRoleId = Number(form.staff_role_id);
    const staffRole = roleById.get(staffRoleId);
    if (!staffRole) {
      setError(t("staffRoles.errRoleRequired"));
      return;
    }

    setSaving(true);
    await dbReady;

    const all = (await db.select().from(schema.users)) as Array<{
      id: number;
      email: string;
    }>;
    const emailTaken = all.some(
      (u) => u.email.toLowerCase() === email && u.id !== editing?.id,
    );
    if (emailTaken) {
      setSaving(false);
      setError(t("staffRoles.errEmailTaken"));
      return;
    }

    const companies = (await db.select().from(schema.companies)) as Array<{
      id: number;
      type: string;
      name: string;
    }>;
    let internal = companies.find((c) => c.type === "internal");
    if (!internal) {
      // Avoid .returning() over pg-proxy — insert then select
      await db.insert(schema.companies).values({
        name: "AKAB Informatique",
        type: "internal",
        email: "admin@akab.local",
        active: true,
      });
      const created = (await db.select().from(schema.companies)) as Array<{
        id: number;
        type: string;
        name: string;
      }>;
      internal = created.find((c) => c.type === "internal");
    }

    const portalRole = portalRoleFromStaffRole(staffRole);
    const itglueUserId = form.itglue_user_id.trim() || null;

    if (editing) {
      await db
        .update(schema.users)
        .set({
          name: form.name.trim(),
          email,
          active: form.active,
          staff_role_id: staffRoleId,
          role: portalRole,
          itglue_user_id: itglueUserId,
          ...(form.password.trim() ? { password: form.password } : {}),
        })
        .where(eq(schema.users.id, editing.id));
      // If editing self, refresh session permissions + IT Glue link
      if (user?.id === editing.id) {
        await refreshUser();
      }
    } else {
      if (!internal) {
        setSaving(false);
        setError("Internal company not found.");
        return;
      }
      await db.insert(schema.users).values({
        name: form.name.trim(),
        email,
        password: form.password,
        role: portalRole,
        company_id: internal.id,
        active: form.active,
        staff_role_id: staffRoleId,
        itglue_user_id: itglueUserId,
      });
    }

    setSaving(false);
    setOpen(false);
    await load();
  };

  // ── Role CRUD ───────────────────────────────────────────────
  const openCreateRole = () => {
    setEditingRole(null);
    setRoleForm({
      ...emptyRoleForm,
      permissions: { ...TECHNICIAN_PERMISSIONS },
    });
    setRoleError(null);
    setRoleOpen(true);
  };

  const openEditRole = (role: StaffRole) => {
    setEditingRole(role);
    setRoleForm({
      name: role.name,
      description: role.description ?? "",
      permissions: parsePermissions(role.permissions),
      active: role.active,
    });
    setRoleError(null);
    setRoleOpen(true);
  };

  const togglePerm = (key: StaffPermission) => {
    setRoleForm((f) => ({
      ...f,
      permissions: { ...f.permissions, [key]: !f.permissions[key] },
    }));
  };

  const saveRole = async (e: FormEvent) => {
    e.preventDefault();
    setRoleError(null);
    if (!roleForm.name.trim()) {
      setRoleError(t("staffRoles.errRoleName"));
      return;
    }
    if (countGranted(roleForm.permissions) === 0) {
      setRoleError(t("staffRoles.errNoPerms"));
      return;
    }
    setRoleSaving(true);
    try {
      if (editingRole) {
        await updateStaffRole(editingRole.id, {
          name: roleForm.name,
          description: roleForm.description,
          permissions: roleForm.permissions,
          active: roleForm.active,
        });
        // Refresh session if our own role changed
        if (user?.staff_role_id === editingRole.id) {
          await refreshUser();
        }
      } else {
        await createStaffRole({
          name: roleForm.name,
          description: roleForm.description,
          permissions: roleForm.permissions,
        });
      }
      setRoleOpen(false);
      setRoleFlash(t("staffRoles.saved"));
      window.setTimeout(() => setRoleFlash(null), 2000);
      await load();
    } catch (err) {
      setRoleError(err instanceof Error ? err.message : t("staffRoles.errSave"));
    } finally {
      setRoleSaving(false);
    }
  };

  const handleDeleteRole = async (role: StaffRole) => {
    if (role.is_system) return;
    if (!window.confirm(t("staffRoles.deleteConfirm", { name: role.name }))) return;
    const result = await deleteStaffRole(role.id);
    if (!result.ok) {
      window.alert(result.error);
      return;
    }
    await load();
  };

  const filtered = technicians.filter((tech) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const roleName = tech.staff_role_id
      ? roleById.get(tech.staff_role_id)?.name ?? ""
      : "";
    return (
      tech.name.toLowerCase().includes(q) ||
      tech.email.toLowerCase().includes(q) ||
      roleName.toLowerCase().includes(q)
    );
  });

  // Access gate — need at least one of the two
  if (!canManageTech && !canManageRoles) {
    return (
      <div className="mx-auto max-w-lg rounded-xl border border-border bg-card p-8 text-center">
        <h2 className="text-lg font-bold">{t("staffRoles.accessDenied")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("staffRoles.accessDeniedDesc")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <BlurFade delay={0.05}>
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v)}
          className="w-full"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-bold tracking-tight">
                {t("staffRoles.pageTitle")}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("staffRoles.pageDesc")}
              </p>
            </div>
            <TabsList>
              {canManageTech && (
                <TabsTrigger value="staff" className="gap-1.5">
                  <Wrench className="size-3.5" />
                  {t("staffRoles.tabStaff")}
                </TabsTrigger>
              )}
              {canManageRoles && (
                <TabsTrigger value="roles" className="gap-1.5">
                  <Shield className="size-3.5" />
                  {t("staffRoles.tabRoles")}
                </TabsTrigger>
              )}
            </TabsList>
          </div>

          {/* ══════════ STAFF TAB ══════════ */}
          {canManageTech && (
            <TabsContent value="staff" className="mt-4">
              <Card>
                <CardHeader className="flex flex-col gap-4 space-y-0 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <CardTitle>{t("staffRoles.staffTitle")}</CardTitle>
                    <CardDescription>{t("staffRoles.staffDesc")}</CardDescription>
                  </div>
                  <Button onClick={openCreate} className="gap-2">
                    <Plus className="size-4" />
                    {t("staffRoles.addStaff")}
                  </Button>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="relative max-w-md">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      className="pl-9"
                      placeholder={t("staffRoles.searchStaff")}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>

                  {loading ? (
                    <div className="space-y-2">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <div
                          key={i}
                          className="h-14 animate-pulse rounded-lg bg-muted"
                        />
                      ))}
                    </div>
                  ) : filtered.length === 0 ? (
                    <EmptyState
                      icon={<Wrench className="size-5" />}
                      title={
                        query
                          ? t("staffRoles.noMatchStaff")
                          : t("staffRoles.noStaff")
                      }
                      description={
                        query
                          ? t("staffRoles.trySearch")
                          : t("staffRoles.noStaffDesc")
                      }
                      actionLabel={query ? undefined : t("staffRoles.addStaff")}
                      onAction={query ? undefined : openCreate}
                    />
                  ) : (
                    <div className="overflow-hidden rounded-lg border border-border">
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted/40">
                            <TableHead>{t("common.name")}</TableHead>
                            <TableHead>{t("common.email")}</TableHead>
                            <TableHead>{t("staffRoles.roleCol")}</TableHead>
                            <TableHead className="hidden lg:table-cell">
                              {t("staffRoles.itglueCol")}
                            </TableHead>
                            <TableHead>{t("common.status")}</TableHead>
                            <TableHead className="hidden md:table-cell">
                              {t("common.created")}
                            </TableHead>
                            <TableHead className="text-right">
                              {t("common.actions")}
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {filtered.map((tech) => {
                            const role = tech.staff_role_id
                              ? roleById.get(tech.staff_role_id)
                              : null;
                            return (
                              <TableRow key={tech.id}>
                                <TableCell className="font-medium">
                                  {tech.name}
                                  {tech.id === user?.id && (
                                    <span className="ml-2 text-xs text-muted-foreground">
                                      ({t("common.you")})
                                    </span>
                                  )}
                                </TableCell>
                                <TableCell>{tech.email}</TableCell>
                                <TableCell>
                                  <Badge
                                    variant="outline"
                                    className={cn(
                                      role?.slug === "admin" &&
                                        "border-primary/40 bg-primary/10 text-primary",
                                    )}
                                  >
                                    {role?.is_system && (
                                      <ShieldCheck className="mr-1 size-3" />
                                    )}
                                    {role?.name ?? t("staffRoles.unassigned")}
                                  </Badge>
                                </TableCell>
                                <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                                  {tech.itglue_user_id?.trim() ? (
                                    <span className="font-mono tabular-nums">
                                      #{tech.itglue_user_id.trim()}
                                    </span>
                                  ) : (
                                    <span className="text-xs">
                                      {t("staffRoles.itglueNotLinked")}
                                    </span>
                                  )}
                                </TableCell>
                                <TableCell>
                                  <Badge
                                    variant="outline"
                                    className={
                                      tech.active
                                        ? "border-primary/40 bg-primary/10 text-primary"
                                        : ""
                                    }
                                  >
                                    {tech.active
                                      ? t("common.active")
                                      : t("common.inactive")}
                                  </Badge>
                                </TableCell>
                                <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                                  {formatDate(tech.created_at)}
                                </TableCell>
                                <TableCell className="text-right">
                                  <div className="flex justify-end gap-1">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => openEdit(tech)}
                                      title={t("common.edit")}
                                    >
                                      <Pencil className="size-4" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                      disabled={
                                        saving || tech.id === user?.id
                                      }
                                      onClick={() =>
                                        void handleDeleteStaff(tech)
                                      }
                                      title={
                                        tech.id === user?.id
                                          ? t("admin.deleteUserSelf")
                                          : t("common.delete")
                                      }
                                    >
                                      <Trash2 className="size-4" />
                                    </Button>
                                  </div>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          )}

          {/* ══════════ ROLES TAB ══════════ */}
          {canManageRoles && (
            <TabsContent value="roles" className="mt-4 space-y-4">
              {roleFlash && (
                <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-medium text-primary">
                  <Check className="size-4" />
                  {roleFlash}
                </div>
              )}
              <Card>
                <CardHeader className="flex flex-col gap-4 space-y-0 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Shield className="size-5 text-primary" />
                      {t("staffRoles.rolesTitle")}
                    </CardTitle>
                    <CardDescription>{t("staffRoles.rolesDesc")}</CardDescription>
                  </div>
                  <Button onClick={openCreateRole} className="gap-2">
                    <Plus className="size-4" />
                    {t("staffRoles.addRole")}
                  </Button>
                </CardHeader>
                <CardContent className="space-y-3">
                  {loading ? (
                    <div className="space-y-2">
                      {Array.from({ length: 2 }).map((_, i) => (
                        <div
                          key={i}
                          className="h-24 animate-pulse rounded-lg bg-muted"
                        />
                      ))}
                    </div>
                  ) : (
                    roles.map((role) => {
                      const perms = parsePermissions(role.permissions);
                      const granted = STAFF_PERMISSIONS.filter((p) => perms[p]);
                      const assigned = technicians.filter(
                        (u) => u.staff_role_id === role.id,
                      ).length;
                      return (
                        <div
                          key={role.id}
                          className="rounded-xl border border-border bg-card/60 p-4 transition-colors hover:bg-muted/20"
                        >
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="font-semibold">{role.name}</p>
                                {role.is_system && (
                                  <Badge className="bg-primary text-primary-foreground hover:bg-primary">
                                    {t("staffRoles.system")}
                                  </Badge>
                                )}
                                {!role.active && (
                                  <Badge variant="outline">
                                    {t("common.inactive")}
                                  </Badge>
                                )}
                                <Badge variant="outline" className="tabular-nums">
                                  {t("staffRoles.assignedCount", { n: assigned })}
                                </Badge>
                              </div>
                              {role.description && (
                                <p className="mt-1 text-sm text-muted-foreground">
                                  {role.description}
                                </p>
                              )}
                              <div className="mt-3 flex flex-wrap gap-1.5">
                                {granted.length === 0 ? (
                                  <span className="text-xs text-muted-foreground">
                                    {t("staffRoles.noAccess")}
                                  </span>
                                ) : (
                                  granted.map((p) => (
                                    <Badge
                                      key={p}
                                      variant="outline"
                                      className="border-primary/30 bg-primary/5 text-xs"
                                    >
                                      {t(PERM_LABEL[p])}
                                    </Badge>
                                  ))
                                )}
                              </div>
                            </div>
                            <div className="flex shrink-0 gap-1">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => openEditRole(role)}
                                className="gap-1.5"
                              >
                                <Pencil className="size-3.5" />
                                {t("common.edit")}
                              </Button>
                              {!role.is_system && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleDeleteRole(role)}
                                  className="text-destructive hover:text-destructive"
                                >
                                  <Trash2 className="size-3.5" />
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          )}
        </Tabs>
      </BlurFade>

      {/* ── Staff dialog ── */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing ? t("staffRoles.editStaff") : t("staffRoles.addStaff")}
            </DialogTitle>
            <DialogDescription>{t("staffRoles.staffDialogDesc")}</DialogDescription>
          </DialogHeader>
          <form onSubmit={saveTech} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tname">{t("common.name")}</Label>
              <Input
                id="tname"
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="temail">{t("common.email")}</Label>
              <Input
                id="temail"
                type="email"
                value={form.email}
                onChange={(e) =>
                  setForm((f) => ({ ...f, email: e.target.value }))
                }
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tpass">
                {editing ? t("staffRoles.newPasswordOptional") : t("common.password")}
              </Label>
              <Input
                id="tpass"
                type="text"
                value={form.password}
                onChange={(e) =>
                  setForm((f) => ({ ...f, password: e.target.value }))
                }
                required={!editing}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("staffRoles.assignRole")}</Label>
              <Select
                value={form.staff_role_id}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, staff_role_id: v }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("staffRoles.pickRole")} />
                </SelectTrigger>
                <SelectContent>
                  {activeRoles.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)}>
                      {r.name}
                      {r.is_system ? ` (${t("staffRoles.system")})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t("staffRoles.assignRoleHint")}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="titglue">{t("staffRoles.itglueUserId")}</Label>
              <Input
                id="titglue"
                inputMode="numeric"
                placeholder={t("staffRoles.itglueUserIdPh")}
                value={form.itglue_user_id}
                onChange={(e) =>
                  setForm((f) => ({ ...f, itglue_user_id: e.target.value }))
                }
              />
              <p className="text-xs text-muted-foreground">
                {t("staffRoles.itglueUserIdHint")}
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[var(--primary)]"
                checked={form.active}
                onChange={(e) =>
                  setForm((f) => ({ ...f, active: e.target.checked }))
                }
              />
              {t("staffRoles.activeAccount")}
            </label>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={saving}>
                {saving
                  ? t("common.saving")
                  : editing
                    ? t("common.save")
                    : t("staffRoles.createStaff")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Role dialog ── */}
      <Dialog open={roleOpen} onOpenChange={setRoleOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingRole ? t("staffRoles.editRole") : t("staffRoles.addRole")}
            </DialogTitle>
            <DialogDescription>
              {editingRole?.is_system
                ? t("staffRoles.editSystemRoleDesc")
                : t("staffRoles.roleDialogDesc")}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={saveRole} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="rname">{t("staffRoles.roleName")}</Label>
              <Input
                id="rname"
                value={roleForm.name}
                onChange={(e) =>
                  setRoleForm((f) => ({ ...f, name: e.target.value }))
                }
                required
                placeholder={t("staffRoles.roleNamePh")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rdesc">{t("staffRoles.roleDesc")}</Label>
              <Textarea
                id="rdesc"
                value={roleForm.description}
                onChange={(e) =>
                  setRoleForm((f) => ({ ...f, description: e.target.value }))
                }
                rows={2}
                placeholder={t("staffRoles.roleDescPh")}
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>{t("staffRoles.sectionAccess")}</Label>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {t("staffRoles.grantedCount", {
                    n: countGranted(roleForm.permissions),
                    total: STAFF_PERMISSIONS.length,
                  })}
                </span>
              </div>
              <ul className="space-y-2 rounded-lg border border-border p-3">
                {STAFF_PERMISSIONS.map((p) => {
                  const checked = !!roleForm.permissions[p];
                  return (
                    <li
                      key={p}
                      className={cn(
                        "flex items-start gap-3 rounded-md px-2 py-2 transition-colors",
                        checked ? "bg-primary/5" : "hover:bg-muted/40",
                      )}
                    >
                      <Checkbox
                        id={`perm-${p}`}
                        checked={checked}
                        onCheckedChange={() => togglePerm(p)}
                        className="mt-0.5"
                      />
                      <label
                        htmlFor={`perm-${p}`}
                        className="min-w-0 flex-1 cursor-pointer"
                      >
                        <p className="text-sm font-medium">
                          {t(PERM_LABEL[p])}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t(PERM_DESC[p])}
                        </p>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>

            {editingRole && !editingRole.is_system && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--primary)]"
                  checked={roleForm.active}
                  onChange={(e) =>
                    setRoleForm((f) => ({ ...f, active: e.target.checked }))
                  }
                />
                {t("staffRoles.roleActive")}
              </label>
            )}

            {roleError && (
              <p className="text-sm text-destructive">{roleError}</p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setRoleOpen(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={roleSaving}>
                {roleSaving
                  ? t("common.saving")
                  : editingRole
                    ? t("staffRoles.saveRole")
                    : t("staffRoles.createRole")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Bundle useAuth + useLocale so the page stays tidy. */
function useAuthWithLocale() {
  const auth = useAuth();
  const { t } = useLocale();
  return { ...auth, t };
}
