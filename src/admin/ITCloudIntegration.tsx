import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronLeft, ChevronRight, Cloud, Link2, Loader2, RefreshCw, Unlink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/api";
import { useConfirm } from "@/components/ConfirmDialog";
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

// ── lists: pages of 25, search, and a selection that can be cleared by page or all at once ──
const PAGE = 25;

function usePaged<T>(items: T[]) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / PAGE));
  const p = Math.min(page, pages - 1);
  return { page: p, pages, setPage, rows: items.slice(p * PAGE, (p + 1) * PAGE) };
}

function Pager({ page, pages, total, setPage }: { page: number; pages: number; total: number; setPage: (n: number) => void }) {
  const { t } = useTranslation();
  if (total <= PAGE) return <p className="pt-3 text-xs text-muted-foreground">{t("integrations.itcloud.list.count", { count: total })}</p>;
  return (
    <div className="flex items-center justify-between gap-3 pt-3 text-xs text-muted-foreground">
      <span>{t("integrations.itcloud.list.range", { from: page * PAGE + 1, to: Math.min(total, (page + 1) * PAGE), total })}</span>
      <span className="flex items-center gap-2">
        <Button type="button" size="icon" variant="outline" className="size-8" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label={t("integrations.itcloud.list.prev")}>
          <ChevronLeft className="size-4" />
        </Button>
        <span className="font-mono">
          {page + 1} / {pages}
        </span>
        <Button type="button" size="icon" variant="outline" className="size-8" disabled={page >= pages - 1} onClick={() => setPage(page + 1)} aria-label={t("integrations.itcloud.list.next")}>
          <ChevronRight className="size-4" />
        </Button>
      </span>
    </div>
  );
}

/**
 * A selection over the rows of a list. `null` is the default (everything that can be picked is picked); the
 * buttons then work on the whole filtered list or on the page shown.
 */
function useSelection(selectable: string[]) {
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const eff = useMemo(() => (chosen ? new Set([...chosen].filter((k) => selectable.includes(k))) : new Set(selectable)), [chosen, selectable]);
  const set = (fn: (cur: Set<string>) => void) =>
    setChosen(() => {
      const next = new Set(eff);
      fn(next);
      return next;
    });
  return {
    selected: eff,
    toggle: (k: string, on: boolean) => set((s) => (on ? s.add(k) : s.delete(k))),
    selectMany: (keys: string[]) => set((s) => keys.forEach((k) => s.add(k))),
    unselectMany: (keys: string[]) => set((s) => keys.forEach((k) => s.delete(k))),
    clear: () => setChosen(new Set()),
    reset: () => setChosen(null),
  };
}

function SelectBar({ sel, all, page }: { sel: ReturnType<typeof useSelection>; all: string[]; page: string[] }) {
  const { t } = useTranslation();
  const b = "h-7 px-2 text-xs";
  return (
    <div className="flex flex-wrap items-center gap-1.5 pb-3 text-xs">
      <span className="mr-1 text-muted-foreground">{t("integrations.itcloud.list.selected", { count: sel.selected.size })}</span>
      <Button type="button" variant="outline" className={b} onClick={() => sel.selectMany(all)}>
        {t("integrations.itcloud.list.selectAll")}
      </Button>
      <Button type="button" variant="outline" className={b} onClick={() => sel.selectMany(page)}>
        {t("integrations.itcloud.list.selectPage")}
      </Button>
      <Button type="button" variant="outline" className={b} onClick={() => sel.unselectMany(page)}>
        {t("integrations.itcloud.list.unselectPage")}
      </Button>
      <Button type="button" variant="outline" className={b} onClick={() => sel.clear()}>
        {t("integrations.itcloud.list.unselectAll")}
      </Button>
    </div>
  );
}

function Search({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  return <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={t("integrations.itcloud.list.search")} className="h-8 w-56 text-xs" aria-label={t("integrations.itcloud.list.search")} />;
}

const has = (q: string, ...parts: (string | null | undefined)[]) => {
  const words = normName(q).split(" ").filter(Boolean);
  const hay = normName(parts.join(" "));
  return words.every((w) => hay.includes(w));
};
/** Same folding as the server (accents, case, punctuation), without its company-suffix list getting in the way of a search */
const normName = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

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

// ── 1. customers ↔ clients ──
type ClientRow = { itcloudId: number; code: string; company: string; email: string; status: string; clientId: string | null; clientName: string | null; contractId: string | null; contracts: { id: string; name: string }[]; suggestion: { clientId: string; name: string; reason: "name" | "email" } | null };

function ClientsStep() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: rows, isLoading, error, refetch, isFetching } = useQuery({ queryKey: [...KEY, "clients"], queryFn: () => api.get<ClientRow[]>("/admin/itcloud/clients"), retry: false });
  const { data: crm = [] } = useCrmClients();
  const [pick, setPick] = useState<Record<number, string>>({});
  const [q, setQ] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(false);
  const link = useMutation({
    mutationFn: (links: { itcloudId: number; clientId: string | null }[]) => api.put<{ changed: number }>("/admin/itcloud/clients", { links }),
    onSuccess: (r) => {
      toast.success(t("integrations.itcloud.clients.saved", { count: r.changed }));
      void qc.invalidateQueries({ queryKey: [...KEY, "clients"] });
      void qc.invalidateQueries({ queryKey: [...KEY, "services"] });
    },
    onError: (e) => toast.error(errorText(t, e)),
  });
  const pickContract = useMutation({
    mutationFn: (p: { itcloudId: number; contractId: string | null }) => api.put(`/admin/itcloud/clients/${p.itcloudId}/contract`, { contractId: p.contractId }),
    onSuccess: () => {
      toast.success(t("integrations.itcloud.clients.contractSaved"));
      void qc.invalidateQueries({ queryKey: [...KEY, "clients"] });
    },
    onError: (e) => toast.error(errorText(t, e)),
  });
  const shown = useMemo(() => (rows ?? []).filter((r) => (!onlyOpen || !r.clientId) && has(q, r.company, r.email, r.code, r.clientName)), [rows, q, onlyOpen]);
  const selectable = useMemo(() => shown.filter((r) => r.suggestion && !r.clientId).map((r) => String(r.itcloudId)), [shown]);
  const sel = useSelection(selectable);
  const paged = usePaged(shown);
  const pageSelectable = paged.rows.filter((r) => r.suggestion && !r.clientId).map((r) => String(r.itcloudId));
  const names = useMemo(() => [...crm].sort((a, b) => a.name.localeCompare(b.name)), [crm]);
  const toAccept = shown.filter((r) => r.suggestion && !r.clientId && sel.selected.has(String(r.itcloudId)));
  return (
    <Step
      n={1}
      title={t("integrations.itcloud.clients.title")}
      hint={t("integrations.itcloud.clients.hint")}
      action={
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
            {isFetching ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {t("integrations.itcloud.reload")}
          </Button>
          <Button type="button" size="sm" disabled={!toAccept.length || link.isPending} onClick={() => link.mutate(toAccept.map((r) => ({ itcloudId: r.itcloudId, clientId: r.suggestion!.clientId })))} className="bg-grad-gold font-semibold text-[#1a1204]">
            {link.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} {t("integrations.itcloud.clients.acceptSelected", { count: toAccept.length })}
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
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <Search value={q} onChange={setQ} />
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={onlyOpen} onCheckedChange={setOnlyOpen} aria-label={t("integrations.itcloud.clients.onlyOpen")} />
              {t("integrations.itcloud.clients.onlyOpen")}
            </label>
          </div>
          {selectable.length > 0 && <SelectBar sel={sel} all={selectable} page={pageSelectable} />}
          <ul className="divide-y divide-border/60 text-sm">
            {paged.rows.map((r) => (
              <li key={r.itcloudId} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
                {r.suggestion && !r.clientId ? <Checkbox checked={sel.selected.has(String(r.itcloudId))} onCheckedChange={(v) => sel.toggle(String(r.itcloudId), Boolean(v))} aria-label={r.company} /> : <span className="size-4" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{r.company}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {r.code} · {r.email} · {r.status}
                  </span>
                </span>
                {r.clientId ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="gap-1 border-emerald-500/40 text-emerald-400">
                      <Link2 className="size-3" /> {r.clientName}
                    </Badge>
                    {/* the contract that carries this customer's services: the portal's choice, or one picked by hand */}
                    <select
                      value={r.contractId ?? ""}
                      disabled={pickContract.isPending}
                      onChange={(e) => pickContract.mutate({ itcloudId: r.itcloudId, contractId: e.target.value || null })}
                      className="h-8 max-w-52 rounded-md border bg-transparent px-2 text-xs"
                      aria-label={t("integrations.itcloud.clients.contract")}
                      title={t("integrations.itcloud.clients.contractHint")}
                    >
                      <option value="">{t("integrations.itcloud.clients.contractAuto")}</option>
                      {r.contracts.map((k) => (
                        <option key={k.id} value={k.id}>
                          {k.name}
                        </option>
                      ))}
                    </select>
                    <Button type="button" size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-destructive" onClick={() => link.mutate([{ itcloudId: r.itcloudId, clientId: null }])} aria-label={t("integrations.itcloud.clients.unlink")} title={t("integrations.itcloud.clients.unlink")}>
                      <Unlink className="size-3.5" />
                    </Button>
                  </span>
                ) : (
                  <span className="flex flex-wrap items-center gap-2">
                    {r.suggestion && (
                      <span className="text-xs text-muted-foreground">
                        → <span className="text-foreground">{r.suggestion.name}</span> ({t(`integrations.itcloud.clients.by.${r.suggestion.reason}`)})
                      </span>
                    )}
                    <select value={pick[r.itcloudId] ?? ""} onChange={(e) => setPick({ ...pick, [r.itcloudId]: e.target.value })} className="h-8 max-w-52 rounded-md border bg-transparent px-2 text-xs" aria-label={t("integrations.itcloud.clients.pick")}>
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
          {!shown.length && <p className="py-4 text-sm text-muted-foreground">{t("integrations.itcloud.list.none")}</p>}
          <Pager page={paged.page} pages={paged.pages} total={shown.length} setPage={paged.setPage} />
        </>
      )}
    </Step>
  );
}

// ── 2. products → services ──
type PlanRow = { key: string; productGroup: string; name: string; kind: "recurring" | "recurring_yearly"; costCents: number; state: "new" | "update" | "same"; serviceName: string | null; priceCents: number | null; suggestedPriceCents: number; priceSource: "manual"; soldTo: number; soldUnits: number; change: string[] };
type ServicePlan = { rows: PlanRow[]; ignored: number; msrpError: string | null };

function ServicesStep() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  // one-time clean-up: every ITCloud service (and its contract lines) back to no price and no cost
  const zero = useMutation({
    mutationFn: () => api.post<{ services: number; lines: number }>("/admin/itcloud/services/zero", {}),
    onSuccess: (r) => {
      toast.success(t("integrations.itcloud.services.zeroed", { services: r.services, lines: r.lines }));
      void qc.invalidateQueries({ queryKey: [...KEY, "plan"] });
      void qc.invalidateQueries({ queryKey: ["services"] });
      void qc.invalidateQueries({ queryKey: ["crm"] });
    },
    onError: (e) => toast.error(errorText(t, e)),
  });
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: [...KEY, "plan"], queryFn: () => api.get<ServicePlan>("/admin/itcloud/services/plan"), retry: false });
  const [q, setQ] = useState("");
  // only what is really sold to my clients at ITCloud (an active service of a customer)
  const [onlySold, setOnlySold] = useState(false);
  const shown = useMemo(() => (data?.rows ?? []).filter((r) => (!onlySold || r.soldTo > 0) && has(q, r.name, r.productGroup, `ITC-${r.key}`)), [data, q, onlySold]);
  const selectable = useMemo(() => shown.filter((r) => r.state !== "same").map((r) => r.key), [shown]);
  const sel = useSelection(selectable);
  const paged = usePaged(shown);
  const pageSelectable = paged.rows.filter((r) => r.state !== "same").map((r) => r.key);
  const todo = shown.filter((r) => r.state !== "same" && sel.selected.has(r.key));
  const soldCount = (data?.rows ?? []).filter((r) => r.soldTo > 0).length;
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
        <div className="flex flex-wrap gap-2">
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
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <Search value={q} onChange={setQ} />
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={onlySold} onCheckedChange={setOnlySold} aria-label={t("integrations.itcloud.services.onlySold")} />
              {t("integrations.itcloud.services.onlySold", { count: soldCount })}
            </label>
          </div>
          {selectable.length > 0 && <SelectBar sel={sel} all={selectable} page={pageSelectable} />}
          <ul className="divide-y divide-border/60 text-sm">
            {paged.rows.map((r) => (
              <li key={r.key} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                {r.state !== "same" ? <Checkbox checked={sel.selected.has(r.key)} onCheckedChange={(v) => sel.toggle(r.key, Boolean(v))} aria-label={r.name} /> : <span className="size-4" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{r.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {r.productGroup} · SKU ITC-{r.key} · {t(`services.kind.${r.kind}`)}
                  </span>
                </span>
                {r.soldTo > 0 ? (
                  <Badge variant="outline" className="border-sky-500/40 text-sky-300" title={t("integrations.itcloud.services.soldHint")}>
                    {t("integrations.itcloud.services.sold", { clients: r.soldTo, units: r.soldUnits })}
                  </Badge>
                ) : (
                  <span className="text-[11px] text-muted-foreground">{t("integrations.itcloud.services.notSold")}</span>
                )}
                <span className="text-right text-xs text-muted-foreground">
                  {r.priceCents === null ? (
                    <span title={t("integrations.itcloud.services.manualHint")}>{t("integrations.itcloud.services.manual")}</span>
                  ) : (
                    <>
                      {t("integrations.itcloud.services.cost")} <span className="font-mono text-foreground">{money(r.costCents, i18n.language)}</span>
                      <span className="block">
                        {t("services.price")} <span className="font-mono text-foreground">{money(r.priceCents, i18n.language)}</span>
                      </span>
                    </>
                  )}
                </span>
                <Badge variant="outline" className={cn("w-28 justify-center", r.state === "new" ? "border-sky-500/40 text-sky-300" : r.state === "update" ? "border-amber-500/40 text-amber-300" : "text-muted-foreground")}>
                  {t(`integrations.itcloud.services.state.${r.state}`)}
                </Badge>
              </li>
            ))}
          </ul>
          {!shown.length && <p className="py-4 text-sm text-muted-foreground">{t("integrations.itcloud.list.none")}</p>}
          <Pager page={paged.page} pages={paged.pages} total={shown.length} setPage={paged.setPage} />
          <p className="mt-2 text-xs text-muted-foreground">{t("integrations.itcloud.services.manualNote")}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2 text-xs"
            disabled={zero.isPending}
            onClick={() => void confirm({ title: t("integrations.itcloud.services.zeroTitle"), description: t("integrations.itcloud.services.zeroText"), confirmLabel: t("integrations.itcloud.services.zeroConfirm"), destructive: true }).then((ok) => ok && zero.mutate())}
          >
            {zero.isPending && <Loader2 className="size-3.5 animate-spin" />} {t("integrations.itcloud.services.zero")}
          </Button>
          {data && data.ignored > 0 && <p className="mt-2 text-xs text-muted-foreground">{t("integrations.itcloud.services.ignored", { count: data.ignored })}</p>}
        </>
      )}
    </Step>
  );
}

// ── 3. the sync: each customer's services and the contract that carries them ──
type Row = { serviceId: number; clientName: string; productGroup: string; product: string; status: string; billingCycle: string; quantity: number; amountCents: number; state: string; contractName: string | null; contractId: string | null; customerContractId: string | null; contracts: { id: string; name: string }[] };
const STATES = ["synced", "client_unlinked", "product_unmatched", "no_contract", "inactive"] as const;

function SyncStep() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: [...KEY, "services"], queryFn: () => api.get<{ rows: Row[]; lastSync: View["lastSync"] }>("/admin/itcloud/services") });
  const [q, setQ] = useState("");
  const [state, setState] = useState<string>("");
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
  const pick = useMutation({
    mutationFn: (p: { serviceId: number; contractId: string | null }) => api.put<{ moved: boolean }>(`/admin/itcloud/services/${p.serviceId}/contract`, { contractId: p.contractId }),
    onSuccess: (r) => {
      toast.success(t(r.moved ? "integrations.itcloud.sync.contractMoved" : "integrations.itcloud.sync.contractSaved"));
      void qc.invalidateQueries({ queryKey: [...KEY, "services"] });
    },
    onError: (e) => toast.error(errorText(t, e)),
  });
  const last = data?.lastSync;
  const c = last?.counts;
  const shown = useMemo(() => (data?.rows ?? []).filter((r) => (!state || r.state === state) && has(q, r.product, r.clientName, r.productGroup, r.contractName)), [data, q, state]);
  const paged = usePaged(shown);
  const tally = (s: string) => (data?.rows ?? []).filter((r) => r.state === s).length;
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
        <>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <Search value={q} onChange={setQ} />
            <select value={state} onChange={(e) => setState(e.target.value)} className="h-8 rounded-md border bg-transparent px-2 text-xs" aria-label={t("integrations.itcloud.sync.filter")}>
              <option value="">{t("integrations.itcloud.sync.allStates")}</option>
              {STATES.map((s) => (
                <option key={s} value={s}>
                  {t(`integrations.itcloud.sync.state.${s}`)} ({tally(s)})
                </option>
              ))}
            </select>
          </div>
          <ul className="divide-y divide-border/60 text-sm">
            {paged.rows.map((r) => (
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
                {/* the contract of this service: the customer's choice (or the portal's), or one picked for this service alone */}
                {r.contracts.length > 0 && r.status.toLowerCase() === "active" && (
                  <select
                    value={r.contractId ?? ""}
                    disabled={pick.isPending}
                    onChange={(e) => pick.mutate({ serviceId: r.serviceId, contractId: e.target.value || null })}
                    className="h-8 max-w-48 rounded-md border bg-transparent px-2 text-xs"
                    aria-label={t("integrations.itcloud.sync.contract")}
                    title={t("integrations.itcloud.sync.contractHint")}
                  >
                    <option value="">{r.customerContractId ? t("integrations.itcloud.sync.contractDefault") : t("integrations.itcloud.sync.contractNone")}</option>
                    {r.contracts.map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.name}
                      </option>
                    ))}
                  </select>
                )}
                <Badge variant="outline" className={cn("w-40 justify-center", r.state === "synced" ? "border-emerald-500/40 text-emerald-400" : r.state === "inactive" ? "text-muted-foreground" : "border-amber-500/40 text-amber-300")}>
                  {t(`integrations.itcloud.sync.state.${r.state}`)}
                </Badge>
              </li>
            ))}
          </ul>
          {!shown.length && <p className="py-4 text-sm text-muted-foreground">{t("integrations.itcloud.list.none")}</p>}
          <Pager page={paged.page} pages={paged.pages} total={shown.length} setPage={paged.setPage} />
        </>
      )}
    </Step>
  );
}
