import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, ChevronDown, ExternalLink, KeyRound, Link2, Loader2, PlugZap, RefreshCw, Sparkles, Unlink, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api, ApiError } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SectionHeader } from "./sections";

type ErrorCode = "not_configured" | "disabled" | "zone" | "auth" | "rate_limit" | "network" | "api";
type Settings = {
  enabled: boolean;
  username: string;
  hasSecret: boolean;
  hasIntegrationCode: boolean;
  configured: boolean;
  zone: { name: string; url: string; webUrl: string | null } | null;
  lastTest: { ok: boolean; at: string; error?: ErrorCode } | null;
  updatedAt: string | null;
  updatedByName: string | null;
};
type TestResult = { ok: true; zone: { name: string; webUrl: string | null }; usage: { used: number; limit: number } } | { ok: false; error: ErrorCode };
type Resource = { id: number; name: string; email: string | null };
type Links = {
  error: ErrorCode | null;
  resources: Resource[];
  staff: { id: string; name: string; email: string; active: boolean; resourceId: number | null; suggestedResourceId: number | null }[];
};

const KEY = ["admin", "integrations", "autotask"];

/** Translates an API error code (autotask_auth, autotask_resource_taken…) to text. */
function useIntegrationError() {
  const { t } = useTranslation();
  return (e: unknown) => {
    const code = e instanceof ApiError ? e.code.replace(/^autotask_/, "") : typeof e === "string" ? e : "";
    return t(`integrations.errors.${code}`, { defaultValue: t("common.error") });
  };
}

export function IntegrationsSection() {
  const { t } = useTranslation();
  return (
    <div className="space-y-8">
      <SectionHeader title={t("integrations.title")} subtitle={t("integrations.subtitle")} />
      <AutotaskConnection />
      <AutotaskLinks />
    </div>
  );
}

function StatusBadge({ s }: { s: Settings }) {
  const { t } = useTranslation();
  const [key, tone] = !s.configured
    ? ["notConfigured", "muted"]
    : !s.enabled
      ? ["disabled", "muted"]
      : s.lastTest?.ok === false
        ? ["error", "bad"]
        : s.lastTest?.ok
          ? ["connected", "good"]
          : ["enabledUntested", "gold"];
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5",
        tone === "good" && "border-emerald-500/40 text-emerald-400",
        tone === "bad" && "border-destructive/50 text-destructive",
        tone === "gold" && "border-[color:var(--gold)]/50 text-primary",
        tone === "muted" && "text-muted-foreground",
      )}
    >
      <span className={cn("size-1.5 rounded-full bg-current", tone === "good" && "animate-pulse")} />
      {t(`integrations.status.${key}`)}
    </Badge>
  );
}

function AutotaskConnection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const errorText = useIntegrationError();
  const { data: s, isLoading } = useQuery({ queryKey: KEY, queryFn: () => api.get<Settings>("/admin/integrations/autotask") });
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    if (!s) return;
    setUsername(s.username);
    setEnabled(s.enabled);
    setSecret("");
    setCode("");
  }, [s]);

  // Only send what changed; empty secret fields keep the saved values
  const draft = () => ({
    ...(username.trim() && username.trim() !== s?.username ? { username: username.trim() } : {}),
    ...(secret.trim() ? { secret: secret.trim() } : {}),
    ...(code.trim() ? { integrationCode: code.trim() } : {}),
  });

  const save = useMutation({
    mutationFn: () => api.put<Settings>("/admin/integrations/autotask", { ...draft(), enabled }),
    onSuccess: (next) => {
      qc.setQueryData(KEY, next);
      void qc.invalidateQueries({ queryKey: [...KEY, "links"] });
      setTest(null);
      toast.success(t("common.saved"));
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const runTest = useMutation({
    mutationFn: () => api.post<TestResult>("/admin/integrations/autotask/test", draft()),
    onSuccess: (r) => {
      setTest(r);
      void qc.invalidateQueries({ queryKey: KEY, exact: true });
    },
    onError: (e) => toast.error(errorText(e)),
  });

  if (isLoading || !s) return <Skeleton className="h-80 rounded-2xl" />;
  const dirty = Object.keys(draft()).length > 0 || enabled !== s.enabled;

  return (
    <section className="overflow-hidden rounded-2xl border bg-card/80">
      <div className="flex flex-wrap items-center gap-4 border-b px-6 py-5">
        <span className="flex size-11 items-center justify-center rounded-xl bg-grad-gold text-[#1a1204] glow-gold">
          <PlugZap className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-lg font-semibold">Autotask PSA</h3>
            <StatusBadge s={s} />
          </div>
          <p className="text-sm text-muted-foreground">{t("integrations.autotask.description")}</p>
        </div>
        <label className="flex items-center gap-3 text-sm font-medium">
          {t("integrations.enabled")}
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </label>
      </div>

      <form
        className="grid gap-6 px-6 py-6 lg:grid-cols-[1fr_280px]"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="at-user">{t("integrations.autotask.username")}</Label>
            <Input id="at-user" type="email" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="portail-api@akab.ca" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <SecretField id="at-secret" label={t("integrations.autotask.secret")} value={secret} onChange={setSecret} saved={s.hasSecret} />
            <SecretField id="at-code" label={t("integrations.autotask.integrationCode")} value={code} onChange={setCode} saved={s.hasIntegrationCode} />
          </div>
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <KeyRound className="size-3.5 text-primary" /> {t("integrations.secretNote")}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => runTest.mutate()} disabled={runTest.isPending}>
              {runTest.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {t("integrations.test")}
            </Button>
            <Button type="submit" disabled={!dirty || save.isPending} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
              {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
            </Button>
          </div>
          {test && <TestBanner r={test} />}
        </div>

        <dl className="space-y-3 rounded-xl border bg-background/40 p-4 text-sm">
          <Info label={t("integrations.autotask.zone")}>
            {s.zone ? (
              s.zone.webUrl ? (
                <a href={s.zone.webUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 hover:text-primary">
                  {s.zone.name || s.zone.url} <ExternalLink className="size-3" />
                </a>
              ) : (
                s.zone.name || s.zone.url
              )
            ) : (
              "—"
            )}
          </Info>
          <Info label={t("integrations.lastTest")}>
            {s.lastTest ? (
              <span className={cn("inline-flex items-center gap-1", s.lastTest.ok ? "text-emerald-400" : "text-destructive")}>
                {s.lastTest.ok ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
                {dateTime(s.lastTest.at)}
              </span>
            ) : (
              "—"
            )}
          </Info>
          {s.lastTest?.ok === false && s.lastTest.error && <p className="text-xs text-destructive">{errorText(s.lastTest.error)}</p>}
          <Info label={t("integrations.updated")}>{s.updatedAt ? `${dateTime(s.updatedAt)}${s.updatedByName ? ` · ${s.updatedByName}` : ""}` : "—"}</Info>
        </dl>
      </form>

      <div className="border-t px-6 py-3">
        <button type="button" onClick={() => setHelp((h) => !h)} className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ChevronDown className={cn("size-4 transition-transform", help && "rotate-180")} /> {t("integrations.autotask.helpTitle")}
        </button>
        {help && (
          <ol className="mt-3 list-decimal space-y-2 pb-3 pl-6 text-sm text-muted-foreground marker:text-primary">
            {(t("integrations.autotask.helpSteps", { returnObjects: true }) as string[]).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function SecretField({ id, label, value, onChange, saved }: { id: string; label: string; value: string; onChange: (v: string) => void; saved: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="flex items-center gap-2">
        {label}
        {saved && (
          <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">{t("integrations.savedValue")}</span>
        )}
      </Label>
      <Input
        id={id}
        type="password"
        autoComplete="new-password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={saved ? "••••••••••••" : ""}
      />
    </div>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function TestBanner({ r }: { r: TestResult }) {
  const { t } = useTranslation();
  const errorText = useIntegrationError();
  return r.ok ? (
    <div className="flex items-start gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" />
      <div>
        <p className="font-medium text-emerald-300">{t("integrations.testOk", { zone: r.zone.name })}</p>
        <p className="text-xs text-muted-foreground">{t("integrations.usage", { used: r.usage.used.toLocaleString(), limit: r.usage.limit.toLocaleString() })}</p>
      </div>
    </div>
  ) : (
    <div className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">
      <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
      <p>{errorText(r.error)}</p>
    </div>
  );
}

// ── Technicians ↔ Autotask users ───────────────────────────────────────────────
function AutotaskLinks() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const errorText = useIntegrationError();
  const { data: settings } = useQuery({ queryKey: KEY, queryFn: () => api.get<Settings>("/admin/integrations/autotask") });
  // "Refresh" re-reads the Autotask users instead of the 1-hour server cache, once
  const forceRefresh = useRef(false);
  const { data, isLoading, isFetching } = useQuery({
    queryKey: [...KEY, "links"],
    queryFn: () => {
      const q = forceRefresh.current ? "?refresh=1" : "";
      forceRefresh.current = false;
      return api.get<Links>(`/admin/integrations/autotask/links${q}`);
    },
    enabled: Boolean(settings?.configured),
  });
  const reload = () => void qc.invalidateQueries({ queryKey: [...KEY, "links"] });

  const link = useMutation({
    mutationFn: (p: { userId: string; resourceId: number | null }) => api.put(`/admin/integrations/autotask/links/${p.userId}`, { resourceId: p.resourceId }),
    onSuccess: reload,
    onError: (e) => toast.error(errorText(e)),
  });
  const auto = useMutation({
    mutationFn: () => api.post<{ linked: number }>("/admin/integrations/autotask/links/auto"),
    onSuccess: (r) => {
      toast.success(t("integrations.links.autoDone", { count: r.linked }));
      reload();
    },
    onError: (e) => toast.error(errorText(e)),
  });

  const resourceName = (id: number | null) => data?.resources.find((r) => r.id === id);
  const linkedCount = data?.staff.filter((s) => s.resourceId !== null).length ?? 0;
  const suggestions = data?.staff.filter((s) => s.suggestedResourceId !== null).length ?? 0;

  return (
    <section className="overflow-hidden rounded-2xl border bg-card/80">
      <div className="flex flex-wrap items-center gap-3 border-b px-6 py-5">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 font-display text-lg font-semibold">
            <Link2 className="size-5 text-primary" /> {t("integrations.links.title")}
          </h3>
          <p className="text-sm text-muted-foreground">{t("integrations.links.subtitle")}</p>
        </div>
        {settings?.configured && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                forceRefresh.current = true;
                reload();
              }}
              disabled={isFetching}
            >
              <RefreshCw className={cn("size-4", isFetching && "animate-spin")} /> {t("integrations.links.refresh")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => auto.mutate()} disabled={auto.isPending || !suggestions}>
              <Sparkles className="size-4" /> {t("integrations.links.auto")}
              {suggestions > 0 && <Badge className="ml-1 h-5 bg-grad-gold px-1.5 text-[#1a1204]">{suggestions}</Badge>}
            </Button>
          </>
        )}
      </div>

      {!settings?.configured ? (
        <p className="px-6 py-10 text-center text-sm text-muted-foreground">{t("integrations.links.needConnection")}</p>
      ) : isLoading || !data ? (
        <div className="space-y-2 p-6">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </div>
      ) : (
        <>
          {data.error && <p className="border-b bg-destructive/10 px-6 py-3 text-sm text-destructive">{errorText(data.error)}</p>}
          <ul className="divide-y">
            {data.staff.map((s) => {
              const current = resourceName(s.resourceId);
              const suggested = resourceName(s.suggestedResourceId);
              const taken = new Set(data.staff.filter((x) => x.id !== s.id && x.resourceId !== null).map((x) => x.resourceId));
              return (
                <li key={s.id} className={cn("flex flex-wrap items-center gap-3 px-6 py-3", !s.active && "opacity-50")}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{s.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{s.email}</p>
                  </div>
                  {s.resourceId === null && suggested && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 text-xs text-primary"
                      onClick={() => link.mutate({ userId: s.id, resourceId: suggested.id })}
                    >
                      <Sparkles className="size-3.5" /> {t("integrations.links.useSuggestion", { name: suggested.name })}
                    </Button>
                  )}
                  <Select
                    value={s.resourceId !== null ? String(s.resourceId) : "none"}
                    onValueChange={(v) => link.mutate({ userId: s.id, resourceId: v === "none" ? null : Number(v) })}
                  >
                    <SelectTrigger size="sm" className={cn("w-64", s.resourceId === null && "text-muted-foreground")} aria-label={t("integrations.links.for", { name: s.name })}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper" className="max-h-72">
                      <SelectItem value="none">
                        <Unlink className="size-3.5" /> {t("integrations.links.none")}
                      </SelectItem>
                      {data.resources
                        .filter((r) => !taken.has(r.id))
                        .map((r) => (
                          <SelectItem key={r.id} value={String(r.id)}>
                            {r.name} {r.email && <span className="text-xs text-muted-foreground">{r.email}</span>}
                          </SelectItem>
                        ))}
                      {current && !data.resources.some((r) => r.id === current.id) && <SelectItem value={String(current.id)}>#{current.id}</SelectItem>}
                    </SelectContent>
                  </Select>
                </li>
              );
            })}
          </ul>
          <p className="border-t px-6 py-3 text-xs text-muted-foreground">
            {t("integrations.links.count", { linked: linkedCount, total: data.staff.length })}
          </p>
        </>
      )}
    </section>
  );
}
