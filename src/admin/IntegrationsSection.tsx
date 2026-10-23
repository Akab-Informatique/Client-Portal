import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Users, Cloud, ArrowLeft, CalendarDays, CheckCircle2, ChevronRight, CreditCard, KeyRound, Loader2, MonitorPlay, RefreshCw, Sparkles, XCircle, type LucideIcon, MessageSquareText } from "lucide-react";
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
import { cn } from "@/lib/utils";
import type { PermissionKey } from "@shared/permissions";
import { useCan } from "@/lib/session";
import { SectionHeader } from "./sections";
import { StripePage, StripeStatus } from "./StripeIntegration";
import { QuickBooksPage, QuickBooksStatus } from "./QuickBooksIntegration";
import { ITCloudPage, ITCloudStatus } from "./ITCloudIntegration";
import { AI_USAGE_KEY, AiUsagePanel } from "./AiUsage";
import { shortModel } from "@/components/AiModelPicker";

/**
 * Available integrations. To add one: an entry here, its page component,
 * a Status component (badge on the card) and its texts under integrations.<key>.
 */
type Integration = { key: string; name: string; icon: LucideIcon; Status: () => ReactNode; Page: () => ReactNode; /** An extra right needed to see it */ needs?: PermissionKey };
const INTEGRATIONS: Integration[] = [
  { key: "ai", name: "Claude (Anthropic)", icon: Sparkles, Status: AiStatus, Page: AiPage },
  { key: "o365", name: "Microsoft 365", icon: CalendarDays, Status: O365Status, Page: O365Page },
  { key: "voipms", name: "VoIP.ms (SMS)", icon: MessageSquareText, Status: VoipmsStatus, Page: VoipmsPage },
  // card payments on invoices: master administrators (the API needs billing and integrations)
  { key: "stripe", name: "Stripe", icon: CreditCard, Status: StripeStatus, Page: StripePage, needs: "admin.billing" },
  // clients, chart of accounts and vendors kept in step, and invoices and payments (the API needs billing and integrations)
  { key: "quickbooks", name: "QuickBooks Online", icon: RefreshCw, Status: QuickBooksStatus, Page: QuickBooksPage, needs: "admin.billing" },
  // a vendor: its customers matched to clients, its products as services, its services kept on contracts
  { key: "itcloud", name: "ITCloud", icon: Cloud, Status: ITCloudStatus, Page: ITCloudPage },
  { key: "passbolt", name: "Passbolt", icon: KeyRound, Status: PassboltStatus, Page: PassboltAdminPage },
  { key: "teams", name: "Microsoft Teams", icon: Users, Status: TeamsStatus, Page: TeamsPage },
  { key: "rmm", name: "RMM", icon: MonitorPlay, Status: RmmStatus, Page: RmmPage },
];

/** List of integrations; opening one shows its page (?integration=<key>). */
export function IntegrationsSection() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const can = useCan();
  const shownIntegrations = INTEGRATIONS.filter((i) => !i.needs || can(i.needs));
  const open = shownIntegrations.find((i) => i.key === params.get("integration")) ?? null;
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
        {shownIntegrations.map((i) => (
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

// ── AI assistant (Anthropic Claude) ───────────────────────────────────────────
type AiSettingsView = {
  enabled: boolean;
  model: string;
  models: string[];
  hasKey: boolean;
  lastTest: { ok: boolean; at: string; error?: string } | null;
  /** Per part of the portal: its own model, or null (the general one) */
  features: { key: string; model: string | null; default?: string | null }[];
  allowChoice: boolean;
  dailyLimitUsd: number | null;
  prices: Record<string, { input: number; output: number }>;
};
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
  const [featureModels, setFeatureModels] = useState<Record<string, string>>({});
  const [allowChoice, setAllowChoice] = useState(true);
  const [limit, setLimit] = useState("");
  const [test, setTest] = useState<{ ok: boolean; error?: string; detail?: string } | null>(null);
  useEffect(() => {
    if (!s) return;
    setModel(s.model);
    setEnabled(s.enabled);
    setApiKey("");
    setFeatureModels(Object.fromEntries(s.features.filter((x) => x.model).map((x) => [x.key, x.model!])));
    setAllowChoice(s.allowChoice);
    setLimit(s.dailyLimitUsd === null ? "" : String(s.dailyLimitUsd));
  }, [s]);
  const limitValue = limit.trim() === "" ? null : Number(limit.replace(",", "."));
  const save = useMutation({
    mutationFn: () =>
      api.put<AiSettingsView>("/admin/integrations/ai", {
        enabled,
        model: model || s?.model,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        featureModels,
        allowChoice,
        dailyLimitUsd: limitValue,
      }),
    onSuccess: (next) => {
      qc.setQueryData(AI_KEY, next);
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      void qc.invalidateQueries({ queryKey: ["ai", "options"] });
      void qc.invalidateQueries({ queryKey: AI_USAGE_KEY });
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
    <div className="space-y-5">
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

        {/* A model per part of the portal */}
        <div className="space-y-3 rounded-xl border bg-background/40 p-4">
          <div>
            <p className="text-sm font-medium">{t("integrations.ai.perFeature")}</p>
            <p className="text-xs text-muted-foreground">{t("integrations.ai.perFeatureHint")}</p>
          </div>
          <ul className="divide-y rounded-lg border">
            {s.features.map((fe) => (
              <li key={fe.key} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <span className="min-w-40 flex-1 text-sm">{t(`integrations.ai.features.${fe.key.replace(/\./g, "_")}`, { defaultValue: fe.key })}</span>
                <Select value={featureModels[fe.key] ?? "general"} onValueChange={(v) => setFeatureModels((m) => (v === "general" ? Object.fromEntries(Object.entries(m).filter(([k]) => k !== fe.key)) : { ...m, [fe.key]: v }))}>
                  <SelectTrigger className="h-8 w-60 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="general">
                      {fe.default ? t("integrations.ai.featureDefault", { model: shortModel(fe.default) }) : t("integrations.ai.generalModel", { model: shortModel(model || s.model) })}
                    </SelectItem>
                    {s.models.map((m) => (
                      <SelectItem key={m} value={m}>
                        {shortModel(m)} · {t("integrations.ai.price", { input: s.prices[m]?.input, output: s.prices[m]?.output })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </li>
            ))}
          </ul>
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>
              {t("integrations.ai.allowChoice")}
              <span className="block text-xs text-muted-foreground">{t("integrations.ai.allowChoiceHint")}</span>
            </span>
            <Switch checked={allowChoice} onCheckedChange={setAllowChoice} />
          </label>
        </div>

        {/* Spending per person per day */}
        <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-background/40 p-4">
          <div className="min-w-56 flex-1 space-y-1">
            <Label htmlFor="ai-limit">{t("integrations.ai.dailyLimit")}</Label>
            <p className="text-xs text-muted-foreground">{t("integrations.ai.dailyLimitHint")}</p>
          </div>
          <div className="relative w-36">
            <Input id="ai-limit" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder={t("integrations.ai.usage.noLimit")} className="pr-8" />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => runTest.mutate()} disabled={runTest.isPending}>
            {runTest.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {t("integrations.test")}
          </Button>
          <Button type="submit" disabled={save.isPending || (limitValue !== null && !(limitValue >= 0))} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
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
    {s.hasKey && <AiUsagePanel />}
    </div>
  );
}

// ── Passbolt: the vault behind Sécurité › Passbolt (the server address only; nothing secret is stored here) ──
type PassboltView = { enabled: boolean; baseUrl: string; hideMenu: boolean; lastTest: { ok: boolean; at: string; error?: string } | null; spikeAllowed: boolean };
const PASSBOLT_KEY = ["admin", "integrations", "passbolt"];

function PassboltStatus() {
  const { t } = useTranslation();
  const { data } = useQuery({ queryKey: PASSBOLT_KEY, queryFn: () => api.get<PassboltView>("/admin/integrations/passbolt") });
  if (!data) return null;
  const on = data.enabled && Boolean(data.baseUrl);
  return (
    <Badge variant="outline" className={cn("gap-1.5", on ? "border-emerald-500/40 text-emerald-400" : "text-muted-foreground")}>
      <span className="size-1.5 rounded-full bg-current" />
      {t(`integrations.status.${on ? "connected" : data.baseUrl ? "disabled" : "notConfigured"}`)}
    </Badge>
  );
}

function PassboltAdminPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: s, isLoading } = useQuery({ queryKey: PASSBOLT_KEY, queryFn: () => api.get<PassboltView>("/admin/integrations/passbolt") });
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (s) setUrl(s.baseUrl);
  }, [s]);
  const done = (next: PassboltView) => {
    qc.setQueryData(PASSBOLT_KEY, next);
    void qc.invalidateQueries({ queryKey: ["passbolt"] });
  };
  const fail = (e: unknown) => toast.error(e instanceof ApiError && e.code === "passbolt_bad_url" ? t("integrations.passbolt.badUrl") : e instanceof ApiError && e.code === "passbolt_incomplete" ? t("integrations.passbolt.needUrl") : t("common.error"));
  const save = useMutation({
    mutationFn: (p: { enabled?: boolean; baseUrl?: string; hideMenu?: boolean }) => api.put<PassboltView>("/admin/integrations/passbolt", p),
    onSuccess: (next) => {
      done(next);
      // the sidebar follows the trigger at once
      void qc.invalidateQueries({ queryKey: ["auth"] });
      toast.success(t("common.saved"));
    },
    onError: fail,
  });
  const test = useMutation({
    mutationFn: () => api.post<PassboltView>("/admin/integrations/passbolt/test"),
    onSuccess: (next) => {
      done(next);
      if (next.lastTest?.ok) toast.success(t("integrations.passbolt.testOk"));
      else toast.error(t("integrations.passbolt.testFailed", { error: next.lastTest?.error ?? "" }));
    },
    onError: fail,
  });
  if (isLoading || !s) return <Skeleton className="h-60 rounded-2xl" />;
  return (
    <section className="overflow-hidden rounded-2xl border bg-card/80">
      <div className="flex flex-wrap items-center gap-4 border-b px-6 py-5">
        <span className="flex size-11 items-center justify-center rounded-xl bg-grad-gold text-[#1a1204]">
          <KeyRound className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-lg font-semibold">{t("integrations.passbolt.title")}</h3>
          <div className="mt-1">
            <PassboltStatus />
          </div>
        </div>
        <label className="flex items-center gap-3 text-sm font-medium">
          {t("integrations.enabled")}
          <Switch checked={s.enabled} disabled={save.isPending} onCheckedChange={(v) => save.mutate({ enabled: v })} />
        </label>
      </div>
      <form
        className="space-y-4 px-6 py-6"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate({ baseUrl: url.trim() });
        }}
      >
        <label className="flex items-start justify-between gap-4 rounded-xl border p-4 text-sm">
          <span className="space-y-0.5">
            <span className="block font-medium">{t("integrations.passbolt.hideMenu")}</span>
            <span className="block text-xs text-muted-foreground">{t("integrations.passbolt.hideMenuHint")}</span>
          </span>
          <Switch checked={s.hideMenu} disabled={save.isPending} onCheckedChange={(v) => save.mutate({ hideMenu: v })} aria-label={t("integrations.passbolt.hideMenu")} />
        </label>
        {!s.spikeAllowed && <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">{t("integrations.passbolt.spikeOff")}</p>}
        <div className="space-y-2">
          <Label htmlFor="pb-url">{t("integrations.passbolt.url")}</Label>
          <Input id="pb-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://passbolt.exemple.com" className="font-mono text-xs" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={save.isPending} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
            {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
          </Button>
          <Button type="button" variant="outline" disabled={!s.baseUrl || test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {t("integrations.passbolt.test")}
          </Button>
          {s.lastTest && <span className={cn("text-xs", s.lastTest.ok ? "text-emerald-400" : "text-destructive")}>{s.lastTest.ok ? t("integrations.passbolt.testOk") : t("integrations.passbolt.testFailed", { error: s.lastTest.error ?? "" })}</span>}
        </div>
        <p className="text-xs text-muted-foreground">{t("integrations.passbolt.help")}</p>
      </form>
    </section>
  );
}

// ── Microsoft Teams: one incoming webhook, a card mentioning the technician ──
type TeamsView = { enabled: boolean; hasUrl: boolean; lastTest: { ok: boolean; at: string; error?: string } | null };
const TEAMS_KEY = ["admin", "integrations", "teams"];

function TeamsStatus() {
  const { t } = useTranslation();
  const { data } = useQuery({ queryKey: TEAMS_KEY, queryFn: () => api.get<TeamsView>("/admin/integrations/teams") });
  if (!data) return null;
  const on = data.enabled && data.hasUrl;
  return (
    <Badge variant="outline" className={cn("gap-1.5", on ? "border-emerald-500/40 text-emerald-400" : "text-muted-foreground")}>
      <span className="size-1.5 rounded-full bg-current" />
      {t(`integrations.status.${on ? "connected" : data.hasUrl ? "disabled" : "notConfigured"}`)}
    </Badge>
  );
}

function TeamsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: s, isLoading } = useQuery({ queryKey: TEAMS_KEY, queryFn: () => api.get<TeamsView>("/admin/integrations/teams") });
  const [url, setUrl] = useState("");
  const done = (next: TeamsView) => qc.setQueryData(TEAMS_KEY, next);
  const fail = (e: unknown) => toast.error(e instanceof ApiError && e.code === "teams_bad_url" ? t("integrations.teams.badUrl") : e instanceof ApiError && e.code === "teams_incomplete" ? t("integrations.teams.needUrl") : t("common.error"));
  const save = useMutation({
    mutationFn: (p: { enabled?: boolean; webhookUrl?: string }) => api.put<TeamsView>("/admin/integrations/teams", p),
    onSuccess: (next) => {
      done(next);
      setUrl("");
      toast.success(t("common.saved"));
    },
    onError: fail,
  });
  const test = useMutation({
    mutationFn: () => api.post<TeamsView>("/admin/integrations/teams/test"),
    onSuccess: (next) => {
      done(next);
      if (next.lastTest?.ok) toast.success(t("integrations.teams.testOk"));
      else toast.error(t("integrations.teams.testFailed", { error: next.lastTest?.error ?? "" }));
    },
    onError: fail,
  });
  if (isLoading || !s) return <Skeleton className="h-60 rounded-2xl" />;
  return (
    <section className="overflow-hidden rounded-2xl border bg-card/80">
      <div className="flex flex-wrap items-center gap-4 border-b px-6 py-5">
        <span className="flex size-11 items-center justify-center rounded-xl bg-grad-gold text-[#1a1204]">
          <Users className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-lg font-semibold">{t("integrations.teams.title")}</h3>
          <div className="mt-1">
            <TeamsStatus />
          </div>
        </div>
        <label className="flex items-center gap-3 text-sm font-medium">
          {t("integrations.enabled")}
          <Switch checked={s.enabled} disabled={save.isPending} onCheckedChange={(v) => save.mutate({ enabled: v })} />
        </label>
      </div>
      <form
        className="space-y-4 px-6 py-6"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (url.trim()) save.mutate({ webhookUrl: url.trim() });
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="teams-url" className="flex items-center gap-2">
            {t("integrations.teams.url")}
            {s.hasUrl && <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">{t("integrations.savedValue")}</span>}
          </Label>
          <Input id="teams-url" type="password" autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={s.hasUrl ? "••••••••••••" : "https://…"} className="font-mono text-xs" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={save.isPending || !url.trim()} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
            {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
          </Button>
          <Button type="button" variant="outline" disabled={!s.hasUrl || test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {t("integrations.teams.test")}
          </Button>
          {s.lastTest && (
            <span className={cn("text-xs", s.lastTest.ok ? "text-emerald-400" : "text-destructive")}>
              {s.lastTest.ok ? t("integrations.teams.testOk") : t("integrations.teams.testFailed", { error: s.lastTest.error ?? "" })}
            </span>
          )}
        </div>
        <div className="rounded-xl border bg-background/40 p-4 text-xs text-muted-foreground">
          <p className="mb-2 font-medium text-foreground">{t("integrations.teams.helpTitle")}</p>
          <ol className="list-decimal space-y-1 pl-4">
            {(t("integrations.teams.helpSteps", { returnObjects: true }) as string[]).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
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
  autoReplyCooldownHours: number;
  longAsMms: boolean;
  askDetails: string;
  detailsMinutes: number;
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
  const [f, setF] = useState({ username: "", password: "", did: "", enabled: false, minutes: "240", cooldown: "24", longAsMms: true, askDetails: "", detailsMinutes: "30", autoReply: "", ticketOpened: "", ticketTimeout: "", companyId: "", queue: "", priority: "", sendTo: "" });
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
        cooldown: String(s.autoReplyCooldownHours ?? 24),
        longAsMms: s.longAsMms ?? true,
        askDetails: s.askDetails,
        detailsMinutes: String(s.detailsMinutes ?? 30),
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
        autoReplyCooldownHours: Math.min(720, Math.max(0, Math.round(Number(f.cooldown)) || 0)),
        longAsMms: f.longAsMms,
        askDetails: f.askDetails.trim(),
        detailsMinutes: Math.min(1440, Math.max(1, Math.round(Number(f.detailsMinutes)) || 30)),
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
          <label className="flex items-center justify-between gap-4 rounded-lg border bg-background/40 px-3 py-2 text-sm">
            <span>
              {t("integrations.voipms.longAsMms")}
              <span className="block text-[11px] text-muted-foreground">{t("integrations.voipms.longAsMmsHint")}</span>
            </span>
            <Switch checked={f.longAsMms} onCheckedChange={(v) => set("longAsMms")(v)} />
          </label>
          <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
            <div className="space-y-2">
              <Label htmlFor="vm-cool">{t("integrations.voipms.cooldown")}</Label>
              <Input id="vm-cool" inputMode="numeric" value={f.cooldown} onChange={(e) => set("cooldown")(e.target.value)} />
            </div>
            <p className="self-end pb-2 text-[11px] text-muted-foreground">{t("integrations.voipms.cooldownHint")}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
            <div className="space-y-2">
              <Label htmlFor="vm-dmin">{t("integrations.voipms.detailsMinutes")}</Label>
              <Input id="vm-dmin" inputMode="numeric" value={f.detailsMinutes} onChange={(e) => set("detailsMinutes")(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="vm-ask">{t("integrations.voipms.askDetails")}</Label>
              <Textarea id="vm-ask" rows={2} maxLength={600} value={f.askDetails} onChange={(e) => set("askDetails")(e.target.value)} />
              <p className="text-[11px] text-muted-foreground">{t("integrations.voipms.askDetailsHint")}</p>
            </div>
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
