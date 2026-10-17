import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, CalendarDays, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, KeyRound, Link2, Loader2, MonitorPlay, PlugZap, RefreshCw, Sparkles, Unlink, XCircle, type LucideIcon, MessageSquareText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { useConfirm } from "@/components/ConfirmDialog";
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
  usage: { lastHour: number; throttled: number; limit: number; waiting: number };
  fallbackToApiUser: boolean;
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

/**
 * Available integrations. To add one: an entry here, its page component,
 * a Status component (badge on the card) and its texts under integrations.<key>.
 */
type Integration = { key: string; name: string; icon: LucideIcon; Status: () => ReactNode; Page: () => ReactNode };
const INTEGRATIONS: Integration[] = [
  {
    key: "autotask",
    name: "Autotask PSA",
    icon: PlugZap,
    Status: AutotaskStatus,
    Page: () => (
      <>
        <AutotaskConnection />
        <AutotaskLinks />
      </>
    ),
  },
  { key: "ai", name: "Claude (Anthropic)", icon: Sparkles, Status: AiStatus, Page: AiPage },
  { key: "o365", name: "Microsoft 365", icon: CalendarDays, Status: O365Status, Page: O365Page },
  { key: "voipms", name: "VoIP.ms (SMS)", icon: MessageSquareText, Status: VoipmsStatus, Page: VoipmsPage },
  { key: "rmm", name: "RMM", icon: MonitorPlay, Status: RmmStatus, Page: RmmPage },
];

/** List of integrations; opening one shows its page (?integration=<key>). */
export function IntegrationsSection() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const open = INTEGRATIONS.find((i) => i.key === params.get("integration")) ?? null;
  const go = (key: string | null) =>
    setParams((p) => {
      if (key) p.set("integration", key);
      else p.delete("integration");
      return p;
    });

  if (open) {
    return (
      <div className="space-y-8">
        <div>
          <Button variant="ghost" size="sm" className="-ml-2 mb-3 text-muted-foreground" onClick={() => go(null)}>
            <ArrowLeft className="size-4" /> {t("integrations.title")}
          </Button>
          <SectionHeader title={open.name} subtitle={t(`integrations.${open.key}.description`) || undefined} />
        </div>
        <open.Page />
      </div>
    );
  }

  return (
    <div>
      <SectionHeader title={t("integrations.title")} subtitle={t("integrations.subtitle")} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {INTEGRATIONS.map((i) => (
          <button
            key={i.key}
            type="button"
            onClick={() => go(i.key)}
            className="group flex flex-col gap-4 rounded-2xl border bg-card/80 p-5 text-left transition-all hover:-translate-y-0.5 hover:border-[color:var(--gold)]/40 hover:shadow-lg"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="flex size-11 items-center justify-center rounded-xl bg-grad-gold text-[#1a1204] glow-gold">
                <i.icon className="size-5" />
              </span>
              <i.Status />
            </div>
            <div>
              <h3 className="font-display text-lg font-semibold">{i.name}</h3>
              {t(`integrations.${i.key}.description`) && <p className="mt-1 text-sm text-muted-foreground">{t(`integrations.${i.key}.description`)}</p>}
            </div>
            <span className="mt-auto flex items-center gap-1 text-sm font-medium text-primary">
              {t("integrations.configure")} <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function AutotaskStatus() {
  const { data } = useQuery({ queryKey: KEY, queryFn: () => api.get<Settings>("/admin/integrations/autotask") });
  return data ? <StatusBadge s={data} /> : null;
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
          <h3 className="font-display text-lg font-semibold">{t("integrations.connection")}</h3>
          <div className="mt-1">
            <StatusBadge s={s} />
          </div>
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
          <Info label={t("integrations.autotask.usage")}>
            <span className={cn(s.usage.throttled ? "text-orange-300" : undefined)}>
              {t("integrations.autotask.usageValue", { calls: s.usage.lastHour.toLocaleString(), limit: s.usage.limit.toLocaleString() })}
              {s.usage.throttled > 0 && ` · ${t("integrations.autotask.usageThrottled", { count: s.usage.throttled })}`}
            </span>
          </Info>
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
      <FallbackToggle value={s.fallbackToApiUser} />
    </section>
  );
}

/** If Autotask refuses a change in the technician's name: save it as the API user (saved at once). */
function FallbackToggle({ value }: { value: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const errorText = useIntegrationError();
  const save = useMutation({
    mutationFn: (fallbackToApiUser: boolean) => api.put<Settings>("/admin/integrations/autotask", { fallbackToApiUser }),
    onSuccess: (next) => {
      qc.setQueryData(KEY, next);
      toast.success(t("common.saved"));
    },
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <label className="flex items-start gap-4 border-t px-6 py-5">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{t("integrations.autotask.fallback")}</span>
        <span className="mt-1 block text-xs text-muted-foreground">{t("integrations.autotask.fallbackHint")}</span>
      </span>
      <Switch checked={value} disabled={save.isPending} onCheckedChange={(v) => save.mutate(v)} />
    </label>
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

// ── AI assistant (Anthropic Claude) ───────────────────────────────────────────
type AiSettingsView = { enabled: boolean; model: string; models: string[]; hasKey: boolean; lastTest: { ok: boolean; at: string; error?: string } | null };
const AI_KEY = ["admin", "integrations", "ai"];

function AiStatus() {
  const { t } = useTranslation();
  const { data } = useQuery({ queryKey: AI_KEY, queryFn: () => api.get<AiSettingsView>("/admin/integrations/ai") });
  if (!data) return null;
  const [key, tone] = !data.hasKey ? ["notConfigured", "muted"] : !data.enabled ? ["disabled", "muted"] : data.lastTest?.ok === false ? ["error", "bad"] : ["connected", "good"];
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5", tone === "good" && "border-emerald-500/40 text-emerald-400", tone === "bad" && "border-destructive/50 text-destructive", tone === "muted" && "text-muted-foreground")}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {t(`integrations.status.${key}`)}
    </Badge>
  );
}

function AiPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: s, isLoading } = useQuery({ queryKey: AI_KEY, queryFn: () => api.get<AiSettingsView>("/admin/integrations/ai") });
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; error?: string; detail?: string } | null>(null);
  useEffect(() => {
    if (!s) return;
    setModel(s.model);
    setEnabled(s.enabled);
    setApiKey("");
  }, [s]);
  const save = useMutation({
    mutationFn: () => api.put<AiSettingsView>("/admin/integrations/ai", { enabled, model: model || s?.model, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }),
    onSuccess: (next) => {
      qc.setQueryData(AI_KEY, next);
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      setTest(null);
      toast.success(t("common.saved"));
    },
    onError: (e) => toast.error(e instanceof ApiError && e.code === "ai_incomplete" ? t("integrations.ai.needKey") : t("common.error")),
  });
  const runTest = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error?: string; detail?: string }>("/admin/integrations/ai/test", { model: model || s?.model, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }),
    onSuccess: (r) => {
      setTest(r);
      void qc.invalidateQueries({ queryKey: AI_KEY });
    },
  });
  if (isLoading || !s) return <Skeleton className="h-72 rounded-2xl" />;
  return (
    <section className="overflow-hidden rounded-2xl border bg-card/80">
      <div className="flex flex-wrap items-center gap-4 border-b px-6 py-5">
        <span className="flex size-11 items-center justify-center rounded-xl bg-violet-500/20 text-violet-200">
          <Sparkles className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-lg font-semibold">{t("integrations.connection")}</h3>
          <div className="mt-1">
            <AiStatus />
          </div>
        </div>
        <label className="flex items-center gap-3 text-sm font-medium">
          {t("integrations.enabled")}
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </label>
      </div>
      <form
        className="space-y-4 px-6 py-6"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-[1fr_240px]">
          <div className="space-y-2">
            <Label htmlFor="ai-key" className="flex items-center gap-2">
              {t("integrations.ai.apiKey")}
              {s.hasKey && <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">{t("integrations.savedValue")}</span>}
            </Label>
            <Input id="ai-key" type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={s.hasKey ? "••••••••••••" : "sk-ant-…"} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ai-model">{t("integrations.ai.model")}</Label>
            <Select value={model || s.model} onValueChange={setModel}>
              <SelectTrigger id="ai-model" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {s.models.map((m) => (
                  <SelectItem key={m} value={m}>
                    {t(`integrations.ai.models.${m}`, { defaultValue: m })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <KeyRound className="mt-0.5 size-3.5 shrink-0 text-primary" /> {t("integrations.ai.note")}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => runTest.mutate()} disabled={runTest.isPending}>
            {runTest.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {t("integrations.test")}
          </Button>
          <Button type="submit" disabled={save.isPending} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
            {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
          </Button>
        </div>
        {test &&
          (test.ok ? (
            <p className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">
              <CheckCircle2 className="size-4" /> {t("integrations.ai.testOk")}
            </p>
          ) : (
            <p className="flex items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">
              <XCircle className="size-4 shrink-0 text-destructive" />
              <span>
                {t(`tickets.ai.errors.${test.error}`, { defaultValue: t("tickets.ai.errors.api") })}
                {test.detail && <span className="block font-mono text-xs text-muted-foreground">{test.detail}</span>}
              </span>
            </p>
          ))}
      </form>
    </section>
  );
}

// ── RMM: links to the device page and the web remote control ──
type RmmView = { enabled: boolean; name: string; deviceUrl: string; remoteUrl: string; placeholders: string[] };
const RMM_KEY = ["admin", "integrations", "rmm"];

function RmmStatus() {
  const { t } = useTranslation();
  const { data } = useQuery({ queryKey: RMM_KEY, queryFn: () => api.get<RmmView>("/admin/integrations/rmm") });
  if (!data) return null;
  const on = data.enabled && Boolean(data.deviceUrl || data.remoteUrl);
  return (
    <Badge variant="outline" className={cn("gap-1.5", on ? "border-emerald-500/40 text-emerald-400" : "text-muted-foreground")}>
      <span className="size-1.5 rounded-full bg-current" />
      {t(`integrations.status.${on ? "connected" : data.deviceUrl || data.remoteUrl ? "disabled" : "notConfigured"}`)}
    </Badge>
  );
}

/** Example values to preview the links. */
const SAMPLE = { uid: "3f2a9c1e-7b4d-4e0a-9c55-1d2e3f4a5b6c", id: "884213", hostname: "CLIENT-PT01", serial: "5CD1234X7Q", ip: "10.0.0.25" } as Record<string, string>;
const preview = (tpl: string) => tpl.replace(/\{(\w+)\}/g, (m, k: string) => SAMPLE[k] ?? m);

function RmmPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: s, isLoading } = useQuery({ queryKey: RMM_KEY, queryFn: () => api.get<RmmView>("/admin/integrations/rmm") });
  const [form, setForm] = useState({ enabled: false, name: "", deviceUrl: "", remoteUrl: "" });
  useEffect(() => {
    if (s) setForm({ enabled: s.enabled, name: s.name, deviceUrl: s.deviceUrl, remoteUrl: s.remoteUrl });
  }, [s]);
  const save = useMutation({
    mutationFn: () => api.put<RmmView>("/admin/integrations/rmm", form),
    onSuccess: (next) => {
      qc.setQueryData(RMM_KEY, next);
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      toast.success(t("common.saved"));
    },
    onError: (e) => toast.error(e instanceof ApiError && e.code === "rmm_incomplete" ? t("integrations.rmm.needUrl") : t("integrations.rmm.badUrl")),
  });
  if (isLoading || !s) return <Skeleton className="h-72 rounded-2xl" />;
  const field = (key: "deviceUrl" | "remoteUrl") => (
    <div className="space-y-2">
      <Label htmlFor={`rmm-${key}`}>{t(`integrations.rmm.${key}`)}</Label>
      <Input
        id={`rmm-${key}`}
        value={form[key]}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        placeholder="https://…/{uid}"
        className="font-mono text-xs"
      />
      {form[key] && (
        <p className="truncate font-mono text-[11px] text-muted-foreground" title={preview(form[key])}>
          → {preview(form[key])}
        </p>
      )}
    </div>
  );
  return (
    <section className="overflow-hidden rounded-2xl border bg-card/80">
      <div className="flex flex-wrap items-center gap-4 border-b px-6 py-5">
        <span className="flex size-11 items-center justify-center rounded-xl bg-grad-gold text-[#1a1204]">
          <MonitorPlay className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-lg font-semibold">{t("integrations.rmm.links")}</h3>
          <div className="mt-1">
            <RmmStatus />
          </div>
        </div>
        <label className="flex items-center gap-3 text-sm font-medium">
          {t("integrations.enabled")}
          <Switch checked={form.enabled} onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))} />
        </label>
      </div>
      <form
        className="space-y-5 px-6 py-6"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="max-w-xs space-y-2">
          <Label htmlFor="rmm-name">{t("integrations.rmm.name")}</Label>
          <Input id="rmm-name" value={form.name} maxLength={60} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Datto RMM" />
        </div>
        {field("remoteUrl")}
        {field("deviceUrl")}
        <div className="rounded-xl border bg-background/40 p-4 text-xs text-muted-foreground">
          <p className="mb-2">{t("integrations.rmm.help")}</p>
          <ul className="grid gap-1 sm:grid-cols-2">
            {s.placeholders.map((p) => (
              <li key={p}>
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-primary">{`{${p}}`}</code> {t(`integrations.rmm.ph.${p}`)}
              </li>
            ))}
          </ul>
        </div>
        <Button type="submit" disabled={save.isPending} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
          {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
        </Button>
      </form>
    </section>
  );
}

// ── Microsoft 365: technicians' Outlook calendars (Microsoft Graph) ──
type O365View = { enabled: boolean; tenantId: string; clientId: string; hasSecret: boolean; lastTest: { ok: boolean; at: string; error?: string } | null; redirectUri?: string | null };
const O365_KEY = ["admin", "integrations", "o365"];

function O365Status() {
  const { t } = useTranslation();
  const { data } = useQuery({ queryKey: O365_KEY, queryFn: () => api.get<O365View>("/admin/integrations/o365") });
  if (!data) return null;
  const complete = data.tenantId && data.clientId && data.hasSecret;
  const [key, tone] = !complete ? ["notConfigured", "muted"] : !data.enabled ? ["disabled", "muted"] : data.lastTest?.ok === false ? ["error", "bad"] : ["connected", "good"];
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5", tone === "good" && "border-emerald-500/40 text-emerald-400", tone === "bad" && "border-destructive/50 text-destructive", tone === "muted" && "text-muted-foreground")}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {t(`integrations.status.${key}`)}
    </Badge>
  );
}

function O365Page() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: s, isLoading } = useQuery({ queryKey: O365_KEY, queryFn: () => api.get<O365View>("/admin/integrations/o365") });
  const [form, setForm] = useState({ tenantId: "", clientId: "", secret: "", enabled: false, email: "" });
  const [test, setTest] = useState<{ ok: boolean; error?: string; detail?: string } | null>(null);
  useEffect(() => {
    if (s) setForm((f) => ({ ...f, tenantId: s.tenantId, clientId: s.clientId, secret: "", enabled: s.enabled }));
  }, [s]);
  const changed = () => ({
    ...(form.tenantId.trim() && form.tenantId.trim() !== s?.tenantId ? { tenantId: form.tenantId.trim() } : {}),
    ...(form.clientId.trim() && form.clientId.trim() !== s?.clientId ? { clientId: form.clientId.trim() } : {}),
    ...(form.secret.trim() ? { secret: form.secret.trim() } : {}),
  });
  const save = useMutation({
    mutationFn: () => api.put<O365View>("/admin/integrations/o365", { ...changed(), enabled: form.enabled }),
    onSuccess: (next) => {
      qc.setQueryData(O365_KEY, next);
      void qc.invalidateQueries({ queryKey: ["planning"] });
      setTest(null);
      toast.success(t("common.saved"));
    },
    onError: (e) => toast.error(e instanceof ApiError && e.code === "o365_incomplete" ? t("integrations.o365.needAll") : t("common.error")),
  });
  const runTest = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error?: string; detail?: string }>("/admin/integrations/o365/test", { ...changed(), ...(form.email.trim() ? { email: form.email.trim() } : {}) }),
    onSuccess: (r) => {
      setTest(r);
      void qc.invalidateQueries({ queryKey: O365_KEY });
    },
  });
  if (isLoading || !s) return <Skeleton className="h-72 rounded-2xl" />;
  return (
    <section className="overflow-hidden rounded-2xl border bg-card/80">
      <div className="flex flex-wrap items-center gap-4 border-b px-6 py-5">
        <span className="flex size-11 items-center justify-center rounded-xl bg-sky-500/20 text-sky-200">
          <CalendarDays className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-lg font-semibold">{t("integrations.connection")}</h3>
          <div className="mt-1">
            <O365Status />
          </div>
        </div>
        <label className="flex items-center gap-3 text-sm font-medium">
          {t("integrations.enabled")}
          <Switch checked={form.enabled} onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))} />
        </label>
      </div>
      <form
        className="space-y-4 px-6 py-6"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="o365-tenant">{t("integrations.o365.tenantId")}</Label>
            <Input id="o365-tenant" value={form.tenantId} onChange={(e) => setForm((f) => ({ ...f, tenantId: e.target.value }))} placeholder="akab.onmicrosoft.com" className="font-mono text-xs" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="o365-client">{t("integrations.o365.clientId")}</Label>
            <Input id="o365-client" value={form.clientId} onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value }))} placeholder="00000000-0000-0000-0000-000000000000" className="font-mono text-xs" />
          </div>
        </div>
        <SecretField id="o365-secret" label={t("integrations.o365.secret")} value={form.secret} onChange={(v) => setForm((f) => ({ ...f, secret: v }))} saved={s.hasSecret} />
        {s.redirectUri && (
          <div className="space-y-2">
            <Label>{t("integrations.o365.redirectUri")}</Label>
            <div className="flex gap-2">
              <Input readOnly value={s.redirectUri} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button type="button" variant="outline" onClick={() => void navigator.clipboard.writeText(s.redirectUri!).then(() => toast.success(t("integrations.voipms.copied")))}>
                {t("integrations.voipms.copy")}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">{t("integrations.o365.redirectHint")}</p>
          </div>
        )}
        <div className="rounded-xl border bg-background/40 p-4 text-xs text-muted-foreground">
          <p className="mb-2 font-medium text-foreground">{t("integrations.o365.howTitle")}</p>
          <ol className="list-decimal space-y-1 pl-4">
            {(t("integrations.o365.how", { returnObjects: true }) as string[]).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-56 flex-1 space-y-2">
            <Label htmlFor="o365-email">{t("integrations.o365.testMailbox")}</Label>
            <Input id="o365-email" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} placeholder={t("integrations.o365.testMailboxHint")} />
          </div>
          <Button type="button" variant="outline" onClick={() => runTest.mutate()} disabled={runTest.isPending}>
            {runTest.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {t("integrations.test")}
          </Button>
          <Button type="submit" disabled={save.isPending} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
            {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
          </Button>
        </div>
        {test &&
          (test.ok ? (
            <p className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">
              <CheckCircle2 className="size-4" /> {t("integrations.o365.testOk")}
            </p>
          ) : (
            <p className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">
              <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
              <span>
                {t(`integrations.o365.errors.${test.error}`, { defaultValue: t("integrations.o365.errors.api") })}
                {test.detail && <span className="block text-xs text-muted-foreground">{test.detail}</span>}
              </span>
            </p>
          ))}
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <KeyRound className="mt-0.5 size-3.5 shrink-0 text-primary" /> {t("integrations.o365.rightsNote")}
        </p>
      </form>
    </section>
  );
}

// ── VoIP.ms: text messages with clients ──
type VoipmsView = {
  enabled: boolean;
  username: string;
  hasPassword: boolean;
  did: string;
  autoTicketMinutes: number;
  autoReply: string;
  ticketOpened: string;
  ticketTimeout: string;
  defaultCompanyId: number | null;
  defaultCompanyName: string | null;
  queue: string | null;
  priority: string | null;
  lastTest?: { ok: boolean; at: string; error?: string } | null;
  callbackUrl: string | null;
  publicUrlSet: boolean;
};
const VOIPMS_KEY = ["admin", "integrations", "voipms"];

function VoipmsStatus() {
  const { t } = useTranslation();
  const { data } = useQuery({ queryKey: VOIPMS_KEY, queryFn: () => api.get<VoipmsView>("/admin/integrations/voipms") });
  if (!data) return null;
  const complete = data.username && data.hasPassword && data.did;
  const [key, tone] = !complete ? ["notConfigured", "muted"] : !data.enabled ? ["disabled", "muted"] : data.lastTest?.ok === false ? ["error", "bad"] : ["connected", "good"];
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5", tone === "good" && "border-emerald-500/40 text-emerald-400", tone === "bad" && "border-destructive/50 text-destructive", tone === "muted" && "text-muted-foreground")}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {t(`integrations.status.${key}`)}
    </Badge>
  );
}

function VoipmsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: s, isLoading } = useQuery({ queryKey: VOIPMS_KEY, queryFn: () => api.get<VoipmsView>("/admin/integrations/voipms") });
  const { data: options } = useQuery({
    queryKey: ["admin", "voipms", "options"],
    queryFn: async () => {
      const [companies, list] = await Promise.all([
        api.get<{ id: number; name: string }[]>("/tickets/companies"),
        api.get<{ facets: { priorities: { value: string; label: string | null; kind: string }[]; queues: { value: string; label: string | null }[] } }>("/tickets?view=unassigned"),
      ]);
      return { companies, priorities: list.facets.priorities, queues: list.facets.queues };
    },
    staleTime: 5 * 60_000,
  });
  const [f, setF] = useState({ username: "", password: "", did: "", enabled: false, minutes: "240", autoReply: "", ticketOpened: "", ticketTimeout: "", companyId: "", queue: "", priority: "", sendTo: "" });
  const [test, setTest] = useState<{ ok: boolean; error?: string; detail?: string } | null>(null);
  useEffect(() => {
    if (s)
      setF((x) => ({
        ...x,
        username: s.username,
        password: "",
        did: s.did,
        enabled: s.enabled,
        minutes: String(s.autoTicketMinutes),
        autoReply: s.autoReply,
        ticketOpened: s.ticketOpened,
        ticketTimeout: s.ticketTimeout,
        companyId: s.defaultCompanyId ? String(s.defaultCompanyId) : "",
        queue: s.queue ?? "",
        priority: s.priority ?? "",
      }));
  }, [s]);
  const set = (k: keyof typeof f) => (v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: (extra: { newToken?: boolean } = {}) => {
      const company = options?.companies.find((c) => String(c.id) === f.companyId);
      return api.put<VoipmsView>("/admin/integrations/voipms", {
        enabled: f.enabled,
        ...(f.username.trim() ? { username: f.username.trim() } : {}),
        ...(f.password.trim() ? { password: f.password.trim() } : {}),
        did: f.did,
        autoTicketMinutes: Math.max(1, Number(f.minutes) || 15),
        autoReply: f.autoReply.trim(),
        ticketOpened: f.ticketOpened.trim(),
        ticketTimeout: f.ticketTimeout.trim(),
        defaultCompanyId: company ? company.id : null,
        defaultCompanyName: company ? company.name : null,
        queue: f.queue || null,
        priority: f.priority || null,
        ...extra,
      });
    },
    onSuccess: (next) => {
      qc.setQueryData(VOIPMS_KEY, next);
      void qc.invalidateQueries({ queryKey: ["sms"] });
      toast.success(t("common.saved"));
    },
    onError: (e) => toast.error(e instanceof ApiError ? t(`integrations.voipms.errors.${e.code}`, { defaultValue: t("common.error") }) : t("common.error")),
  });
  const runTest = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; error?: string; detail?: string }>("/admin/integrations/voipms/test", {
        ...(f.username.trim() && f.username.trim() !== s?.username ? { username: f.username.trim() } : {}),
        ...(f.password.trim() ? { password: f.password.trim() } : {}),
        ...(f.sendTo.trim() ? { sendTo: f.sendTo.trim() } : {}),
      }),
    onSuccess: (r) => {
      setTest(r);
      void qc.invalidateQueries({ queryKey: VOIPMS_KEY });
    },
    onError: () => setTest({ ok: false, error: "api" }),
  });
  if (isLoading || !s) return <Skeleton className="h-96 rounded-2xl" />;
  const pick = (k: "companyId" | "queue" | "priority", label: string, list: { value: string; label: string }[], none: string) => (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={f[k] || "_"} onValueChange={(v) => set(k)(v === "_" ? "" : v)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" className="max-h-72">
          <SelectItem value="_">{none}</SelectItem>
          {list.map((x) => (
            <SelectItem key={x.value} value={x.value}>
              {x.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
  return (
    <section className="overflow-hidden rounded-2xl border bg-card/80">
      <div className="flex flex-wrap items-center gap-4 border-b px-6 py-5">
        <span className="flex size-11 items-center justify-center rounded-xl bg-grad-gold text-[#1a1204]">
          <MessageSquareText className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-lg font-semibold">{t("integrations.connection")}</h3>
          <div className="mt-1">
            <VoipmsStatus />
          </div>
        </div>
        <label className="flex items-center gap-3 text-sm font-medium">
          {t("integrations.enabled")}
          <Switch checked={f.enabled} onCheckedChange={(v) => set("enabled")(v)} />
        </label>
      </div>
      <form
        className="space-y-6 px-6 py-6"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate({});
        }}
      >
        {/* 1. The account */}
        <div className="space-y-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("integrations.voipms.account")}</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="vm-user">{t("integrations.voipms.username")}</Label>
              <Input id="vm-user" type="email" value={f.username} onChange={(e) => set("username")(e.target.value)} placeholder="vous@akab.ca" />
            </div>
            <SecretField id="vm-pass" label={t("integrations.voipms.password")} value={f.password} onChange={(v) => set("password")(v)} saved={s.hasPassword} />
            <div className="space-y-2">
              <Label htmlFor="vm-did">{t("integrations.voipms.did")}</Label>
              <Input id="vm-did" type="tel" value={f.did} onChange={(e) => set("did")(e.target.value)} placeholder="450 555-0100" />
            </div>
          </div>
          <div className="rounded-xl border bg-background/40 p-4 text-xs text-muted-foreground">
            <p className="mb-2 font-medium text-foreground">{t("integrations.voipms.howTitle")}</p>
            <ol className="list-decimal space-y-1 pl-4">
              {(t("integrations.voipms.how", { returnObjects: true }) as string[]).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
          </div>
          <div className="space-y-2">
            <Label>{t("integrations.voipms.callback")}</Label>
            {s.callbackUrl ? (
              <div className="flex gap-2">
                <Input readOnly value={s.callbackUrl} className="font-mono text-[11px]" onFocus={(e) => e.currentTarget.select()} />
                <Button type="button" variant="outline" onClick={() => void navigator.clipboard.writeText(s.callbackUrl!).then(() => toast.success(t("integrations.voipms.copied")))}>
                  {t("integrations.voipms.copy")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void confirm({ title: t("integrations.voipms.newTokenConfirm"), destructive: true }).then((ok) => ok && save.mutate({ newToken: true }))}
                >
                  {t("integrations.voipms.newToken")}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t("integrations.voipms.saveFirst")}</p>
            )}
            {!s.publicUrlSet && <p className="text-xs text-orange-300">{t("integrations.voipms.publicUrl")}</p>}
          </div>
        </div>

        {/* 2. What the client receives, and when it becomes a ticket */}
        <div className="space-y-4 border-t pt-5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("integrations.voipms.flow")}</p>
          <div className="space-y-2">
            <Label htmlFor="vm-auto">{t("integrations.voipms.autoReply")}</Label>
            <Textarea id="vm-auto" rows={3} maxLength={600} value={f.autoReply} onChange={(e) => set("autoReply")(e.target.value)} />
            <p className="text-[11px] text-muted-foreground">{t("integrations.voipms.autoReplyHint")}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
            <div className="space-y-2">
              <Label htmlFor="vm-min">{t("integrations.voipms.minutes")}</Label>
              <Input id="vm-min" inputMode="numeric" value={f.minutes} onChange={(e) => set("minutes")(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="vm-opened">{t("integrations.voipms.ticketOpened")}</Label>
              <Textarea id="vm-opened" rows={2} maxLength={600} value={f.ticketOpened} onChange={(e) => set("ticketOpened")(e.target.value)} />
              <p className="text-[11px] text-muted-foreground">{t("integrations.voipms.ticketOpenedHint")}</p>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="vm-timeout">{t("integrations.voipms.ticketTimeout")}</Label>
            <Textarea id="vm-timeout" rows={2} maxLength={600} value={f.ticketTimeout} onChange={(e) => set("ticketTimeout")(e.target.value)} />
            <p className="text-[11px] text-muted-foreground">{t("integrations.voipms.ticketOpenedHint")}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {pick(
              "companyId",
              t("integrations.voipms.defaultCompany"),
              (options?.companies ?? []).map((c) => ({ value: String(c.id), label: c.name })),
              t("integrations.voipms.noDefault"),
            )}
            {pick("queue", t("tickets.fields.queue"), (options?.queues ?? []).map((q) => ({ value: q.value, label: q.label ?? q.value })), t("integrations.voipms.firstQueue"))}
            {pick("priority", t("tickets.fields.priority"), (options?.priorities ?? []).map((p) => ({ value: p.value, label: p.label ?? t(`tickets.priority.${p.kind}`) })), t("integrations.voipms.mediumPriority"))}
          </div>
          <p className="text-[11px] text-muted-foreground">{t("integrations.voipms.defaultCompanyHint")}</p>
        </div>

        <div className="flex flex-wrap items-end gap-2 border-t pt-5">
          <div className="min-w-48 flex-1 space-y-2">
            <Label htmlFor="vm-test">{t("integrations.voipms.testTo")}</Label>
            <Input id="vm-test" type="tel" value={f.sendTo} onChange={(e) => set("sendTo")(e.target.value)} placeholder={t("integrations.voipms.testToHint")} />
          </div>
          <Button type="button" variant="outline" onClick={() => runTest.mutate()} disabled={runTest.isPending}>
            {runTest.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {t("integrations.test")}
          </Button>
          <Button type="submit" disabled={save.isPending} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
            {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
          </Button>
        </div>
        {test &&
          (test.ok ? (
            <p className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">
              <CheckCircle2 className="size-4" /> {f.sendTo ? t("integrations.voipms.testSent") : t("integrations.voipms.testOk")}
            </p>
          ) : (
            <p className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">
              <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
              <span>
                {t("integrations.voipms.testFailed")}
                {test.detail && <span className="block font-mono text-xs text-muted-foreground">{test.detail}</span>}
              </span>
            </p>
          ))}
      </form>
    </section>
  );
}
