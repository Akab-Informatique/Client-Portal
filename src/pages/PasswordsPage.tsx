import { useCallback, useEffect, useMemo, useState } from "react";
import { eq } from "drizzle-orm";
import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Trash2,
  Wand2,
} from "lucide-react";
import { db, dbReady, schema } from "@/db";
import { useAuth } from "@/lib/auth";
import {
  createPassword,
  deletePassword,
  fetchPasswords,
  revealPassword,
  updatePassword,
  type ItGluePasswordDetail,
  type ItGluePasswordListItem,
} from "@/lib/itglue";
import type { Company } from "@/lib/types";
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
import { Textarea } from "@/components/ui/textarea";
import { useLocale } from "@/hooks/use-locale";
import { cn } from "@/lib/utils";

type FormMode = "create" | "edit";

type PasswordFormState = {
  name: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  restricted: boolean;
};

const emptyForm = (): PasswordFormState => ({
  name: "",
  username: "",
  password: "",
  url: "",
  notes: "",
  restricted: false,
});

function generateSecret(length = 20): string {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*-_";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

function CopyButton({
  value,
  label,
}: {
  value: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 gap-1.5"
      onClick={onCopy}
      disabled={!value}
      title={label}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

export function PasswordsPage() {
  const { user } = useAuth();
  const { t } = useLocale();
  const isStaff = user?.role === "admin" || user?.role === "technician";

  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<number | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [mock, setMock] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [items, setItems] = useState<ItGluePasswordListItem[]>([]);
  const [q, setQ] = useState("");
  const [searchInput, setSearchInput] = useState("");

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ItGluePasswordDetail | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<FormMode>("create");
  const [form, setForm] = useState<PasswordFormState>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSaving, setFormSaving] = useState(false);
  const [showFormSecret, setShowFormSecret] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] =
    useState<ItGluePasswordListItem | ItGluePasswordDetail | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Load companies the user may access
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user) return;
      await dbReady;
      if (user.role === "client") {
        if (!user.company_id) {
          if (!cancelled) {
            setCompanies([]);
            setCompanyId(null);
            setLoading(false);
          }
          return;
        }
        const rows = await db
          .select()
          .from(schema.companies)
          .where(eq(schema.companies.id, user.company_id))
          .limit(1);
        if (cancelled) return;
        const c = (rows[0] as Company | undefined) ?? null;
        setCompanies(c ? [c] : []);
        setCompany(c);
        setCompanyId(c?.id ?? null);
      } else {
        const rows = (await db.select().from(schema.companies)) as Company[];
        if (cancelled) return;
        const clients = rows
          .filter((c) => c.type === "client" && c.active)
          .sort((a, b) => a.name.localeCompare(b.name));
        setCompanies(clients);
        const linked = clients.find((c) => c.itglue_organization_id?.trim());
        const pick = linked ?? clients[0] ?? null;
        setCompany(pick);
        setCompanyId(pick?.id ?? null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const orgId = company?.itglue_organization_id?.trim() || "";

  const identity = useMemo(
    () => ({
      organizationId: orgId,
      itglueUserId: user?.itglue_user_id,
      email: user?.email,
      role: user?.role,
    }),
    [orgId, user?.itglue_user_id, user?.email, user?.role],
  );

  const load = useCallback(
    async (soft = false) => {
      if (!user) return;
      if (!company) {
        setItems([]);
        setLoading(false);
        return;
      }
      if (!orgId) {
        setItems([]);
        setError(t("passwords.errNoOrg"));
        setConfigured(false);
        setMock(false);
        setLoading(false);
        setRefreshing(false);
        return;
      }

      if (soft) setRefreshing(true);
      else setLoading(true);
      setError(null);
      setNote(null);

      const res = await fetchPasswords({
        organizationId: orgId,
        itglueUserId: user.itglue_user_id,
        email: user.email,
        role: user.role,
        q: q || null,
      });

      setItems(res.passwords ?? []);
      setConfigured(Boolean(res.configured));
      setMock(Boolean(res.mock));
      if (res.resolveNote) setNote(res.resolveNote);
      if (res.unscopedStaff) {
        setNote((prev) =>
          [prev, t("passwords.staffUnscopedNote")].filter(Boolean).join(" "),
        );
      }
      if (res.error && !(res.passwords && res.passwords.length)) {
        setError(res.error);
      } else if (res.error && res.mock) {
        setError(res.error);
      } else {
        setError(null);
      }
      setLoading(false);
      setRefreshing(false);
    },
    [user, company, orgId, q, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // When staff switches company
  useEffect(() => {
    if (!isStaff || companyId == null) return;
    const c = companies.find((x) => x.id === companyId) ?? null;
    setCompany(c);
  }, [companyId, companies, isStaff]);

  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), 3500);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const canMutate = Boolean(user && orgId);

  const openDetail = async (item: ItGluePasswordListItem) => {
    if (!user || !orgId) return;
    setDetailOpen(true);
    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    setShowSecret(false);

    const res = await revealPassword({
      id: item.id,
      organizationId: orgId,
      itglueUserId: user.itglue_user_id,
      email: user.email,
      role: user.role,
    });

    setDetailLoading(false);
    if (res.error || !res.password) {
      setDetailError(res.error || t("passwords.errReveal"));
      setDetail({ ...item, password: null });
      return;
    }
    setDetail(res.password);
  };

  const openCreate = () => {
    setFormMode("create");
    setEditingId(null);
    setForm(emptyForm());
    setFormError(null);
    setShowFormSecret(true);
    setFormOpen(true);
  };

  const openEdit = (source: ItGluePasswordDetail | ItGluePasswordListItem) => {
    setFormMode("edit");
    setEditingId(source.id);
    setForm({
      name: source.name || "",
      username: source.username || "",
      password: "",
      url: source.url || "",
      notes: source.notes || "",
      restricted: Boolean(source.restricted),
    });
    setFormError(null);
    setShowFormSecret(false);
    setFormOpen(true);
  };

  const openDelete = (
    source: ItGluePasswordListItem | ItGluePasswordDetail,
  ) => {
    setDeleteTarget(source);
    setDeleteError(null);
    setDeleteOpen(true);
  };

  const onSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setQ(searchInput.trim());
  };

  const submitForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !orgId) return;

    const name = form.name.trim();
    if (!name) {
      setFormError(t("passwords.errNameRequired"));
      return;
    }
    if (formMode === "create" && !form.password) {
      setFormError(t("passwords.errPasswordRequired"));
      return;
    }

    setFormSaving(true);
    setFormError(null);

    const payload = {
      name,
      username: form.username.trim() || null,
      url: form.url.trim() || null,
      notes: form.notes.trim() || null,
      restricted: form.restricted,
      password: form.password,
    };

    const res =
      formMode === "create"
        ? await createPassword({ ...identity, data: payload })
        : await updatePassword({
            ...identity,
            id: editingId!,
            data: payload,
          });

    setFormSaving(false);

    if (res.error || !res.password) {
      setFormError(
        res.error ||
          (formMode === "create"
            ? t("passwords.errCreate")
            : t("passwords.errUpdate")),
      );
      return;
    }

    setFormOpen(false);
    setFlash(
      formMode === "create"
        ? t("passwords.createSuccess")
        : t("passwords.updateSuccess"),
    );

    // Keep detail dialog in sync when editing the open item
    if (formMode === "edit" && detail?.id === res.password.id) {
      setDetail(res.password);
    }

    await load(true);
  };

  const confirmDelete = async () => {
    if (!user || !orgId || !deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);

    const res = await deletePassword({
      ...identity,
      id: deleteTarget.id,
    });

    setDeleting(false);

    if (res.error) {
      setDeleteError(res.error || t("passwords.errDelete"));
      return;
    }

    setDeleteOpen(false);
    setDeleteTarget(null);
    if (detail?.id === deleteTarget.id) {
      setDetailOpen(false);
      setDetail(null);
    }
    setFlash(t("passwords.deleteSuccess"));
    await load(true);
  };

  const subtitle = useMemo(() => {
    const base = isStaff
      ? t("passwords.subtitleStaff")
      : t("passwords.subtitleClient");
    if (!company) return base;
    const org = company.itglue_organization_id
      ? ` · IT Glue #${company.itglue_organization_id}`
      : "";
    return `${company.name}${org} — ${base}`;
  }, [company, t, isStaff]);

  const vaultDesc = isStaff
    ? t("passwords.vaultDescStaff")
    : t("passwords.vaultDescClient");

  return (
    <div className="space-y-6">
      <BlurFade delay={0.04}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">
              {t("passwords.title")}
            </h2>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {mock && (
              <Badge variant="outline" className="gap-1">
                <Shield className="size-3.5" />
                {t("passwords.demo")}
              </Badge>
            )}
            {configured && !mock && (
              <Badge
                variant="outline"
                className="gap-1 border-primary/40 bg-primary/10 text-primary"
              >
                <KeyRound className="size-3.5" />
                {t("passwords.live")}
              </Badge>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => void load(true)}
              disabled={refreshing || loading}
            >
              {refreshing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {t("common.refresh")}
            </Button>
            <Button
              type="button"
              size="sm"
              className="gap-1.5"
              onClick={openCreate}
              disabled={!canMutate}
            >
              <Plus className="size-3.5" />
              {t("passwords.add")}
            </Button>
          </div>
        </div>
      </BlurFade>

      <BlurFade delay={0.08}>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t("passwords.vaultTitle")}</CardTitle>
            <CardDescription>{vaultDesc}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
              {isStaff && companies.length > 0 && (
                <div className="space-y-1.5 lg:w-64">
                  <Label>{t("passwords.client")}</Label>
                  <Select
                    value={companyId != null ? String(companyId) : undefined}
                    onValueChange={(v) => setCompanyId(Number(v))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t("passwords.pickClient")} />
                    </SelectTrigger>
                    <SelectContent>
                      {companies.map((c) => (
                        <SelectItem key={c.id} value={String(c.id)}>
                          {c.name}
                          {c.itglue_organization_id
                            ? ` (#${c.itglue_organization_id})`
                            : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <form
                onSubmit={onSearch}
                className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-end"
              >
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Label htmlFor="pwd-search">{t("passwords.search")}</Label>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="pwd-search"
                      className="pl-9"
                      value={searchInput}
                      onChange={(e) => setSearchInput(e.target.value)}
                      placeholder={t("passwords.searchPlaceholder")}
                    />
                  </div>
                </div>
                <Button type="submit" variant="secondary">
                  {t("common.search")}
                </Button>
              </form>
            </div>

            {flash && (
              <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-primary">
                <Check className="mt-0.5 size-3.5 shrink-0" />
                <p>{flash}</p>
              </div>
            )}

            {note && (
              <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                <p>{note}</p>
              </div>
            )}

            {error && items.length === 0 && (
              <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm">
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                <p className="text-destructive">{error}</p>
              </div>
            )}

            {error && items.length > 0 && (
              <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                <p>{error}</p>
              </div>
            )}

            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-12 animate-pulse rounded-lg bg-muted"
                  />
                ))}
              </div>
            ) : items.length === 0 && !error ? (
              <EmptyState
                icon={<KeyRound className="size-5" />}
                title={t("passwords.emptyTitle")}
                description={t("passwords.emptyDesc")}
                actionLabel={canMutate ? t("passwords.emptyAction") : undefined}
                onAction={canMutate ? openCreate : undefined}
              />
            ) : items.length === 0 ? null : (
              <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("passwords.colName")}</TableHead>
                      <TableHead>{t("passwords.colUsername")}</TableHead>
                      <TableHead className="hidden md:table-cell">
                        {t("passwords.colCategory")}
                      </TableHead>
                      <TableHead className="hidden lg:table-cell">
                        {t("passwords.colUrl")}
                      </TableHead>
                      <TableHead className="w-[160px] text-right">
                        {t("common.actions")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow
                        key={item.id}
                        className="cursor-pointer"
                        onClick={() => void openDetail(item)}
                      >
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            {item.restricted ? (
                              <Lock className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                            ) : (
                              <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
                            )}
                            <span className="line-clamp-1">{item.name}</span>
                            {item.restricted && (
                              <Badge
                                variant="outline"
                                className="hidden text-[10px] sm:inline-flex"
                              >
                                {t("passwords.restricted")}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {item.username || "—"}
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground md:table-cell">
                          {item.categoryName || "—"}
                        </TableCell>
                        <TableCell className="hidden max-w-[200px] truncate text-muted-foreground lg:table-cell">
                          {item.url || "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <div
                            className="flex items-center justify-end gap-0.5"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="gap-1"
                              onClick={() => void openDetail(item)}
                            >
                              <Eye className="size-3.5" />
                              <span className="hidden sm:inline">
                                {t("passwords.view")}
                              </span>
                            </Button>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="size-8"
                              title={t("common.edit")}
                              disabled={!canMutate}
                              onClick={() => openEdit(item)}
                            >
                              <Pencil className="size-3.5" />
                            </Button>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="size-8 text-destructive hover:text-destructive"
                              title={t("common.delete")}
                              disabled={!canMutate}
                              onClick={() => openDelete(item)}
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
          </CardContent>
        </Card>
      </BlurFade>

      {/* View / reveal dialog */}
      <Dialog
        open={detailOpen}
        onOpenChange={(open) => {
          setDetailOpen(open);
          if (!open) {
            setDetail(null);
            setShowSecret(false);
            setDetailError(null);
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-4" />
              {detail?.name || t("passwords.detailTitle")}
            </DialogTitle>
            <DialogDescription>{t("passwords.detailDesc")}</DialogDescription>
          </DialogHeader>

          {detailLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("common.loading")}
            </div>
          ) : (
            <div className="space-y-4">
              {detailError && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                  <p>{detailError}</p>
                </div>
              )}

              {detail && (
                <>
                  <div className="space-y-1">
                    <Label className="text-muted-foreground">
                      {t("passwords.colUsername")}
                    </Label>
                    <div className="flex flex-wrap items-center gap-2">
                      <code
                        className={cn(
                          "rounded-md border bg-muted/50 px-2 py-1.5 text-sm",
                          !detail.username && "text-muted-foreground",
                        )}
                      >
                        {detail.username || "—"}
                      </code>
                      {detail.username && (
                        <CopyButton
                          value={detail.username}
                          label={t("passwords.copyUser")}
                        />
                      )}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-muted-foreground">
                      {t("passwords.colPassword")}
                    </Label>
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="min-w-[8rem] rounded-md border bg-muted/50 px-2 py-1.5 font-mono text-sm tracking-wide">
                        {detail.password
                          ? showSecret
                            ? detail.password
                            : "••••••••••••"
                          : "—"}
                      </code>
                      {detail.password && (
                        <>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-8 gap-1.5"
                            onClick={() => setShowSecret((v) => !v)}
                          >
                            {showSecret ? (
                              <EyeOff className="size-3.5" />
                            ) : (
                              <Eye className="size-3.5" />
                            )}
                            {showSecret
                              ? t("passwords.hide")
                              : t("passwords.reveal")}
                          </Button>
                          <CopyButton
                            value={detail.password}
                            label={t("passwords.copyPassword")}
                          />
                        </>
                      )}
                    </div>
                  </div>

                  {detail.url && (
                    <div className="space-y-1">
                      <Label className="text-muted-foreground">
                        {t("passwords.colUrl")}
                      </Label>
                      <div className="flex flex-wrap items-center gap-2">
                        <a
                          href={detail.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex max-w-full items-center gap-1 truncate text-sm text-primary underline-offset-4 hover:underline"
                        >
                          <span className="truncate">{detail.url}</span>
                          <ExternalLink className="size-3.5 shrink-0" />
                        </a>
                        <CopyButton
                          value={detail.url}
                          label={t("passwords.copyUrl")}
                        />
                      </div>
                    </div>
                  )}

                  {detail.notes && (
                    <div className="space-y-1">
                      <Label className="text-muted-foreground">
                        {t("passwords.notes")}
                      </Label>
                      <p className="whitespace-pre-wrap rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                        {detail.notes}
                      </p>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2 pt-1 text-xs text-muted-foreground">
                    {detail.categoryName && (
                      <Badge variant="outline">{detail.categoryName}</Badge>
                    )}
                    {detail.restricted && (
                      <Badge
                        variant="outline"
                        className="border-amber-500/40 text-amber-700 dark:text-amber-400"
                      >
                        {t("passwords.restricted")}
                      </Badge>
                    )}
                  </div>

                  <DialogFooter className="gap-2 sm:justify-between">
                    <Button
                      type="button"
                      variant="destructive"
                      className="gap-1.5"
                      disabled={!canMutate}
                      onClick={() => openDelete(detail)}
                    >
                      <Trash2 className="size-3.5" />
                      {t("common.delete")}
                    </Button>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setDetailOpen(false)}
                      >
                        {t("common.close")}
                      </Button>
                      <Button
                        type="button"
                        className="gap-1.5"
                        disabled={!canMutate}
                        onClick={() => openEdit(detail)}
                      >
                        <Pencil className="size-3.5" />
                        {t("common.edit")}
                      </Button>
                    </div>
                  </DialogFooter>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Create / edit dialog */}
      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) {
            setFormError(null);
            setFormSaving(false);
            setShowFormSecret(false);
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {formMode === "create" ? (
                <Plus className="size-4" />
              ) : (
                <Pencil className="size-4" />
              )}
              {formMode === "create"
                ? t("passwords.addTitle")
                : t("passwords.editTitle")}
            </DialogTitle>
            <DialogDescription>
              {formMode === "create"
                ? t("passwords.addDesc")
                : t("passwords.editDesc")}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={(e) => void submitForm(e)} className="space-y-4">
            {formError && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                <p>{formError}</p>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="pwd-name">
                {t("passwords.nameLabel")}{" "}
                <span className="text-destructive">*</span>
              </Label>
              <Input
                id="pwd-name"
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                placeholder={t("passwords.namePlaceholder")}
                autoFocus
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pwd-username">{t("passwords.colUsername")}</Label>
              <Input
                id="pwd-username"
                value={form.username}
                onChange={(e) =>
                  setForm((f) => ({ ...f, username: e.target.value }))
                }
                placeholder={t("passwords.usernamePlaceholder")}
                autoComplete="off"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pwd-secret">
                {t("passwords.colPassword")}
                {formMode === "create" && (
                  <span className="text-destructive"> *</span>
                )}
              </Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative min-w-0 flex-1">
                  <Input
                    id="pwd-secret"
                    type={showFormSecret ? "text" : "password"}
                    value={form.password}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, password: e.target.value }))
                    }
                    placeholder={
                      formMode === "create"
                        ? t("passwords.passwordPlaceholder")
                        : t("passwords.passwordKeepPlaceholder")
                    }
                    autoComplete="new-password"
                    className="pr-10 font-mono"
                    required={formMode === "create"}
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowFormSecret((v) => !v)}
                    tabIndex={-1}
                    aria-label={
                      showFormSecret
                        ? t("passwords.hide")
                        : t("passwords.reveal")
                    }
                  >
                    {showFormSecret ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </button>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="gap-1.5 shrink-0"
                  onClick={() => {
                    const secret = generateSecret();
                    setForm((f) => ({ ...f, password: secret }));
                    setShowFormSecret(true);
                  }}
                >
                  <Wand2 className="size-3.5" />
                  {t("passwords.generate")}
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pwd-url">{t("passwords.colUrl")}</Label>
              <Input
                id="pwd-url"
                type="url"
                value={form.url}
                onChange={(e) =>
                  setForm((f) => ({ ...f, url: e.target.value }))
                }
                placeholder={t("passwords.urlPlaceholder")}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pwd-notes">{t("passwords.notes")}</Label>
              <Textarea
                id="pwd-notes"
                value={form.notes}
                onChange={(e) =>
                  setForm((f) => ({ ...f, notes: e.target.value }))
                }
                placeholder={t("passwords.notesPlaceholder")}
                rows={3}
              />
            </div>

            <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 px-3 py-3">
              <Checkbox
                id="pwd-restricted"
                checked={form.restricted}
                onCheckedChange={(checked) =>
                  setForm((f) => ({ ...f, restricted: checked === true }))
                }
              />
              <div className="space-y-0.5">
                <Label htmlFor="pwd-restricted" className="cursor-pointer">
                  {t("passwords.restricted")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("passwords.restrictedHint")}
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setFormOpen(false)}
                disabled={formSaving}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={formSaving} className="gap-1.5">
                {formSaving && <Loader2 className="size-3.5 animate-spin" />}
                {formSaving
                  ? formMode === "create"
                    ? t("passwords.creating")
                    : t("passwords.updating")
                  : t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          setDeleteOpen(open);
          if (!open) {
            setDeleteTarget(null);
            setDeleteError(null);
            setDeleting(false);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="size-4" />
              {t("passwords.deleteTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("passwords.deleteDesc", {
                name: deleteTarget?.name || "",
              })}
            </DialogDescription>
          </DialogHeader>

          {deleteError && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <p>{deleteError}</p>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="gap-1.5"
              disabled={deleting}
              onClick={() => void confirmDelete()}
            >
              {deleting && <Loader2 className="size-3.5 animate-spin" />}
              {deleting
                ? t("passwords.deleting")
                : t("passwords.deleteConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
