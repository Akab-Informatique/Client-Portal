import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Loader2, MonitorCog, RefreshCw, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api, ApiError } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type View = {
  enabled: boolean;
  apiUrl: string | null;
  apiKey: string | null;
  hasSecret: boolean;
  autoSync: boolean;
  ready: boolean;
  lastTest: { ok: boolean; at: string; error?: string; sites?: number } | null;
  lastSync: { at: string; ok: boolean; error?: string; counts?: { sites: number; devices: number; online: number; removed: number } } | null;
};
type Plan = { sites: { uid: string; name: string; devices: number; clientId: string | null; clientName: string | null; proposedId: string | null; proposedName: string | null }[]; clients: { id: string; name: string }[] };
const KEY = ["admin", "rmm-datto"];
// Datto's platforms (the API address depends on the one the account is on)
const PLATFORMS = ["pinotage", "merlot", "concord", "vidal", "zinfandel", "syrah"];

/** Admin › Intégrations › RMM › Datto RMM: the API connection (read only), the sync, and the sites matched to clients */
export function DattoPanel() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: s, isLoading } = useQuery({ queryKey: KEY, queryFn: () => api.get<View>("/admin/rmm-datto") });
  const [form, setForm] = useState<{ platform: string; apiKey: string; apiSecret: string; enabled: boolean; autoSync: boolean } | null>(null);
  const f =
    form ??
    (s
      ? { platform: (s.apiUrl?.match(/^https:\/\/([a-z0-9]+)-api\./i)?.[1] ?? "pinotage").toLowerCase(), apiKey: s.apiKey ?? "", apiSecret: "", enabled: s.enabled, autoSync: s.autoSync }
      : null);
  const err = (e: unknown) => toast.error(e instanceof ApiError ? t(`integrations.datto.errors.${e.code}`, { defaultValue: t("integrations.datto.errors.generic") }) : t("common.error"));
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: KEY });
    void qc.invalidateQueries({ queryKey: ["admin", "integrations", "rmm"] });
  };
  const save = useMutation({
    mutationFn: () => api.put<View>("/admin/rmm-datto", { enabled: f!.enabled, apiUrl: `https://${f!.platform}-api.centrastage.net`, apiKey: f!.apiKey.trim(), ...(f!.apiSecret.trim() ? { apiSecret: f!.apiSecret.trim() } : {}), autoSync: f!.autoSync }),
    onSuccess: () => {
      setForm(null);
      toast.success(t("common.saved"));
      refresh();
    },
    onError: err,
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; sites?: number; error?: string }>("/admin/rmm-datto/test"),
    onSuccess: (r) => {
      if (r.ok) toast.success(t("integrations.datto.testOk", { count: r.sites ?? 0 }));
      else toast.error(t(`integrations.datto.errors.${r.error}`, { defaultValue: t("integrations.datto.errors.generic") }));
      refresh();
    },
    onError: err,
  });
  const sync = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error?: string; counts?: { devices: number } }>("/admin/rmm-datto/sync"),
    onSuccess: (r) => {
      if (r.ok) toast.success(t("integrations.datto.syncOk", { count: r.counts?.devices ?? 0 }));
      else toast.error(t(`integrations.datto.errors.${r.error}`, { defaultValue: t("integrations.datto.errors.generic") }));
      refresh();
      void qc.invalidateQueries({ queryKey: [...KEY, "sites"] });
    },
    onError: err,
  });
  if (isLoading || !s || !f) return <Skeleton className="h-64 rounded-2xl" />;
  const set = (p: Partial<typeof f>) => setForm({ ...f, ...p });
  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-2xl border bg-card/80">
        <div className="flex flex-wrap items-center gap-4 border-b px-6 py-5">
          <span className="flex size-11 items-center justify-center rounded-xl bg-grad-gold text-[#1a1204]">
            <MonitorCog className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-display text-lg font-semibold">{t("integrations.datto.title")}</h3>
            <p className="text-xs text-muted-foreground">{t("integrations.datto.subtitle")}</p>
          </div>
          <label className="flex items-center gap-3 text-sm font-medium">
            {t("integrations.enabled")}
            <Switch checked={f.enabled} onCheckedChange={(v) => set({ enabled: v })} />
          </label>
        </div>
        <form
          className="space-y-5 px-6 py-6"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="datto-platform">{t("integrations.datto.platform")}</Label>
              <select id="datto-platform" value={f.platform} onChange={(e) => set({ platform: e.target.value })} className="h-9 w-full rounded-md border bg-transparent px-2 text-sm">
                {PLATFORMS.map((p) => (
                  <option key={p} value={p} className="bg-background">
                    {p} — {p}-api.centrastage.net
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="datto-key">{t("integrations.datto.apiKey")}</Label>
              <Input id="datto-key" value={f.apiKey} onChange={(e) => set({ apiKey: e.target.value })} autoComplete="off" className="font-mono text-xs" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="datto-secret" className="flex items-center gap-2">
                {t("integrations.datto.apiSecret")}
                {s.hasSecret && <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">{t("integrations.savedValue")}</span>}
              </Label>
              <Input id="datto-secret" type="password" value={f.apiSecret} onChange={(e) => set({ apiSecret: e.target.value })} autoComplete="new-password" placeholder={s.hasSecret ? "••••••••" : ""} className="font-mono text-xs" />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={f.autoSync} onCheckedChange={(v) => set({ autoSync: v })} /> {t("integrations.datto.autoSync")}
          </label>
          <p className="text-xs text-muted-foreground">{t("integrations.datto.help")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={save.isPending || !f.apiKey.trim() || (!s.hasSecret && !f.apiSecret.trim())} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
              {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
            </Button>
            <Button type="button" variant="outline" disabled={!s.apiKey || !s.hasSecret || test.isPending} onClick={() => test.mutate()}>
              {test.isPending && <Loader2 className="size-4 animate-spin" />} {t("integrations.datto.test")}
            </Button>
            <Button type="button" variant="outline" disabled={!s.ready || sync.isPending} onClick={() => sync.mutate()}>
              {sync.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {t("integrations.datto.sync")}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            {s.lastTest && (
              <Badge variant="outline" className={cn("gap-1.5", s.lastTest.ok ? "border-emerald-500/40 text-emerald-400" : "border-destructive/50 text-destructive")}>
                {s.lastTest.ok ? t("integrations.datto.testOk", { count: s.lastTest.sites ?? 0 }) : t(`integrations.datto.errors.${s.lastTest.error}`, { defaultValue: t("integrations.datto.errors.generic") })} · {relativeTime(s.lastTest.at)}
              </Badge>
            )}
            {s.lastSync && (
              <Badge variant="outline" className={cn("gap-1.5", s.lastSync.ok ? "text-muted-foreground" : "border-destructive/50 text-destructive")}>
                {s.lastSync.ok
                  ? t("integrations.datto.lastSync", { devices: s.lastSync.counts?.devices ?? 0, online: s.lastSync.counts?.online ?? 0, sites: s.lastSync.counts?.sites ?? 0 })
                  : t(`integrations.datto.errors.${s.lastSync.error}`, { defaultValue: t("integrations.datto.errors.generic") })}{" "}
                · {relativeTime(s.lastSync.at)}
              </Badge>
            )}
          </div>
        </form>
      </section>
      {s.lastSync?.ok && <Sites onChanged={refresh} />}
    </div>
  );
}

/** Datto's sites, each tied to a portal client: the proposed matches are accepted once reviewed */
function Sites({ onChanged }: { onChanged: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: [...KEY, "sites"], queryFn: () => api.get<Plan>("/admin/rmm-datto/sites") });
  const [q, setQ] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(false);
  const done = () => {
    void qc.invalidateQueries({ queryKey: [...KEY, "sites"] });
    void qc.invalidateQueries({ queryKey: ["rmm"] });
    onChanged();
  };
  const set = useMutation({ mutationFn: (v: { uid: string; clientId: string | null }) => api.put(`/admin/rmm-datto/sites/${encodeURIComponent(v.uid)}/client`, { clientId: v.clientId }), onSuccess: done, onError: () => toast.error(t("common.error")) });
  const accept = useMutation({
    mutationFn: () => api.post<{ accepted: number }>("/admin/rmm-datto/sites/accept", {}),
    onSuccess: (r) => {
      toast.success(t("integrations.datto.accepted", { count: r.accepted }));
      done();
    },
    onError: () => toast.error(t("common.error")),
  });
  const sites = data?.sites ?? [];
  const proposed = sites.filter((x) => x.proposedId).length;
  const list = useMemo(() => sites.filter((x) => (!onlyOpen || !x.clientId) && x.name.toLowerCase().includes(q.toLowerCase())), [sites, q, onlyOpen]);
  if (!data) return <Skeleton className="h-40 rounded-2xl" />;
  return (
    <section className="overflow-hidden rounded-2xl border bg-card/80">
      <div className="flex flex-wrap items-center gap-3 border-b px-6 py-4">
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-base font-semibold">{t("integrations.datto.sites")}</h3>
          <p className="text-xs text-muted-foreground">{t("integrations.datto.sitesHint", { matched: sites.filter((x) => x.clientId).length, total: sites.length })}</p>
        </div>
        {proposed > 0 && (
          <Button size="sm" onClick={() => accept.mutate()} disabled={accept.isPending}>
            {accept.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} {t("integrations.datto.acceptAll", { count: proposed })}
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-6 pt-4">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("integrations.datto.searchSites")} className="pl-8" />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={onlyOpen} onCheckedChange={setOnlyOpen} /> {t("integrations.datto.onlyUnmatched")}
        </label>
      </div>
      <ul className="divide-y divide-border/50 px-6 py-3">
        {list.length === 0 && <li className="py-6 text-center text-sm text-muted-foreground">{t("integrations.datto.noSites")}</li>}
        {list.map((x) => (
          <li key={x.uid} className="flex flex-wrap items-center gap-3 py-2 text-sm">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{x.name}</span>
              <span className="text-xs text-muted-foreground">{t("integrations.datto.devices", { count: x.devices })}</span>
            </span>
            <select
              value={x.clientId ?? ""}
              disabled={set.isPending}
              onChange={(e) => set.mutate({ uid: x.uid, clientId: e.target.value || null })}
              className={cn("h-9 w-64 max-w-full rounded-md border bg-transparent px-2 text-sm", !x.clientId && "text-muted-foreground")}
              aria-label={t("integrations.datto.client")}
            >
              <option value="" className="bg-background">
                {x.proposedName ? t("integrations.datto.proposed", { name: x.proposedName }) : t("integrations.datto.noClient")}
              </option>
              {data.clients.map((c) => (
                <option key={c.id} value={c.id} className="bg-background">
                  {c.name}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
    </section>
  );
}
