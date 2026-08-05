import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { eq } from "drizzle-orm";
import {
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  LayoutGrid,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  Shield,
  UserPlus,
  Users,
} from "lucide-react";
import { db, dbReady, schema } from "@/db";
import type { ClientRole, Company, User } from "@/lib/types";
import {
  ensureClientUserRolesForCompany,
  listClientRolesForCompany,
  listRolesForUser,
  setUserClientRoles,
} from "@/lib/client-roles";
import { SYSTEM_CLIENT_ROLE_SLUGS } from "@/lib/client-permissions";
import { deleteClientCompanyById, deleteUserById } from "@/lib/deletes";
import {
  defaultClientLayout,
  moveInOrder,
  normalizeClient,
  parseCompanyClientLayout,
  serializeClientLayout,
  toggleHidden,
  type ClientDashboardLayout,
  type ClientWidgetId,
} from "@/lib/dashboard-layout";
import { EmptyState } from "@/components/EmptyState";
import { DashboardCustomizer } from "@/components/DashboardCustomizer";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "@/lib/format";
import { useLocale } from "@/hooks/use-locale";
import {
  fetchSharePointStatus,
  resolveSharePointSite,
} from "@/lib/sharepoint";

const emptyCompany = {
  name: "",
  email: "",
  phone: "",
  notes: "",
  autotask_company_id: "",
  sharepoint_site_url: "",
  sharepoint_folder_path: "",
  sharepoint_tenant_id: "",
  sharepoint_client_id: "",
  sharepoint_client_secret: "",
  documentation_title: "",
  documentation_enabled: true,
  itglue_organization_id: "",
  active: true,
};

const emptyUser = {
  name: "",
  email: "",
  password: "",
  itglue_user_id: "",
  board_email_opt_in: true,
  /** "" = inherit from stacked roles; "on" | "off" = override */
  billing_access: "" as "" | "on" | "off",
  /**
   * Additional role ids on top of Standard (core is always on).
   * Standard is never listed here — it is forced on save.
   */
  additional_role_ids: [] as number[],
  active: true,
};

type AtCompanyHit = {
  id: number;
  name: string;
  number: string | null;
  phone: string | null;
  active: boolean;
};

export function ClientsPage() {
  const { t } = useLocale();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [companyOpen, setCompanyOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [editing, setEditing] = useState<Company | null>(null);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [form, setForm] = useState(emptyCompany);
  const [userForm, setUserForm] = useState(emptyUser);
  const [clientRoles, setClientRoles] = useState<ClientRole[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [atSearch, setAtSearch] = useState("");
  const [atHits, setAtHits] = useState<AtCompanyHit[]>([]);
  const [atSearching, setAtSearching] = useState(false);
  const [atError, setAtError] = useState<string | null>(null);
  const [atStatus, setAtStatus] = useState<"unknown" | "ok" | "fail">(
    "unknown",
  );
  const [spStatus, setSpStatus] = useState<"unknown" | "ok" | "off" | "fail">(
    "unknown",
  );
  const [spResolving, setSpResolving] = useState(false);
  const [spResolveMsg, setSpResolveMsg] = useState<string | null>(null);
  const [spResolveOk, setSpResolveOk] = useState<boolean | null>(null);
  /** Expanded company row showing that company's portal users */
  const [usersExpandedId, setUsersExpandedId] = useState<number | null>(null);
  const [userQuery, setUserQuery] = useState("");

  // Per-client default dashboard layout editor
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [layoutCompany, setLayoutCompany] = useState<Company | null>(null);
  const [layoutDraft, setLayoutDraft] = useState<ClientDashboardLayout>(() =>
    defaultClientLayout(),
  );
  const [layoutSaving, setLayoutSaving] = useState(false);
  const [layoutSavedFlash, setLayoutSavedFlash] = useState(false);
  const [layoutHasCustom, setLayoutHasCustom] = useState(false);

  const clientWidgetMeta = useMemo(
    () => [
      {
        id: "welcome",
        label: t("dash.wWelcome"),
        description: t("dash.wWelcomeDesc"),
      },
      {
        id: "notifications",
        label: t("dash.wNotifications"),
        description: t("dash.wNotificationsDesc"),
      },
      {
        id: "stats",
        label: t("dash.wStats"),
        description: t("dash.wStatsDesc"),
      },
      {
        id: "messages",
        label: t("dash.wMessages"),
        description: t("dash.wMessagesDesc"),
      },
      {
        id: "tickets",
        label: t("dash.wTickets"),
        description: t("dash.wTicketsDesc"),
      },
      {
        id: "teammates",
        label: t("dash.wTeammates"),
        description: t("dash.wTeammatesDesc"),
      },
      {
        id: "quickLinks",
        label: t("dash.wQuickLinks"),
        description: t("dash.wQuickLinksDesc"),
      },
    ],
    [t],
  );

  const load = async () => {
    await dbReady;
    const [c, u] = await Promise.all([
      db.select().from(schema.companies),
      db.select().from(schema.users),
    ]);
    setCompanies(
      (c as Company[])
        .filter((x) => x.type === "client")
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
    setUsers(u as User[]);
    // Client user roles are loaded per company when adding/editing a user
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    fetch("/api/autotask/status")
      .then((r) => r.json())
      .then((d: { ok?: boolean }) => setAtStatus(d.ok ? "ok" : "fail"))
      .catch(() => setAtStatus("fail"));
    fetchSharePointStatus(false)
      .then((s) => {
        if (!s.configured) setSpStatus("off");
        else setSpStatus(s.ok ? "ok" : "fail");
      })
      .catch(() => setSpStatus("fail"));
  }, []);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyCompany);
    setError(null);
    setAtSearch("");
    setAtHits([]);
    setAtError(null);
    setSpResolveMsg(null);
    setCompanyOpen(true);
  };

  const openEdit = (company: Company) => {
    setEditing(company);
    setForm({
      name: company.name,
      email: company.email ?? "",
      phone: company.phone ?? "",
      notes: company.notes ?? "",
      autotask_company_id: company.autotask_company_id ?? "",
      sharepoint_site_url: company.sharepoint_site_url ?? "",
      sharepoint_folder_path: company.sharepoint_folder_path ?? "",
      sharepoint_tenant_id: company.sharepoint_tenant_id ?? "",
      sharepoint_client_id: company.sharepoint_client_id ?? "",
      sharepoint_client_secret: company.sharepoint_client_secret ?? "",
      documentation_title: company.documentation_title ?? "",
      documentation_enabled: company.documentation_enabled !== false,
      itglue_organization_id: company.itglue_organization_id ?? "",
      active: company.active,
    });
    setError(null);
    setAtSearch(company.name);
    setAtHits([]);
    setAtError(null);
    setSpResolveMsg(null);
    setSpResolveOk(null);
    setCompanyOpen(true);
  };

  const loadRolesForCompany = async (companyId: number) => {
    try {
      const { standard } = await ensureClientUserRolesForCompany(companyId);
      const roles = await listClientRolesForCompany(companyId, {
        activeOnly: true,
      });
      setClientRoles(roles);
      return { roles, standard };
    } catch (e) {
      console.warn("[akab] client user roles load failed", e);
      setClientRoles([]);
      return { roles: [] as ClientRole[], standard: null as ClientRole | null };
    }
  };

  const openAddUser = async (companyId: number) => {
    setSelectedCompanyId(companyId);
    setEditingUser(null);
    setError(null);
    await loadRolesForCompany(companyId);
    setUserForm({
      ...emptyUser,
      additional_role_ids: [],
      billing_access: "",
    });
    setUserOpen(true);
  };

  const openEditUser = async (user: User) => {
    const companyId = user.company_id ?? null;
    setSelectedCompanyId(companyId);
    setEditingUser(user);
    setError(null);
    let additional: number[] = [];
    if (companyId != null) {
      await loadRolesForCompany(companyId);
      try {
        const roles = await listRolesForUser(user.id);
        additional = roles
          .filter((r) => r.slug !== SYSTEM_CLIENT_ROLE_SLUGS.standard)
          .map((r) => r.id);
      } catch {
        additional = [];
      }
    } else {
      setClientRoles([]);
    }
    const billing =
      user.billing_access === true
        ? "on"
        : user.billing_access === false
          ? "off"
          : "";
    setUserForm({
      name: user.name,
      email: user.email,
      password: "",
      itglue_user_id: user.itglue_user_id ?? "",
      board_email_opt_in: user.board_email_opt_in !== false,
      billing_access: billing,
      additional_role_ids: additional,
      active: user.active,
    });
    setUserOpen(true);
  };

  const openLayoutEditor = (company: Company) => {
    const existing = parseCompanyClientLayout(company.dashboard_layout);
    setLayoutCompany(company);
    setLayoutDraft(existing ?? defaultClientLayout());
    setLayoutHasCustom(existing != null);
    setLayoutSavedFlash(false);
    setError(null);
    setLayoutOpen(true);
  };

  const patchLayout = (next: ClientDashboardLayout) => {
    setLayoutDraft(normalizeClient(next));
    setLayoutSavedFlash(false);
  };

  const saveCompanyLayout = async () => {
    if (!layoutCompany) return;
    setLayoutSaving(true);
    setError(null);
    try {
      await dbReady;
      const json = serializeClientLayout(layoutDraft);
      await db
        .update(schema.companies)
        .set({ dashboard_layout: json })
        .where(eq(schema.companies.id, layoutCompany.id));
      setLayoutHasCustom(true);
      setLayoutSavedFlash(true);
      window.setTimeout(() => setLayoutSavedFlash(false), 1800);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save layout");
    } finally {
      setLayoutSaving(false);
    }
  };

  const clearCompanyLayout = async () => {
    if (!layoutCompany) return;
    if (!window.confirm(t("admin.dashLayoutClearConfirm"))) return;
    setLayoutSaving(true);
    setError(null);
    try {
      await dbReady;
      await db
        .update(schema.companies)
        .set({ dashboard_layout: null })
        .where(eq(schema.companies.id, layoutCompany.id));
      setLayoutDraft(defaultClientLayout());
      setLayoutHasCustom(false);
      setLayoutSavedFlash(true);
      window.setTimeout(() => setLayoutSavedFlash(false), 1800);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to clear layout");
    } finally {
      setLayoutSaving(false);
    }
  };

  const verifySharePoint = async () => {
    const url = form.sharepoint_site_url.trim();
    if (!url) {
      setSpResolveOk(false);
      setSpResolveMsg(t("docs.errSiteRequired"));
      return;
    }
    const clientId = form.sharepoint_client_id.trim();
    const clientSecret = form.sharepoint_client_secret.trim();
    if ((clientId && !clientSecret) || (!clientId && clientSecret)) {
      setSpResolveOk(false);
      setSpResolveMsg(t("docs.errClientAppPair"));
      return;
    }
    setSpResolving(true);
    setSpResolveMsg(null);
    setSpResolveOk(null);
    try {
      const auth = {
        tenantId: form.sharepoint_tenant_id.trim() || null,
        clientId: clientId || null,
        clientSecret: clientSecret || null,
      };
      const res = await resolveSharePointSite(url, auth);
      if (!res.configured) {
        setSpResolveOk(false);
        setSpResolveMsg(res.error || t("docs.graphNotConfigured"));
      } else if (res.ok && res.site) {
        setSpResolveOk(true);
        const authLabel =
          res.auth?.source === "client_app"
            ? t("docs.authClientAppUsed")
            : auth.tenantId
              ? t("docs.tenantUsed", { tenant: auth.tenantId })
              : t("docs.tenantDefault");
        setSpResolveMsg(
          t("docs.resolveOk", {
            name: res.site.name || res.site.webUrl || url,
          }) + ` · ${authLabel}`,
        );
      } else {
        setSpResolveOk(false);
        const extra =
          res.help && res.help.length
            ? `\n\n${res.help.map((h) => `• ${h}`).join("\n")}`
            : "";
        setSpResolveMsg((res.error || t("docs.resolveFail")) + extra);
      }
    } catch (e) {
      setSpResolveOk(false);
      setSpResolveMsg(e instanceof Error ? e.message : t("docs.resolveFail"));
    } finally {
      setSpResolving(false);
    }
  };

  const searchAutotask = async () => {
    setAtSearching(true);
    setAtError(null);
    try {
      const q = atSearch.trim() || form.name.trim();
      const res = await fetch(
        `/api/autotask/companies?q=${encodeURIComponent(q)}`,
      );
      const data = (await res.json()) as {
        companies?: AtCompanyHit[];
        error?: string;
        configured?: boolean;
      };
      if (!res.ok || data.error) {
        setAtError(data.error || `Search failed (${res.status})`);
        setAtHits([]);
      } else {
        setAtHits(data.companies ?? []);
        if ((data.companies ?? []).length === 0) {
          setAtError("No Autotask companies matched that search.");
        }
      }
    } catch (e) {
      setAtError(e instanceof Error ? e.message : "Search failed");
      setAtHits([]);
    } finally {
      setAtSearching(false);
    }
  };

  const pickAutotask = (hit: AtCompanyHit) => {
    setForm((f) => ({
      ...f,
      autotask_company_id: String(hit.id),
      name: f.name.trim() ? f.name : hit.name,
      phone: f.phone.trim() ? f.phone : (hit.phone ?? ""),
    }));
    setAtHits([]);
    setAtError(null);
  };

  const saveCompany = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!form.name.trim()) {
      setError("Company name is required.");
      return;
    }
    const spClientId = form.sharepoint_client_id.trim();
    const spClientSecret = form.sharepoint_client_secret.trim();
    if ((spClientId && !spClientSecret) || (!spClientId && spClientSecret)) {
      setError(t("docs.errClientAppPair"));
      return;
    }
    setSaving(true);
    await dbReady;
    const atId = form.autotask_company_id.trim() || null;
    const docsPayload = {
      sharepoint_site_url: form.sharepoint_site_url.trim() || null,
      sharepoint_folder_path: form.sharepoint_folder_path.trim() || null,
      sharepoint_tenant_id: form.sharepoint_tenant_id.trim() || null,
      sharepoint_client_id: spClientId || null,
      sharepoint_client_secret: spClientSecret || null,
      documentation_title: form.documentation_title.trim() || null,
      documentation_enabled: form.documentation_enabled,
      itglue_organization_id: form.itglue_organization_id.trim() || null,
    };
    if (editing) {
      await db
        .update(schema.companies)
        .set({
          name: form.name.trim(),
          email: form.email.trim() || null,
          phone: form.phone.trim() || null,
          notes: form.notes.trim() || null,
          autotask_company_id: atId,
          active: form.active,
          ...docsPayload,
        })
        .where(eq(schema.companies.id, editing.id));
    } else {
      const companyName = form.name.trim();
      await db.insert(schema.companies).values({
        name: companyName,
        type: "client",
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        notes: form.notes.trim() || null,
        autotask_company_id: atId,
        active: form.active,
        ...docsPayload,
      });
      // Create this client's own Standard + Billing user roles immediately
      try {
        const rows = (await db.select().from(schema.companies)) as Company[];
        const created = rows
          .filter((c) => c.type === "client" && c.name === companyName)
          .sort((a, b) => b.id - a.id)[0];
        if (created) {
          await ensureClientUserRolesForCompany(created.id);
        }
      } catch (e) {
        console.warn("[akab] default client user roles on create:", e);
      }
    }
    setSaving(false);
    setCompanyOpen(false);
    await load();
  };

  const saveUser = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!selectedCompanyId && !editingUser) return;
    if (!userForm.name.trim() || !userForm.email.trim()) {
      setError(t("admin.clientUserErrNameEmail"));
      return;
    }
    if (!editingUser && !userForm.password.trim()) {
      setError(t("admin.clientUserErrPassword"));
      return;
    }
    const email = userForm.email.trim().toLowerCase();
    const companyId = editingUser?.company_id ?? selectedCompanyId;
    if (!companyId) return;

    setSaving(true);
    try {
      await dbReady;
      const existing = (await db.select().from(schema.users)) as Array<{
        id: number;
        email: string;
      }>;
      const emailTaken = existing.some(
        (u) => u.email.toLowerCase() === email && u.id !== editingUser?.id,
      );
      if (emailTaken) {
        setError(t("admin.clientUserErrEmailTaken"));
        return;
      }

      const itglueUserId = userForm.itglue_user_id.trim() || null;
      const boardOptIn = userForm.board_email_opt_in !== false;
      const billingAccess =
        userForm.billing_access === "on"
          ? true
          : userForm.billing_access === "off"
            ? false
            : null;

      // Standard is always core; additional roles stack on top
      const { standard } = await ensureClientUserRolesForCompany(companyId);
      const roleIds = [
        standard.id,
        ...userForm.additional_role_ids.filter((id) => id !== standard.id),
      ];

      let userId = editingUser?.id ?? null;
      if (editingUser) {
        await db
          .update(schema.users)
          .set({
            name: userForm.name.trim(),
            email,
            active: userForm.active,
            itglue_user_id: itglueUserId,
            board_email_opt_in: boardOptIn,
            client_role_id: standard.id,
            billing_access: billingAccess,
            ...(userForm.password.trim()
              ? { password: userForm.password }
              : {}),
          })
          .where(eq(schema.users.id, editingUser.id));
      } else {
        await db.insert(schema.users).values({
          name: userForm.name.trim(),
          email,
          password: userForm.password,
          role: "client",
          company_id: companyId,
          active: userForm.active !== false,
          itglue_user_id: itglueUserId,
          board_email_opt_in: boardOptIn,
          client_role_id: standard.id,
          billing_access: billingAccess,
        });
        const created = (
          (await db.select().from(schema.users)) as User[]
        ).find((u) => u.email.toLowerCase() === email);
        userId = created?.id ?? null;
      }

      if (userId != null) {
        await setUserClientRoles({
          userId,
          companyId,
          roleIds,
        });
      }
      setUserOpen(false);
      setEditingUser(null);
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("admin.clientUserSaveFailed"),
      );
    } finally {
      setSaving(false);
    }
  };

  const filtered = companies.filter((c) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      c.name.toLowerCase().includes(q) ||
      (c.email ?? "").toLowerCase().includes(q) ||
      (c.phone ?? "").toLowerCase().includes(q) ||
      (c.autotask_company_id ?? "").includes(q)
    );
  });

  const userCount = (companyId: number) =>
    users.filter((u) => u.company_id === companyId && u.role === "client")
      .length;

  const clientUsersFor = (companyId: number) => {
    const q = userQuery.trim().toLowerCase();
    return users
      .filter((u) => u.company_id === companyId && u.role === "client")
      .filter((u) => {
        if (!q) return true;
        return (
          u.name.toLowerCase().includes(q) ||
          u.email.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  const toggleUserActive = async (user: User) => {
    setError(null);
    await dbReady;
    await db
      .update(schema.users)
      .set({ active: !user.active })
      .where(eq(schema.users.id, user.id));
    await load();
  };

  const handleDeleteUser = async (user: User) => {
    setError(null);
    if (!window.confirm(t("admin.deleteUserConfirm", { name: user.name }))) {
      return;
    }
    try {
      const result = await deleteUserById(user.id);
      if (!result.ok) {
        setError(result.error || t("admin.deleteUserFailed"));
        return;
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("admin.deleteUserFailed"));
    }
  };

  const handleDeleteClient = async (company: Company) => {
    setError(null);
    if (
      !window.confirm(t("admin.deleteClientConfirm", { name: company.name }))
    ) {
      return;
    }
    setSaving(true);
    try {
      const result = await deleteClientCompanyById(company.id);
      if (!result.ok) {
        setError(result.error || t("admin.deleteClientFailed"));
        return;
      }
      if (usersExpandedId === company.id) setUsersExpandedId(null);
      if (editing?.id === company.id) {
        setCompanyOpen(false);
        setEditing(null);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("admin.deleteClientFailed"));
    } finally {
      setSaving(false);
    }
  };

  const toggleUsersPanel = (companyId: number) => {
    setUsersExpandedId((prev) => {
      if (prev === companyId) return null;
      setUserQuery("");
      return companyId;
    });
  };

  return (
    <div className="space-y-6">
      <BlurFade delay={0.05}>
        <Card>
          <CardHeader className="flex flex-col gap-4 space-y-0 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="flex flex-wrap items-center gap-2">
                Client companies
                {atStatus === "ok" && (
                  <Badge
                    variant="outline"
                    className="border-primary/40 bg-primary/10 text-primary"
                  >
                    Autotask connected
                  </Badge>
                )}
                {atStatus === "fail" && (
                  <Badge variant="outline" className="text-muted-foreground">
                    Autotask offline
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>
                Each client gets a private zone. Link their Autotask company ID
                to show open PSA tickets. Set a default dashboard layout per
                company with the grid icon.
              </CardDescription>
            </div>
            <Button onClick={openCreate} className="gap-2">
              <Plus className="size-4" />
              Add client
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="relative max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Search clients…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-14 animate-pulse rounded-lg bg-muted"
                  />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={<Building2 className="size-5" />}
                title={query ? "No matching clients" : "No clients yet"}
                description={
                  query
                    ? "Try a different search term."
                    : "Add your first client company to create their portal zone."
                }
                actionLabel={query ? undefined : "Add client"}
                onAction={query ? undefined : openCreate}
              />
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40">
                      <TableHead>Company</TableHead>
                      <TableHead className="hidden md:table-cell">
                        Contact
                      </TableHead>
                      <TableHead className="hidden lg:table-cell">
                        Autotask ID
                      </TableHead>
                      <TableHead>Users</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden xl:table-cell">
                        Created
                      </TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((company) => {
                      const hasCustomLayout =
                        parseCompanyClientLayout(company.dashboard_layout) !=
                        null;
                      const expanded = usersExpandedId === company.id;
                      const companyUsers = expanded
                        ? clientUsersFor(company.id)
                        : [];
                      return (
                        <Fragment key={company.id}>
                          <TableRow>
                            <TableCell>
                              <div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="font-medium">{company.name}</p>
                                  {hasCustomLayout && (
                                    <Badge
                                      variant="outline"
                                      className="gap-1 border-primary/40 bg-primary/10 text-[10px] text-primary"
                                    >
                                      <LayoutGrid className="size-2.5" />
                                      {t("admin.dashLayoutHasCustom")}
                                    </Badge>
                                  )}
                                  {company.documentation_enabled !== false &&
                                    !!(company.sharepoint_site_url || "").trim() && (
                                    <Badge
                                      variant="outline"
                                      className="gap-1 border-primary/40 bg-primary/10 text-[10px] text-primary"
                                    >
                                      {t("docs.linked")}
                                    </Badge>
                                  )}
                                </div>
                                {company.notes && (
                                  <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                                    {company.notes}
                                  </p>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="hidden md:table-cell">
                              <div className="text-sm">
                                <p>{company.email || "—"}</p>
                                <p className="text-muted-foreground">
                                  {company.phone || "—"}
                                </p>
                              </div>
                            </TableCell>
                            <TableCell className="hidden font-mono text-xs text-muted-foreground lg:table-cell">
                              {company.autotask_company_id || "—"}
                            </TableCell>
                            <TableCell>
                              <Button
                                type="button"
                                variant={expanded ? "secondary" : "outline"}
                                size="sm"
                                className="h-7 gap-1.5 px-2"
                                onClick={() => toggleUsersPanel(company.id)}
                                aria-expanded={expanded}
                                title={
                                  expanded
                                    ? t("admin.hideUsers")
                                    : t("admin.viewUsers")
                                }
                              >
                                {expanded ? (
                                  <ChevronDown className="size-3.5" />
                                ) : (
                                  <ChevronRight className="size-3.5" />
                                )}
                                <Users className="size-3.5" />
                                <span className="tabular-nums">
                                  {userCount(company.id)}
                                </span>
                              </Button>
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={
                                  company.active
                                    ? "border-primary/40 bg-primary/10 text-primary"
                                    : ""
                                }
                              >
                                {company.active ? "Active" : "Inactive"}
                              </Badge>
                            </TableCell>
                            <TableCell className="hidden text-sm text-muted-foreground xl:table-cell">
                              {formatDate(company.created_at)}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => openLayoutEditor(company)}
                                  title={t("admin.dashLayout")}
                                >
                                  <LayoutGrid className="size-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => void openAddUser(company.id)}
                                  title={t("admin.clientUsersAdd")}
                                >
                                  <UserPlus className="size-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => openEdit(company)}
                                  title="Edit client"
                                >
                                  <Pencil className="size-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                  disabled={saving}
                                  onClick={() => void handleDeleteClient(company)}
                                  title={t("admin.deleteClient")}
                                >
                                  <Trash2 className="size-4" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                          {expanded && (
                            <TableRow className="bg-muted/30 hover:bg-muted/30">
                              <TableCell colSpan={7} className="p-0">
                                <div className="space-y-3 border-t border-border px-4 py-4">
                                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                    <div>
                                      <p className="text-sm font-semibold">
                                        {t("admin.clientUsersSection")}
                                      </p>
                                      <p className="text-xs text-muted-foreground">
                                        {t("admin.clientUsersSectionDesc")}
                                      </p>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <div className="relative">
                                        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                                        <Input
                                          className="h-8 w-44 pl-8 text-sm"
                                          placeholder={t(
                                            "admin.clientUsersSearch",
                                          )}
                                          value={userQuery}
                                          onChange={(e) =>
                                            setUserQuery(e.target.value)
                                          }
                                        />
                                      </div>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-8 gap-1.5"
                                        onClick={() => {
                                          window.location.href = `/admin/client-roles?company=${company.id}`;
                                        }}
                                      >
                                        <Shield className="size-3.5" />
                                        {t("admin.clientUserRolesManage")}
                                      </Button>
                                      <Button
                                        size="sm"
                                        className="h-8 gap-1.5"
                                        onClick={() => void openAddUser(company.id)}
                                      >
                                        <UserPlus className="size-3.5" />
                                        {t("admin.clientUsersAdd")}
                                      </Button>
                                    </div>
                                  </div>
                                  {companyUsers.length === 0 ? (
                                    <EmptyState
                                      icon={<Users className="size-5" />}
                                      title={t("admin.clientUsersEmpty")}
                                      description={t(
                                        "admin.clientUsersSectionDesc",
                                      )}
                                      actionLabel={t("admin.clientUsersAdd")}
                                      onAction={() => openAddUser(company.id)}
                                    />
                                  ) : (
                                    <div className="overflow-hidden rounded-lg border border-border bg-card">
                                      <Table>
                                        <TableHeader>
                                          <TableRow className="bg-muted/40">
                                            <TableHead>
                                              {t("common.name")}
                                            </TableHead>
                                            <TableHead className="hidden sm:table-cell">
                                              {t("common.email")}
                                            </TableHead>
                                            <TableHead>
                                              {t("common.status")}
                                            </TableHead>
                                            <TableHead className="hidden md:table-cell">
                                              {t("common.created")}
                                            </TableHead>
                                            <TableHead className="text-right">
                                              {t("common.actions")}
                                            </TableHead>
                                          </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                          {companyUsers.map((u) => (
                                            <TableRow key={u.id}>
                                              <TableCell>
                                                <div>
                                                  <p className="font-medium">
                                                    {u.name}
                                                  </p>
                                                  <p className="text-xs text-muted-foreground sm:hidden">
                                                    {u.email}
                                                  </p>
                                                </div>
                                              </TableCell>
                                              <TableCell className="hidden sm:table-cell">
                                                {u.email}
                                              </TableCell>
                                              <TableCell>
                                                <Badge
                                                  variant="outline"
                                                  className={
                                                    u.active
                                                      ? "border-primary/40 bg-primary/10 text-primary"
                                                      : ""
                                                  }
                                                >
                                                  {u.active
                                                    ? t("common.active")
                                                    : t("common.inactive")}
                                                </Badge>
                                              </TableCell>
                                              <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                                                {formatDate(u.created_at)}
                                              </TableCell>
                                              <TableCell className="text-right">
                                                <div className="flex justify-end gap-1">
                                                  <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() =>
                                                      void openEditUser(u)
                                                    }
                                                    title={t("admin.editUser")}
                                                  >
                                                    <Pencil className="size-4" />
                                                  </Button>
                                                  <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() =>
                                                      void toggleUserActive(u)
                                                    }
                                                  >
                                                    {u.active
                                                      ? t("admin.deactivateUser")
                                                      : t("admin.activateUser")}
                                                  </Button>
                                                  <Button
                                                    variant="outline"
                                                    size="sm"
                                                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                                    onClick={() =>
                                                      void handleDeleteUser(u)
                                                    }
                                                    title={t("admin.deleteUser")}
                                                  >
                                                    <Trash2 className="size-3.5" />
                                                  </Button>
                                                </div>
                                              </TableCell>
                                            </TableRow>
                                          ))}
                                        </TableBody>
                                      </Table>
                                    </div>
                                  )}
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </BlurFade>

      <Dialog open={companyOpen} onOpenChange={setCompanyOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit client" : "Add client company"}
            </DialogTitle>
            <DialogDescription>
              Client companies receive their own zone and dedicated message
              board. Link Autotask so open tickets appear for their users.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={saveCompany} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cname">Company name</Label>
              <Input
                id="cname"
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                required
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="cemail">Email</Label>
                <Input
                  id="cemail"
                  type="email"
                  value={form.email}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, email: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cphone">Phone</Label>
                <Input
                  id="cphone"
                  value={form.phone}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, phone: e.target.value }))
                  }
                />
              </div>
            </div>

            <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor="cautotask" className="text-sm font-semibold">
                  Autotask company
                </Label>
                {atStatus === "ok" ? (
                  <Badge
                    variant="outline"
                    className="border-primary/40 bg-primary/10 text-primary"
                  >
                    Live
                  </Badge>
                ) : (
                  <Badge variant="outline">API offline</Badge>
                )}
              </div>
              <div className="space-y-2">
                <Label
                  htmlFor="cautotask"
                  className="text-xs text-muted-foreground"
                >
                  Company ID
                </Label>
                <Input
                  id="cautotask"
                  inputMode="numeric"
                  placeholder="e.g. 296"
                  value={form.autotask_company_id}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      autotask_company_id: e.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="citglue">IT Glue organization ID</Label>
                <Input
                  id="citglue"
                  inputMode="numeric"
                  placeholder="e.g. 123"
                  value={form.itglue_organization_id}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      itglue_organization_id: e.target.value,
                    }))
                  }
                />
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="Search Autotask by name…"
                  value={atSearch}
                  onChange={(e) => setAtSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void searchAutotask();
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={atSearching || atStatus === "fail"}
                  onClick={() => void searchAutotask()}
                >
                  {atSearching ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Search className="size-4" />
                  )}
                  Find
                </Button>
              </div>
              {atError && (
                <p className="text-xs text-muted-foreground">{atError}</p>
              )}
              {atHits.length > 0 && (
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border bg-card p-1">
                  {atHits.map((hit) => (
                    <button
                      key={hit.id}
                      type="button"
                      className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                      onClick={() => pickAutotask(hit)}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {hit.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {hit.number ? `#${hit.number} · ` : ""}
                          {hit.phone || "No phone"}
                          {!hit.active ? " · inactive" : ""}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-xs text-primary">
                        {hit.id}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Search Autotask and click a result to fill the ID, or paste the
                ID manually from Autotask CRM.
              </p>
            </div>

            <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">
                    {t("docs.sectionTitle")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("docs.sectionHint")}
                  </p>
                  <p className="mt-1 text-xs font-medium text-primary/90">
                    {t("docs.perClientNote")}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {form.sharepoint_site_url.trim() &&
                  form.documentation_enabled ? (
                    <Badge
                      variant="outline"
                      className="border-primary/40 bg-primary/10 text-primary"
                    >
                      {t("docs.clientConnected")}
                    </Badge>
                  ) : (
                    <Badge variant="outline">{t("docs.clientNotConnected")}</Badge>
                  )}
                  {form.sharepoint_client_id.trim() &&
                  form.sharepoint_client_secret.trim() ? (
                    <Badge
                      variant="outline"
                      className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    >
                      {t("docs.authClientApp")}
                    </Badge>
                  ) : spStatus === "ok" ? (
                    <Badge
                      variant="outline"
                      className="border-primary/40 bg-primary/10 text-primary"
                    >
                      {t("docs.authPortalApp")}
                    </Badge>
                  ) : spStatus === "off" ? (
                    <Badge variant="outline">{t("docs.graphOff")}</Badge>
                  ) : spStatus === "fail" ? (
                    <Badge
                      variant="outline"
                      className="border-destructive/40 text-destructive"
                    >
                      {t("docs.graphFail")}
                    </Badge>
                  ) : null}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="cspurl">{t("docs.siteUrl")}</Label>
                <Input
                  id="cspurl"
                  placeholder="https://contoso.sharepoint.com/sites/ClientDocs"
                  value={form.sharepoint_site_url}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      sharepoint_site_url: e.target.value,
                    }))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {t("docs.siteUrlHint")}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="cspfolder">{t("docs.folderPath")}</Label>
                <Input
                  id="cspfolder"
                  placeholder={t("docs.folderPathPh")}
                  value={form.sharepoint_folder_path}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      sharepoint_folder_path: e.target.value,
                    }))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {t("docs.folderPathHint")}
                </p>
              </div>

              <div className="space-y-3 rounded-md border border-border/80 bg-background/60 p-3">
                <div>
                  <p className="text-sm font-medium">{t("docs.graphAuthTitle")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("docs.graphAuthHint")}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="csptenant">{t("docs.tenantId")}</Label>
                  <Input
                    id="csptenant"
                    className="font-mono text-sm"
                    placeholder={t("docs.tenantIdPh")}
                    value={form.sharepoint_tenant_id}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        sharepoint_tenant_id: e.target.value,
                      }))
                    }
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("docs.tenantIdHint")}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cspclientid">{t("docs.clientId")}</Label>
                  <Input
                    id="cspclientid"
                    className="font-mono text-sm"
                    placeholder={t("docs.clientIdPh")}
                    value={form.sharepoint_client_id}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        sharepoint_client_id: e.target.value,
                      }))
                    }
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("docs.clientIdHint")}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cspsecret">{t("docs.clientSecret")}</Label>
                  <Input
                    id="cspsecret"
                    type="password"
                    className="font-mono text-sm"
                    placeholder={t("docs.clientSecretPh")}
                    value={form.sharepoint_client_secret}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        sharepoint_client_secret: e.target.value,
                      }))
                    }
                    autoComplete="new-password"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("docs.clientSecretHint")}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="cdtitle">{t("docs.docTitle")}</Label>
                <Input
                  id="cdtitle"
                  placeholder={t("docs.docTitlePh")}
                  value={form.documentation_title}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      documentation_title: e.target.value,
                    }))
                  }
                />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--primary)]"
                    checked={form.documentation_enabled}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        documentation_enabled: e.target.checked,
                      }))
                    }
                  />
                  {t("docs.enabled")}
                </label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={spResolving || !form.sharepoint_site_url.trim()}
                  onClick={() => void verifySharePoint()}
                  className="gap-2"
                >
                  {spResolving ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Check className="size-3.5" />
                  )}
                  {t("docs.verify")}
                </Button>
              </div>
              {spResolveMsg && (
                <div
                  className={
                    spResolveOk
                      ? "rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-foreground whitespace-pre-wrap"
                      : "rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive whitespace-pre-wrap"
                  }
                >
                  {spResolveMsg}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {t("docs.connectHelp")}
              </p>
            </div>

            <div className="space-y-2">
              <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
              <Label htmlFor="citglue">IT Glue organization ID</Label>
              <Input
                id="citglue"
                inputMode="numeric"
                placeholder="e.g. 123"
                value={form.itglue_organization_id}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    itglue_organization_id: e.target.value,
                  }))
                }
              />
              <p className="text-xs text-muted-foreground">
                Links this client to an IT Glue / MyGlue organization. Passwords
                for this company are loaded only from that org. Each portal user
                still only sees entries their own MyGlue user can access.
              </p>
            </div>

            <Label htmlFor="cnotes">Notes</Label>
              <Textarea
                id="cnotes"
                rows={3}
                value={form.notes}
                onChange={(e) =>
                  setForm((f) => ({ ...f, notes: e.target.value }))
                }
              />
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
              Active client
            </label>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCompanyOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving
                  ? "Saving…"
                  : editing
                    ? "Save changes"
                    : "Create client"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={userOpen}
        onOpenChange={(open) => {
          setUserOpen(open);
          if (!open) {
            setEditingUser(null);
            setError(null);
          }
        }}
      >
        <DialogContent className="flex max-h-[92vh] w-[min(96vw,42rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="shrink-0 space-y-1.5 border-b border-border px-6 py-4 text-left">
            <DialogTitle>
              {editingUser
                ? t("admin.editUser")
                : t("admin.clientUsersAdd")}
            </DialogTitle>
            <DialogDescription>
              {editingUser
                ? t("admin.editUserDesc")
                : t("admin.addUserDesc")}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={saveUser}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
            <div className="space-y-2">
              <Label htmlFor="uname">{t("common.name")}</Label>
              <Input
                id="uname"
                value={userForm.name}
                onChange={(e) =>
                  setUserForm((f) => ({ ...f, name: e.target.value }))
                }
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="uemail">{t("common.email")}</Label>
              <Input
                id="uemail"
                type="email"
                value={userForm.email}
                onChange={(e) =>
                  setUserForm((f) => ({ ...f, email: e.target.value }))
                }
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="upass">
                {editingUser
                  ? t("admin.clientUserPasswordOptional")
                  : t("admin.clientUserPassword")}
              </Label>
              <Input
                id="upass"
                type="text"
                value={userForm.password}
                onChange={(e) =>
                  setUserForm((f) => ({ ...f, password: e.target.value }))
                }
                required={!editingUser}
                placeholder={
                  editingUser ? t("admin.clientUserPasswordKeep") : undefined
                }
              />
              {editingUser && (
                <p className="text-xs text-muted-foreground">
                  {t("admin.clientUserPasswordHint")}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="uitglue">
                {t("admin.clientUserItglueId")}
              </Label>
              <Input
                id="uitglue"
                inputMode="numeric"
                placeholder={t("admin.clientUserItgluePh")}
                value={userForm.itglue_user_id}
                onChange={(e) =>
                  setUserForm((f) => ({ ...f, itglue_user_id: e.target.value }))
                }
              />
              <p className="text-xs text-muted-foreground">
                {t("admin.clientUserItglueHint")}
              </p>
            </div>
            <label className="flex items-start gap-3 rounded-lg border border-border bg-muted/20 p-3 text-sm">
              <Checkbox
                checked={userForm.board_email_opt_in}
                onCheckedChange={(v) =>
                  setUserForm((f) => ({
                    ...f,
                    board_email_opt_in: v === true,
                  }))
                }
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">
                  {t("admin.clientUserBoardEmail")}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {t("admin.clientUserBoardEmailHint")}
                </span>
              </span>
            </label>
            <div className="space-y-2">
              <Label>{t("admin.clientUserCoreRole")}</Label>
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
                <Shield className="size-4 shrink-0 text-primary" />
                <div className="min-w-0">
                  <p className="font-medium">
                    {clientRoles.find(
                      (r) => r.slug === SYSTEM_CLIENT_ROLE_SLUGS.standard,
                    )?.name ?? "Standard user"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("admin.clientUserCoreRoleHint")}
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className="ml-auto shrink-0 border-primary/40 bg-primary/10 text-[10px] text-primary"
                >
                  {t("admin.clientUserCoreBadge")}
                </Badge>
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t("admin.clientUserAdditionalRoles")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("admin.clientUserAdditionalRolesHint")}
              </p>
              <div className="space-y-2 rounded-lg border border-border p-3">
                {clientRoles.filter(
                  (r) => r.slug !== SYSTEM_CLIENT_ROLE_SLUGS.standard,
                ).length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t("admin.clientUserAdditionalRolesEmpty")}
                  </p>
                ) : (
                  clientRoles
                    .filter(
                      (r) => r.slug !== SYSTEM_CLIENT_ROLE_SLUGS.standard,
                    )
                    .map((r) => {
                      const checked = userForm.additional_role_ids.includes(
                        r.id,
                      );
                      return (
                        <label
                          key={r.id}
                          className="flex cursor-pointer items-start gap-3 rounded-md px-1 py-1.5 text-sm hover:bg-muted/40"
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(v) => {
                              const on = v === true;
                              setUserForm((f) => ({
                                ...f,
                                additional_role_ids: on
                                  ? [
                                      ...new Set([
                                        ...f.additional_role_ids,
                                        r.id,
                                      ]),
                                    ]
                                  : f.additional_role_ids.filter(
                                      (id) => id !== r.id,
                                    ),
                              }));
                            }}
                            className="mt-0.5"
                          />
                          <span className="min-w-0">
                            <span className="font-medium">{r.name}</span>
                            {r.slug === SYSTEM_CLIENT_ROLE_SLUGS.billing && (
                              <span className="ml-1.5 text-[11px] text-primary">
                                · {t("admin.clientRoleBillingTag")}
                              </span>
                            )}
                            {r.description && (
                              <span className="mt-0.5 block text-xs text-muted-foreground">
                                {r.description}
                              </span>
                            )}
                          </span>
                        </label>
                      );
                    })
                )}
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t("admin.clientUserBilling")}</Label>
              <Select
                value={userForm.billing_access === "" ? "inherit" : userForm.billing_access}
                onValueChange={(v) =>
                  setUserForm((f) => ({
                    ...f,
                    billing_access:
                      v === "inherit" ? "" : (v as "on" | "off"),
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">
                    {t("admin.clientUserBillingInherit")}
                  </SelectItem>
                  <SelectItem value="on">
                    {t("admin.clientUserBillingOn")}
                  </SelectItem>
                  <SelectItem value="off">
                    {t("admin.clientUserBillingOff")}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t("admin.clientUserBillingHint")}
              </p>
            </div>
            {editingUser && (
              <label className="flex items-start gap-3 rounded-lg border border-border bg-muted/20 p-3 text-sm">
                <Checkbox
                  checked={userForm.active}
                  onCheckedChange={(v) =>
                    setUserForm((f) => ({
                      ...f,
                      active: v === true,
                    }))
                  }
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">
                    {t("admin.clientUserActive")}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {t("admin.clientUserActiveHint")}
                  </span>
                </span>
              </label>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter className="shrink-0 border-t border-border px-6 py-4 sm:justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setUserOpen(false);
                  setEditingUser(null);
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={saving}>
                {saving
                  ? t("common.saving")
                  : editingUser
                    ? t("admin.saveUser")
                    : t("admin.createUser")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={layoutOpen}
        onOpenChange={(open) => {
          setLayoutOpen(open);
          if (!open) {
            setLayoutCompany(null);
            setError(null);
          }
        }}
      >
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <LayoutGrid className="size-5 text-primary" />
              {t("admin.dashLayoutTitle", {
                name: layoutCompany?.name ?? "",
              })}
            </DialogTitle>
            <DialogDescription>{t("admin.dashLayoutDesc")}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className={
                layoutHasCustom
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "text-muted-foreground"
              }
            >
              {layoutHasCustom
                ? t("admin.dashLayoutHasCustom")
                : t("admin.dashLayoutUsingProduct")}
            </Badge>
            {layoutSavedFlash && (
              <Badge
                variant="outline"
                className="gap-1 border-primary/40 bg-primary/10 text-primary"
              >
                <Check className="size-3" />
                {t("admin.dashLayoutSaved")}
              </Badge>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            {t("admin.dashLayoutHint")}
          </p>

          <DashboardCustomizer
            open
            onOpenChange={() => {}}
            hideClose
            className="border-border shadow-none"
            title={t("admin.dashLayout")}
            description={t("admin.dashLayoutDesc")}
            autoSaveHint={t("admin.dashLayoutHint")}
            resetLabel={t("admin.dashLayoutResetProduct")}
            widgets={clientWidgetMeta}
            order={layoutDraft.order}
            hidden={layoutDraft.hidden}
            density={layoutDraft.density}
            statsColumns={layoutDraft.statsColumns}
            onMove={(id, dir) =>
              patchLayout({
                ...layoutDraft,
                order: moveInOrder(
                  layoutDraft.order,
                  id as ClientWidgetId,
                  dir,
                ),
              })
            }
            onToggle={(id) =>
              patchLayout({
                ...layoutDraft,
                hidden: toggleHidden(layoutDraft.hidden, id as ClientWidgetId),
              })
            }
            onDensity={(d) => patchLayout({ ...layoutDraft, density: d })}
            onStatsColumns={(n) =>
              patchLayout({ ...layoutDraft, statsColumns: n })
            }
            onReset={() => patchLayout(defaultClientLayout())}
          />

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
            <div className="flex flex-wrap gap-2">
              {layoutHasCustom && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={layoutSaving}
                  onClick={() => void clearCompanyLayout()}
                >
                  {t("admin.dashLayoutClear")}
                </Button>
              )}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setLayoutOpen(false)}
              >
                {t("common.close")}
              </Button>
              <Button
                type="button"
                disabled={layoutSaving}
                className="gap-2"
                onClick={() => void saveCompanyLayout()}
              >
                {layoutSaving ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t("admin.dashLayoutSaving")}
                  </>
                ) : (
                  t("admin.dashLayoutSave")
                )}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
