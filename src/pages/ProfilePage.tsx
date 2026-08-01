import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { eq } from "drizzle-orm";
import {
  ArrowLeft,
  Building2,
  CheckCircle2,
  Lock,
  Mail,
  Phone,
  Save,
  Shield,
  User as UserIcon,
  Users,
} from "lucide-react";
import { db, dbReady, schema } from "@/db";
import { useAuth } from "@/lib/auth";
import {
  changeOwnPassword,
  getProfileInCompany,
  initials,
  listCompanyDirectory,
  updateOwnProfile,
} from "@/lib/profiles";
import type { Company, PublicProfile } from "@/lib/types";
import { useLocale } from "@/hooks/use-locale";
import { isLocale, LOCALES, type Locale } from "@/i18n";
import { formatDate, roleLabel } from "@/lib/format";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

function profileBasePath(role: string | undefined) {
  return role === "client" ? "/client" : "/admin";
}

export function ProfilePage() {
  const { userId: userIdParam } = useParams();
  const { user, patchSession } = useAuth();
  const { t, locale, setLocale } = useLocale();
  const navigate = useNavigate();

  const targetId = useMemo(() => {
    if (!userIdParam || userIdParam === "me") return user?.id ?? null;
    const n = Number(userIdParam);
    return Number.isFinite(n) ? n : null;
  }, [userIdParam, user?.id]);

  const isSelf = Boolean(user && targetId != null && user.id === targetId);
  const base = profileBasePath(user?.role);

  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [colleagues, setColleagues] = useState<PublicProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: "",
    job_title: "",
    phone: "",
    mobile: "",
    bio: "",
    locale: "en" as Locale,
    itglue_user_id: "",
    board_email_opt_in: true,
  });
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const [pw, setPw] = useState({
    current: "",
    next: "",
    confirm: "",
  });
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user || targetId == null) {
        setLoading(false);
        setForbidden(true);
        return;
      }
      setLoading(true);
      setForbidden(false);
      const p = await getProfileInCompany(targetId, user.company_id);
      if (cancelled) return;
      if (!p) {
        setProfile(null);
        setForbidden(true);
        setLoading(false);
        return;
      }
      setProfile(p);
      setForm({
        name: p.name,
        job_title: p.job_title ?? "",
        phone: p.phone ?? "",
        mobile: p.mobile ?? "",
        bio: p.bio ?? "",
        locale: isLocale(p.locale) ? p.locale : locale,
        itglue_user_id: p.itglue_user_id ?? "",
        board_email_opt_in: p.board_email_opt_in !== false,
      });

      await dbReady;
      if (p.company_id != null) {
        const [cRows, dir] = await Promise.all([
          db
            .select()
            .from(schema.companies)
            .where(eq(schema.companies.id, p.company_id))
            .limit(1),
          listCompanyDirectory(p.company_id),
        ]);
        if (cancelled) return;
        setCompany((cRows[0] as Company | undefined) ?? null);
        setColleagues(dir.filter((c) => c.id !== p.id));
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, targetId, locale]);

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !isSelf) return;
    setSaving(true);
    setSaveErr(null);
    setSaveMsg(null);
    if (!form.name.trim()) {
      setSaveErr(t("common.required"));
      setSaving(false);
      return;
    }
    const updated = await updateOwnProfile(user.id, {
      name: form.name,
      job_title: form.job_title,
      phone: form.phone,
      mobile: form.mobile,
      bio: form.bio,
      locale: form.locale,
      itglue_user_id: form.itglue_user_id,
      board_email_opt_in: form.board_email_opt_in,
    });
    setSaving(false);
    if (!updated) {
      setSaveErr(t("common.tryAgain"));
      return;
    }
    setProfile(updated);
    patchSession(updated);
    if (isLocale(updated.locale)) setLocale(updated.locale);
    setSaveMsg(t("profile.profileUpdated"));
    setEditing(false);
  };

  const onPassword = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !isSelf) return;
    setPwBusy(true);
    setPwErr(null);
    setPwMsg(null);
    if (pw.next !== pw.confirm) {
      setPwErr(t("profile.passwordMismatch"));
      setPwBusy(false);
      return;
    }
    const res = await changeOwnPassword(user.id, pw.current, pw.next);
    setPwBusy(false);
    if (!res.ok) {
      setPwErr(
        res.error === "short"
          ? t("profile.passwordTooShort")
          : t("profile.wrongPassword"),
      );
      return;
    }
    setPw({ current: "", next: "", confirm: "" });
    setPwMsg(t("profile.passwordChanged"));
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-40 animate-pulse rounded-2xl bg-muted" />
        <div className="h-64 animate-pulse rounded-2xl bg-muted" />
      </div>
    );
  }

  if (forbidden || !profile) {
    return (
      <EmptyState
        icon={<Shield className="size-5" />}
        title={t("profile.notFound")}
        description={t("profile.notFoundDesc")}
        actionLabel={t("common.back")}
        onAction={() => navigate(base)}
      />
    );
  }

  return (
    <div className="space-y-6">
      <BlurFade delay={0.04}>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(-1)}
            className="gap-2"
          >
            <ArrowLeft className="size-4" />
            {t("common.back")}
          </Button>
          <Badge variant="outline" className="text-xs text-muted-foreground">
            {t("profile.isolationNote")}
          </Badge>
        </div>
      </BlurFade>

      <BlurFade delay={0.06}>
        <Card className="overflow-hidden">
          <div className="border-b border-border bg-gradient-to-br from-primary/15 via-card to-card px-6 py-8 sm:px-8">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
              <div className="flex size-20 shrink-0 items-center justify-center rounded-2xl bg-primary text-2xl font-extrabold text-primary-foreground shadow-lg shadow-primary/20">
                {initials(profile.name)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-2xl font-extrabold tracking-tight">
                    {profile.name}
                    {isSelf && (
                      <span className="ml-2 text-sm font-medium text-muted-foreground">
                        ({t("common.you")})
                      </span>
                    )}
                  </h2>
                  <Badge className="bg-primary text-primary-foreground hover:bg-primary">
                    {roleLabel(profile.role)}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={
                      profile.active
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : ""
                    }
                  >
                    {profile.active ? t("common.active") : t("common.inactive")}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {profile.job_title?.trim() || t("profile.noJobTitle")}
                </p>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <Mail className="size-3.5" />
                    {profile.email}
                  </span>
                  {company && (
                    <span className="inline-flex items-center gap-1.5">
                      <Building2 className="size-3.5" />
                      {company.name}
                    </span>
                  )}
                </div>
              </div>
              {isSelf && !editing && (
                <Button onClick={() => setEditing(true)} className="gap-2">
                  <UserIcon className="size-4" />
                  {t("profile.editProfile")}
                </Button>
              )}
            </div>
          </div>

          <CardContent className="grid gap-6 p-6 sm:grid-cols-2">
            <div className="space-y-3">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {t("profile.about")}
              </h3>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">
                {profile.bio?.trim() || (
                  <span className="text-muted-foreground">{t("profile.noBio")}</span>
                )}
              </p>
            </div>
            <div className="space-y-3">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {t("profile.contact")}
              </h3>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between gap-4 border-b border-border/60 py-2">
                  <dt className="text-muted-foreground">{t("common.email")}</dt>
                  <dd className="font-medium">{profile.email}</dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-border/60 py-2">
                  <dt className="text-muted-foreground">{t("common.phone")}</dt>
                  <dd className="font-medium">
                    {profile.phone?.trim() || t("profile.noPhone")}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-border/60 py-2">
                  <dt className="text-muted-foreground">{t("common.mobile")}</dt>
                  <dd className="font-medium">
                    {profile.mobile?.trim() || t("profile.noPhone")}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-border/60 py-2">
                  <dt className="text-muted-foreground">
                    {t("profile.memberSince")}
                  </dt>
                  <dd className="font-medium">
                    {formatDate(profile.created_at)}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-border/60 py-2">
                  <dt className="text-muted-foreground">
                    {profile.role === "client"
                      ? t("profile.myglueUserId")
                      : t("profile.itglueUserId")}
                  </dt>
                  <dd className="font-medium font-mono tabular-nums">
                    {profile.itglue_user_id?.trim()
                      ? `#${profile.itglue_user_id.trim()}`
                      : t("profile.vaultUserNotLinked")}
                  </dd>
                </div>
                {company && (
                  <div className="flex justify-between gap-4 py-2">
                    <dt className="text-muted-foreground">
                      {t("profile.companyZone")}
                    </dt>
                    <dd className="font-medium">{company.name}</dd>
                  </div>
                )}
              </dl>
            </div>
          </CardContent>
        </Card>
      </BlurFade>

      {isSelf && editing && (
        <BlurFade delay={0.08}>
          <Card>
            <CardHeader>
              <CardTitle>{t("profile.editProfile")}</CardTitle>
              <CardDescription>{t("profile.onlySelfEdit")}</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={onSave} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="pname">{t("common.name")}</Label>
                    <Input
                      id="pname"
                      value={form.name}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, name: e.target.value }))
                      }
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ptitle">{t("common.jobTitle")}</Label>
                    <Input
                      id="ptitle"
                      value={form.job_title}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, job_title: e.target.value }))
                      }
                      placeholder="e.g. IT Manager"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pphone">{t("common.phone")}</Label>
                    <Input
                      id="pphone"
                      value={form.phone}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, phone: e.target.value }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pmobile">{t("common.mobile")}</Label>
                    <Input
                      id="pmobile"
                      value={form.mobile}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, mobile: e.target.value }))
                      }
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pbio">{t("common.bio")}</Label>
                  <Textarea
                    id="pbio"
                    rows={4}
                    value={form.bio}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, bio: e.target.value }))
                    }
                    placeholder={t("profile.noBio")}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t("profile.preferredLanguage")}</Label>
                  <Select
                    value={form.locale}
                    onValueChange={(v) =>
                      setForm((f) => ({
                        ...f,
                        locale: isLocale(v) ? v : "en",
                      }))
                    }
                  >
                    <SelectTrigger className="w-full sm:w-64">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LOCALES.map((l) => (
                        <SelectItem key={l.code} value={l.code}>
                          {l.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {t("profile.preferredLanguageHint")}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="pitglue">
                    {user?.role === "client"
                      ? t("profile.myglueUserId")
                      : t("profile.itglueUserId")}
                  </Label>
                  <Input
                    id="pitglue"
                    inputMode="numeric"
                    placeholder={t("profile.itglueUserIdPh")}
                    value={form.itglue_user_id}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        itglue_user_id: e.target.value,
                      }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    {user?.role === "client"
                      ? t("profile.myglueUserIdHint")
                      : t("profile.itglueUserIdHint")}
                  </p>
                </div>

                <label className="flex items-start gap-3 rounded-lg border border-border bg-muted/20 p-3 text-sm">
                  <Checkbox
                    checked={form.board_email_opt_in}
                    onCheckedChange={(v) =>
                      setForm((f) => ({
                        ...f,
                        board_email_opt_in: v === true,
                      }))
                    }
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">
                      {t("profile.boardEmailOptIn")}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {t("profile.boardEmailOptInHint")}
                    </span>
                  </span>
                </label>

                {saveErr && (
                  <p className="text-sm text-destructive">{saveErr}</p>
                )}
                {saveMsg && (
                  <p className="flex items-center gap-1.5 text-sm text-primary">
                    <CheckCircle2 className="size-4" />
                    {saveMsg}
                  </p>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={saving} className="gap-2">
                    <Save className="size-4" />
                    {saving ? t("common.saving") : t("profile.saveProfile")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setEditing(false);
                      setSaveErr(null);
                      setSaveMsg(null);
                      setForm({
                        name: profile.name,
                        job_title: profile.job_title ?? "",
                        phone: profile.phone ?? "",
                        mobile: profile.mobile ?? "",
                        bio: profile.bio ?? "",
                        locale: isLocale(profile.locale)
                          ? profile.locale
                          : locale,
                        itglue_user_id: profile.itglue_user_id ?? "",
                        board_email_opt_in:
                          profile.board_email_opt_in !== false,
                      });
                    }}
                  >
                    {t("common.cancel")}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </BlurFade>
      )}

      {isSelf && (
        <BlurFade delay={0.1}>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Lock className="size-5 text-primary" />
                {t("profile.changePassword")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={onPassword} className="max-w-md space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="pcur">{t("profile.currentPassword")}</Label>
                  <Input
                    id="pcur"
                    type="password"
                    autoComplete="current-password"
                    value={pw.current}
                    onChange={(e) =>
                      setPw((p) => ({ ...p, current: e.target.value }))
                    }
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pnew">{t("profile.newPassword")}</Label>
                  <Input
                    id="pnew"
                    type="password"
                    autoComplete="new-password"
                    value={pw.next}
                    onChange={(e) =>
                      setPw((p) => ({ ...p, next: e.target.value }))
                    }
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pconf">{t("profile.confirmPassword")}</Label>
                  <Input
                    id="pconf"
                    type="password"
                    autoComplete="new-password"
                    value={pw.confirm}
                    onChange={(e) =>
                      setPw((p) => ({ ...p, confirm: e.target.value }))
                    }
                    required
                  />
                </div>
                {pwErr && <p className="text-sm text-destructive">{pwErr}</p>}
                {pwMsg && (
                  <p className="flex items-center gap-1.5 text-sm text-primary">
                    <CheckCircle2 className="size-4" />
                    {pwMsg}
                  </p>
                )}
                <Button type="submit" disabled={pwBusy} variant="outline">
                  {pwBusy ? t("common.saving") : t("profile.changePassword")}
                </Button>
              </form>
            </CardContent>
          </Card>
        </BlurFade>
      )}

      <BlurFade delay={0.12}>
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Users className="size-5 text-primary" />
                {t("profile.colleagues")}
              </CardTitle>
              <CardDescription>{t("profile.colleaguesDesc")}</CardDescription>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link to={`${base}/directory`}>{t("profile.openDirectory")}</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {colleagues.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("profile.noColleagues")}
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {colleagues.map((c) => (
                  <li key={c.id}>
                    <Link
                      to={`${base}/profile/${c.id}`}
                      className={cn(
                        "flex items-center gap-3 px-4 py-3 transition-colors",
                        "hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      )}
                    >
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold">
                        {initials(c.name)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{c.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {c.job_title?.trim() || roleLabel(c.role)}
                          {c.email ? ` · ${c.email}` : ""}
                        </p>
                      </div>
                      <Badge variant="outline">{roleLabel(c.role)}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </BlurFade>
    </div>
  );
}

export function DirectoryPage() {
  const { user } = useAuth();
  const { t } = useLocale();
  const base = profileBasePath(user?.role);
  const [people, setPeople] = useState<PublicProfile[]>([]);
  const [company, setCompany] = useState<Company | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user?.company_id) {
        setLoading(false);
        return;
      }
      await dbReady;
      const [dir, cRows] = await Promise.all([
        listCompanyDirectory(user.company_id),
        db
          .select()
          .from(schema.companies)
          .where(eq(schema.companies.id, user.company_id))
          .limit(1),
      ]);
      if (cancelled) return;
      setPeople(dir);
      setCompany((cRows[0] as Company | undefined) ?? null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.company_id]);

  const filtered = people.filter((p) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      p.email.toLowerCase().includes(q) ||
      (p.job_title ?? "").toLowerCase().includes(q) ||
      (p.phone ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <BlurFade delay={0.05}>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="size-5 text-primary" />
              {t("profile.directoryTitle")}
            </CardTitle>
            <CardDescription>
              {company
                ? `${company.name} · ${t("profile.directoryDesc")}`
                : t("profile.directoryDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input
              placeholder={t("common.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="max-w-md"
            />

            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-14 animate-pulse rounded-lg bg-muted" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={<Users className="size-5" />}
                title={t("common.noResults")}
                description={t("profile.noColleagues")}
              />
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {filtered.map((p) => {
                  const isYou = p.id === user?.id;
                  return (
                    <li key={p.id}>
                      <Link
                        to={
                          isYou
                            ? `${base}/profile/me`
                            : `${base}/profile/${p.id}`
                        }
                        className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-primary/5"
                      >
                        <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-bold text-primary">
                          {initials(p.name)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-semibold">
                            {p.name}
                            {isYou && (
                              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                                ({t("common.you")})
                              </span>
                            )}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {p.job_title?.trim() || roleLabel(p.role)} ·{" "}
                            {p.email}
                          </p>
                        </div>
                        <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
                          {p.phone && (
                            <span className="inline-flex items-center gap-1">
                              <Phone className="size-3" />
                              {p.phone}
                            </span>
                          )}
                          <Badge variant="outline">{roleLabel(p.role)}</Badge>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </BlurFade>
    </div>
  );
}
