import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Cloud, Link2, Loader2, RefreshCw, Unlink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { money, useCrmClients } from "@/pages/crm/shared";

/**
 * Admin › Intégrations › ITCloud: the partner API keys, then three steps, each reviewed before it changes
 * anything: the ITCloud customers matched to the portal's clients, the ITCloud products turned into services
 * (SKU ITC-<id>, vendor ITCloud) and the sync that keeps each matched customer's services on its contract.
 */
type View = {
  enabled: boolean;
  integrationKey: string | null;
  hasKey: boolean;
  autoSync: boolean;
  vendorName: string;
  lastTest: { ok: boolean; at: string; error?: string; customers?: number; products?: number } | null;
  lastSync: { at: string; ok: boolean; error?: string; counts?: Record<string, number> } | null;
};
const KEY = ["admin", "itcloud"];

const errorText = (t: (k: string, o?: Record<string, unknown>) => string, e: unknown) => {
  const code = e instanceof ApiError ? e.code : "";
  return code.startsWith("itcloud_") ? t(`integrations.itcloud.errors.${code}`, { defaultValue: t("common.error") }) : t("common.error");
};

export function ITCloudStatus() {
  const { t } = useTranslation();
  const { data } = useQuery({ queryKey: KEY, queryFn: () => api.get<View>("/admin/itcloud") });
  if (!data) return null;
  const on = data.enabled && data.hasKey;
  return (
    <Badge variant="outline" className={cn("gap-1.5", on ? "border-emerald-500/40 text-emerald-400" : "text-muted-foreground")}>
      <span className="size-1.5 rounded-full bg-current" />
      {t(`integrations.status.${on ? "connected" : data.hasKey ? "disabled" : "notConfigured"}`)}
    </Badge>
  );
}

export function ITCloudPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: s, isLoading } = useQuery({ queryKey: KEY, queryFn: () => api.get<View>("/admin/itcloud") });
  const [key, setKey] = useState<string | null>(null);
  const [pem, setPem] = useState("");
  const done = (next: View) => qc.setQueryData(KEY, next);
  const fail = (e: unknown) => toast.error(errorText(t, e));
  const save = useMutation({
    mutationFn: (p: { enabled?: boolean; autoSync?: boolean; integrationKey?: string; privateKey?: string }) => api.put<View>("/admin/itcloud", p),
    onSuccess: (next) => {
      done(next);
      setKey(null);
      setPem("");
      toast.success(t("common.saved"));
    },
    onError: fail,
  });
  const test = useMutation({
    mutationFn: () => api.post<View>("/admin/itcloud/test", {}),
    onSuccess: (next) => {
      done(next);
      if (next.lastTest?.ok) toast.success(t("integrations.itcloud.testOk", { customers: next.lastTest.customers, products: next.lastTest.products }));
      else toast.error(t("integrations.itcloud.testFailed", { error: next.lastTest?.error ? t(`integrations.itcloud.errors.${next.lastTest.error}`, { defaultValue: next.lastTest.error }) : "" }));
    },
    onError: fail,
  });
  if (isLoading || !s) return <Skeleton className="h-60 rounded-2xl" />;
  const dirty = (key !== null && key.trim() !== (s.integrationKey ?? "")) || pem.trim() !== "";
  const ready = s.enabled && s.hasKey && Boolean(s.integrationKey);
  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-2xl border bg-card/80">
        <div className="flex flex-wrap items-center gap-4 border-b px-6 py-5">
          <span className="flex size-11 items-center justify-center rounded-xl bg-grad-gold text-[#1a1204]">
            <Cloud className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-display text-lg font-semibold">{t("integrations.itcloud.title")}</h3>
            <div className="mt-1">
              <ITCloudStatus />
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
            save.mutate({ ...(key !== null ? { integrationKey: key.trim() } : {}), ...(pem.trim() ? { privateKey: pem.trim() } : {}) });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="itc-key">{t("integrations.itcloud.integrationKey")}</Label>
            <Input id="itc-key" autoComplete="off" value={key ?? s.integrationKey ?? ""} onChange={(e) => setKey(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" className="font-mono text-xs" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="itc-pem" className="flex items-center gap-2">
              {t("integrations.itcloud.privateKey")}
              {s.hasKey && <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">{t("integrations.savedValue")}</span>}
            </Label>
            <Textarea id="itc-pem" rows={s.hasKey && !pem ? 2 : 6} autoComplete="off" spellCheck={false} value={pem} onChange={(e) => setPem(e.target.value)} placeholder={s.hasKey ? "••••••••••••" : "-----BEGIN PRIVATE KEY-----"} className="font-mono text-xs" />
          </div>
          <label className="flex items-center gap-3 text-sm">
            <Switch checked={s.autoSync} disabled={save.isPending} onCheckedChange={(v) => save.mutate({ autoSync: v })} />
            {t("integrations.itcloud.autoSync")}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={save.isPending || !dirty} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
              {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
            </Button>
            <Button type="button" variant="outline" disabled={!s.hasKey || !s.integrationKey || test.isPending} onClick={() => test.mutate()}>
              {test.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {t("integrations.itcloud.test")}
            </Button>
            {s.lastTest && (
              <span className={cn("text-xs", s.lastTest.ok ? "text-emerald-400" : "text-destructive")}>
                {s.lastTest.ok ? t("integrations.itcloud.testOk", { customers: s.lastTest.customers, products: s.lastTest.products }) : t("integrations.itcloud.testFailed", { error: s.lastTest.error ? t(`integrations.itcloud.errors.${s.lastTest.error}`, { defaultValue: s.lastTest.error }) : "" })}
              </span>
            )}
          </div>
          <p className="rounded-xl border bg-background/40 p-4 text-xs text-muted-foreground">{t("integrations.itcloud.help")}</p>
        </form>
      </section>
      {ready && (
        <>
          <ClientsStep />
          <ServicesStep />
          <SyncStep />
        </>
      )}
    </div>
  );
}

// ── 1. customers ↔ clients ──
type ClientRow = { itcloudId: number; code: string; company: string; email: string; status: string; clientId: string | null; clientName: string | null; suggestion: { clientId: string; name: string; reason: "name" | "email" } | null };

function Step({ n, title, hint, children, action }: { n: number; title: string; hint: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border bg-card/80">
      <div className="flex flex-wrap items-center gap-3 border-b px-6 py-4">
        <span className="flex size-7 items-center justify-center rounded-full bg-[color:var(--gold)]/20 font-mono text-xs text-primary">{n}</span>
        <div className="min-w-0 flex-1">
          <h4 className="font-semibold">{title}</h4>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        {action}
      </div>
      <div className="px-6 py-4">{children}</div>
    </section>
  );
}

function ClientsStep() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: rows, isLoading, error, refetch, isFetching } = useQuery({ queryKey: [...KEY, "clients"], queryFn: () => api.get<ClientRow[]>("/admin/itcloud/clients"), retry: false });
  const { data: crm = [] } = useCrmClients();
  const [pick, setPick] = useState<Record<number, string>>({});
  const link = useMutation({
    mutationFn: (links: { itcloudId: number; clientId: string | null }[]) => api.put<{ changed: number }>("/admin/itcloud/clients", { links }),
    onSuccess: (r) => {
      toast.success(t("integrations.itcloud.clients.saved", { count: r.changed }));
      void qc.invalidateQueries({ queryKey: [...KEY, "clients"] });
      void qc.invalidateQueries({ queryKey: [...KEY, "services"] });
    },
    onError: (e) => toast.error(errorText(t, e)),
  });
  const suggestions = (rows ?? []).filter((r) => r.suggestion);
  const names = useMemo(() => [...crm].sort((a, b) => a.name.localeCompare(b.name)), [crm]);
  return (
    <Step
      n={1}
      title={t("integrations.itcloud.clients.title")}
      hint={t("integrations.itcloud.clients.hint")}
      action={
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
            {isFetching ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {t("integrations.itcloud.reload")}
          </Button>
          {suggestions.length > 0 && (
            <Button type="button" size="sm" disabled={link.isPending} onClick={() => link.mutate(suggestions.map((r) => ({ itcloudId: r.itcloudId, clientId: r.suggestion!.clientId })))} className="bg-grad-gold font-semibold text-[#1a1204]">
              <Check className="size-4" /> {t("integrations.itcloud.clients.acceptAll", { count: suggestions.length })}
            </Button>
          )}
        </div>
      }
    >
      {isLoading ? (
        <Skeleton className="h-24" />
      ) : error ? (
        <p className="text-sm text-destructive">{errorText(t, error)}</p>
      ) : (
        <ul className="divide-y divide-border/60 text-sm">
          {(rows ?? []).map((r) => (
            <li key={r.itcloudId} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{r.company}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {r.code} · {r.email} · {r.status}
                </span>
              </span>
              {r.clientId ? (
                <span className="flex items-center gap-2">
                  <Badge variant="outline" className="gap-1 border-emerald-500/40 text-emerald-400">
                    <Link2 className="size-3" /> {r.clientName}
                  </Badge>
                  <Button type="button" size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-destructive" onClick={() => link.mutate([{ itcloudId: r.itcloudId, clientId: null }])} aria-label={t("integrations.itcloud.clients.unlink")} title={t("integrations.itcloud.clients.unlink")}>
                    <Unlink className="size-3.5" />
                  </Button>
                </span>
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  {r.suggestion && (
                    <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => link.mutate([{ itcloudId: r.itcloudId, clientId: r.suggestion!.clientId }])}>
                      <Check className="size-3.5" /> {r.suggestion.name}
                      <span className="text-muted-foreground">({t(`integrations.itcloud.clients.by.${r.suggestion.reason}`)})</span>
                    </Button>
                  )}
                  <select
                    value={pick[r.itcloudId] ?? ""}
                    onChange={(e) => setPick({ ...pick, [r.itcloudId]: e.target.value })}
                    className="h-8 max-w-52 rounded-md border bg-transparent px-2 text-xs"
                    aria-label={t("integrations.itcloud.clients.pick")}
                  >
                    <option value="">{t("integrations.itcloud.clients.pick")}</option>
                    {names.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <Button type="button" size="sm" variant="ghost" className="h-8 text-xs" disabled={!pick[r.itcloudId] || link.isPending} onClick={() => link.mutate([{ itcloudId: r.itcloudId, clientId: pick[r.itcloudId] }])}>
                    {t("integrations.itcloud.clients.link")}
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Step>
  );
}

// ── 2. products → services ──
type ServicePlan = { rows: { key: string; productGroup: string; name: string; kind: "recurring" | "recurring_yearly"; costCents: number; state: "new" | "update" | "same"; serviceName: string | null; priceCents: number | null; suggestedPriceCents: number; priceSource: "msrp" | "markup"; change: string[] }[]; ignored: number; msrpError: string | null };

function ServicesStep() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: [...KEY, "plan"], queryFn: () => api.get<ServicePlan>("/admin/itcloud/services/plan"), retry: false });
  const [off, setOff] = useState<Set<string>>(new Set());
  const todo = (data?.rows ?? []).filter((r) => r.state !== "same" && !off.has(r.key));
  const apply = useMutation({
    mutationFn: () => api.post<{ created: number; updated: number }>("/admin/itcloud/services/plan", { keys: todo.map((r) => r.key) }),
    onSuccess: (r) => {
      toast.success(t("integrations.itcloud.services.applied", { created: r.created, updated: r.updated }));
      void qc.invalidateQueries({ queryKey: [...KEY, "plan"] });
      void qc.invalidateQueries({ queryKey: ["services"] });
    },
    onError: (e) => toast.error(errorText(t, e)),
  });
  return (
    <Step
      n={2}
      title={t("integrations.itcloud.services.title")}
      hint={t("integrations.itcloud.services.hint")}
      action={
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
            {isFetching ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {t("integrations.itcloud.reload")}
          </Button>
          <Button type="button" size="sm" disabled={!todo.length || apply.isPending} onClick={() => apply.mutate()} className="bg-grad-gold font-semibold text-[#1a1204]">
            {apply.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} {t("integrations.itcloud.services.apply", { count: todo.length })}
          </Button>
        </div>
      }
    >
      {isLoading ? (
        <Skeleton className="h-24" />
      ) : error ? (
        <p className="text-sm text-destructive">{errorText(t, error)}</p>
      ) : (
        <>
          <ul className="divide-y divide-border/60 text-sm">
            {(data?.rows ?? []).map((r) => (
              <li key={r.key} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                <Checkbox checked={r.state !== "same" && !off.has(r.key)} disabled={r.state === "same"} onCheckedChange={(v) => setOff((o) => { const n = new Set(o); if (v) n.delete(r.key); else n.add(r.key); return n; })} aria-label={r.name} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{r.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {r.productGroup} · SKU ITC-{r.key} · {t(`services.kind.${r.kind}`)}
                  </span>
                </span>
                <span className="text-right text-xs text-muted-foreground">
                  {t("integrations.itcloud.services.cost")} <span className="font-mono text-foreground">{money(r.costCents, i18n.language)}</span>
                  <span className="block">
                    {t("services.price")}{" "}
                    {r.priceCents !== null ? (
                      <span className="font-mono text-foreground">{money(r.priceCents, i18n.language)}</span>
                    ) : (
                      <span className="font-mono text-foreground" title={t(`integrations.itcloud.services.priceSource.${r.priceSource}`)}>
                        {money(r.suggestedPriceCents, i18n.language)} <span className="font-sans text-[10px] text-muted-foreground">({t(`integrations.itcloud.services.priceShort.${r.priceSource}`)})</span>
                      </span>
                    )}
                  </span>
                </span>
                <Badge variant="outline" className={cn("w-28 justify-center", r.state === "new" ? "border-sky-500/40 text-sky-300" : r.state === "update" ? "border-amber-500/40 text-amber-300" : "text-muted-foreground")}>
                  {t(`integrations.itcloud.services.state.${r.state}`)}
                </Badge>
              </li>
            ))}
          </ul>
          {data?.msrpError && <p className="mt-2 text-xs text-amber-300">{t("integrations.itcloud.services.msrpError")}</p>}
          {data && data.ignored > 0 && <p className="mt-2 text-xs text-muted-foreground">{t("integrations.itcloud.services.ignored", { count: data.ignored })}</p>}
        </>
      )}
    </Step>
  );
}

// ── 3. the sync ──
type Row = { serviceId: number; clientName: string; productGroup: string; product: string; status: string; billingCycle: string; quantity: number; amountCents: number; state: string; contractName: string | null };

function SyncStep() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: [...KEY, "services"], queryFn: () => api.get<{ rows: Row[]; lastSync: View["lastSync"] }>("/admin/itcloud/services") });
  const sync = useMutation({
    mutationFn: () => api.post<NonNullable<View["lastSync"]>>("/admin/itcloud/sync", {}),
    onSuccess: (r) => {
      if (r.ok) toast.success(t("integrations.itcloud.sync.done"));
      else toast.error(t("integrations.itcloud.sync.failed", { error: t(`integrations.itcloud.errors.${r.error}`, { defaultValue: r.error }) }));
      void qc.invalidateQueries({ queryKey: [...KEY, "services"] });
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e) => toast.error(errorText(t, e)),
  });
  const last = data?.lastSync;
  const c = last?.counts;
  return (
    <Step
      n={3}
      title={t("integrations.itcloud.sync.title")}
      hint={t("integrations.itcloud.sync.hint")}
      action={
        <Button type="button" size="sm" onClick={() => sync.mutate()} disabled={sync.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
          {sync.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {t("integrations.itcloud.sync.now")}
        </Button>
      }
    >
      {last && (
        <p className={cn("mb-3 text-xs", last.ok ? "text-muted-foreground" : "text-destructive")}>
          {new Date(last.at).toLocaleString(i18n.language)} ·{" "}
          {last.ok && c
            ? t("integrations.itcloud.sync.summary", { active: c.active, created: c.created, updated: c.updated, removed: c.removed })
            : t("integrations.itcloud.sync.failed", { error: t(`integrations.itcloud.errors.${last.error}`, { defaultValue: last.error }) })}
        </p>
      )}
      {isLoading ? (
        <Skeleton className="h-24" />
      ) : !data?.rows.length ? (
        <p className="text-sm text-muted-foreground">{t("integrations.itcloud.sync.empty")}</p>
      ) : (
        <ul className="divide-y divide-border/60 text-sm">
          {data.rows.map((r) => (
            <li key={r.serviceId} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {r.product} <span className="font-mono text-xs text-muted-foreground">× {r.quantity}</span>
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {r.clientName} · {r.productGroup} · {r.billingCycle}
                  {r.contractName ? ` · ${r.contractName}` : ""}
                </span>
              </span>
              <span className="font-mono text-xs text-muted-foreground">{money(r.amountCents, i18n.language)}</span>
              <Badge
                variant="outline"
                className={cn("w-40 justify-center", r.state === "synced" ? "border-emerald-500/40 text-emerald-400" : r.state === "inactive" ? "text-muted-foreground" : "border-amber-500/40 text-amber-300")}
              >
                {t(`integrations.itcloud.sync.state.${r.state}`)}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </Step>
  );
}
