import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, CircleAlert, CircleCheck, Eye, EyeOff, Loader2, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { SectionHeader } from "./sections";

const fail = (t: (k: string, o?: Record<string, unknown>) => string) => (e: unknown) => toast.error(e instanceof ApiError ? t(`ticketSetup.errors.${e.code}`, { defaultValue: t("common.error") }) : t("common.error"));

function Card({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mb-8 rounded-2xl border bg-card/60 p-4">
      <h3 className="font-display text-base font-semibold">{title}</h3>
      {hint && <p className="mb-4 mt-1 text-xs text-muted-foreground">{hint}</p>}
      {children}
    </section>
  );
}

/** Admin › Billets: where tickets come from, how the statuses are named and offered, and the manual sync with Autotask. */
export function TicketSetupSection() {
  const { t } = useTranslation();
  return (
    <div>
      <SectionHeader title={t("ticketSetup.title")} subtitle={t("ticketSetup.subtitle")} />
      <LocalCard />
      <SyncCard />
      <SourcesCard />
      <StatusesCard />
    </div>
  );
}

// ── Sync with Autotask, by hand ──
type SyncInfo = {
  auto: boolean;
  since: string;
  demo: boolean;
  copy: { total: number; newestActivity: string | null; syncedAt: string | null };
  lastRun: { at: string; ok: boolean; total: number; completed: number; error?: string } | null;
  local?: boolean;
};

// ── The tickets of the portal (no longer tied to Autotask) ──
type LocalInfo = {
  mode: "autotask" | "local";
  linked: boolean;
  switchedAt: string | null;
  since: string;
  tickets: number;
  import: { state: "running" | "done" | "failed"; done: number; startedAt: string; finishedAt?: string; error?: string } | null;
};
function LocalCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data } = useQuery({
    queryKey: ["admin", "ticket-local"],
    queryFn: () => api.get<LocalInfo>("/admin/ticket-setup/local"),
    // while the copy runs
    refetchInterval: (q) => (q.state.data?.import?.state === "running" ? 2000 : false),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["admin", "ticket-local"] });
    void qc.invalidateQueries({ queryKey: ["admin", "ticket-sync"] });
    void qc.invalidateQueries({ queryKey: ["tickets"] });
  };
  const start = useMutation({ mutationFn: () => api.post("/admin/ticket-setup/local/switch", {}), onSuccess: refresh, onError: fail(t) });
  const [numbers, setNumbers] = useState("");
  const [period, setPeriod] = useState("");
  const pull = useMutation({
    mutationFn: (p: { numbers?: string[]; since?: string }) => api.post<{ imported: number; missing: string[] }>("/admin/ticket-setup/local/import", p),
    onSuccess: (r) => {
      refresh();
      toast.success(t("ticketSetup.local.imported", { count: r.imported }));
      if (r.missing.length) toast.warning(t("ticketSetup.local.missing", { list: r.missing.join(", ") }));
      setNumbers("");
    },
    onError: fail(t),
  });
  const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "—");
  const running = data?.import?.state === "running";
  const parsed = numbers.split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
  const ask = () =>
    void confirm({ title: t("ticketSetup.local.confirmTitle"), description: t("ticketSetup.local.confirmText", { since: data?.since ?? "" }), confirmLabel: t("ticketSetup.local.confirm"), destructive: true }).then((ok) => ok && start.mutate());
  if (!data) return null;
  return (
    <Card title={t("ticketSetup.local.title")} hint={t("ticketSetup.local.hint")}>
      {data.mode === "autotask" ? (
        <div className="space-y-3">
          <p className="text-sm">{t("ticketSetup.local.notYet")}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={ask} disabled={running || start.isPending}>
              {running || start.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {t("ticketSetup.local.switch")}
            </Button>
            {running && <span className="text-xs text-muted-foreground">{t("ticketSetup.local.copying", { count: data.import?.done ?? 0 })}</span>}
          </div>
          {data.import?.state === "failed" && (
            <p className="flex items-start gap-2 text-xs text-destructive">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" /> {t("ticketSetup.local.failed", { error: data.import.error ?? "" })}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="flex items-start gap-2 text-sm text-emerald-300">
            <CircleCheck className="mt-0.5 size-4 shrink-0" /> {t("ticketSetup.local.active", { at: when(data.switchedAt), count: data.tickets })}
          </p>
          <div className="space-y-2 rounded-xl border p-3">
            <p className="text-sm font-medium">{t("ticketSetup.local.importTitle")}</p>
            <p className="text-xs text-muted-foreground">{data.linked ? t("ticketSetup.local.importHint") : t("ticketSetup.local.notLinked")}</p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-64 flex-1 space-y-1 text-xs text-muted-foreground">
                {t("ticketSetup.local.numbers")}
                <Input value={numbers} onChange={(e) => setNumbers(e.target.value)} placeholder="T20261016.0043, T20261016.0044" className="h-9 font-mono text-sm" disabled={!data.linked} />
              </label>
              <Button type="button" variant="outline" disabled={!data.linked || !parsed.length || pull.isPending} onClick={() => pull.mutate({ numbers: parsed })}>
                {pull.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {t("ticketSetup.local.importNumbers")}
              </Button>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="space-y-1 text-xs text-muted-foreground">
                {t("ticketSetup.local.period")}
                <Input type="date" value={period} onChange={(e) => setPeriod(e.target.value)} className="h-9 w-44" disabled={!data.linked} />
              </label>
              <Button type="button" variant="outline" disabled={!data.linked || !period || pull.isPending} onClick={() => pull.mutate({ since: period })}>
                {pull.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {t("ticketSetup.local.importPeriod")}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">{t("ticketSetup.local.replaces")}</p>
          </div>
        </div>
      )}
    </Card>
  );
}

function SyncCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["admin", "ticket-sync"], queryFn: () => api.get<SyncInfo>("/admin/ticket-setup/sync") });
  const [since, setSince] = useState("");
  useEffect(() => data && setSince(data.since), [data?.since]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["admin", "ticket-sync"] });
    void qc.invalidateQueries({ queryKey: ["tickets"] });
  };
  const save = useMutation({
    mutationFn: (p: { auto?: boolean; since?: string }) => api.put("/admin/ticket-setup/sync", p),
    onSuccess: () => {
      refresh();
      toast.success(t("common.saved"));
    },
    onError: fail(t),
  });
  const run = useMutation({
    mutationFn: () => api.post<{ ok: boolean; total: number; completed: number }>("/admin/ticket-setup/sync/run", {}),
    onSuccess: (r) => {
      refresh();
      toast.success(t("ticketSetup.sync.done", { total: r.total, completed: r.completed }));
    },
    onError: (e) => {
      refresh();
      fail(t)(e);
    },
  });
  const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "—");
  // the portal owns the tickets: nothing is synced by itself (the card above imports what is asked)
  if (data?.local) return null;
  return (
    <Card title={t("ticketSetup.sync.title")} hint={t("ticketSetup.sync.hint")}>
      {data?.demo && <p className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{t("ticketSetup.sync.demo")}</p>}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={data?.auto ?? false} disabled={!data || save.isPending} onCheckedChange={(auto) => save.mutate({ auto })} /> {t("ticketSetup.sync.auto")}
        </label>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          {t("ticketSetup.sync.since")}
          <Input
            type="date"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            onBlur={() => since && data && since !== data.since && save.mutate({ since })}
            className="h-9 w-40"
          />
        </label>
        <Button type="button" onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} {t("ticketSetup.sync.run")}
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{data?.auto ? t("ticketSetup.sync.autoOn") : t("ticketSetup.sync.autoOff")}</p>
      {run.isPending && <p className="mt-2 text-xs text-muted-foreground">{t("ticketSetup.sync.running")}</p>}
      <dl className="mt-4 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">{t("ticketSetup.sync.inCopy")}</dt>
          <dd className="font-medium">{data?.copy.total ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("ticketSetup.sync.lastSync")}</dt>
          <dd className="font-medium">{when(data?.copy.syncedAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("ticketSetup.sync.newest")}</dt>
          <dd className="font-medium">{when(data?.copy.newestActivity)}</dd>
        </div>
      </dl>
      {data?.lastRun && (
        <p className={cn("mt-3 flex items-start gap-2 text-xs", data.lastRun.ok ? "text-emerald-300" : "text-destructive")}>
          {data.lastRun.ok ? <CircleCheck className="mt-0.5 size-3.5 shrink-0" /> : <CircleAlert className="mt-0.5 size-3.5 shrink-0" />}
          {data.lastRun.ok ? t("ticketSetup.sync.lastOk", { at: when(data.lastRun.at), total: data.lastRun.total, completed: data.lastRun.completed }) : t("ticketSetup.sync.lastFailed", { at: when(data.lastRun.at), error: data.lastRun.error ?? "" })}
        </p>
      )}
    </Card>
  );
}

// ── Sources ──
type Source = { key: string; name: string; position: number; tickets: number };
const SRC_KEY = ["admin", "ticket-sources"];
function SourcesCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data = [], isLoading } = useQuery({ queryKey: SRC_KEY, queryFn: () => api.get<Source[]>("/admin/ticket-setup/sources") });
  const [name, setName] = useState("");
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: SRC_KEY });
    void qc.invalidateQueries({ queryKey: ["tickets"] });
  };
  const add = useMutation({
    mutationFn: () => api.post("/admin/ticket-setup/sources", { name: name.trim() }),
    onSuccess: () => {
      setName("");
      refresh();
    },
    onError: fail(t),
  });
  const rename = useMutation({ mutationFn: (v: { key: string; name: string }) => api.patch(`/admin/ticket-setup/sources/${v.key}`, { name: v.name }), onSuccess: refresh, onError: fail(t) });
  const move = useMutation({ mutationFn: (v: { key: string; direction: "up" | "down" }) => api.post(`/admin/ticket-setup/sources/${v.key}/move`, { direction: v.direction }), onSuccess: refresh, onError: fail(t) });
  const remove = useMutation({ mutationFn: (key: string) => api.del(`/admin/ticket-setup/sources/${key}`), onSuccess: refresh, onError: fail(t) });
  return (
    <Card title={t("ticketSetup.sources.title")} hint={t("ticketSetup.sources.hint")}>
      <form
        className="mb-4 flex flex-wrap items-center gap-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (name.trim()) add.mutate();
        }}
      >
        <Input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder={t("ticketSetup.sources.newPlaceholder")} className="max-w-64" aria-label={t("ticketSetup.sources.newPlaceholder")} />
        <Button type="submit" disabled={!name.trim() || add.isPending}>
          <Plus className="size-4" /> {t("ticketSetup.add")}
        </Button>
      </form>
      {isLoading && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
      <ul className="space-y-2">
        {data.map((s, i) => (
          <SourceRow
            key={s.key}
            s={s}
            first={i === 0}
            last={i === data.length - 1}
            onRename={(n) => rename.mutate({ key: s.key, name: n })}
            onMove={(direction) => move.mutate({ key: s.key, direction })}
            onDelete={() => void confirm({ title: t("ticketSetup.sources.deleteTitle", { name: s.name }), description: t("ticketSetup.sources.deleteText", { count: s.tickets }), destructive: true }).then((ok) => ok && remove.mutate(s.key))}
          />
        ))}
      </ul>
    </Card>
  );
}
function SourceRow({ s, first, last, onRename, onMove, onDelete }: { s: Source; first: boolean; last: boolean; onRename: (n: string) => void; onMove: (d: "up" | "down") => void; onDelete: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(s.name);
  useEffect(() => setName(s.name), [s.name]);
  const save = () => {
    const n = name.trim();
    if (!n) setName(s.name);
    else if (n !== s.name) onRename(n);
  };
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-xl border bg-card/80 p-2.5">
      <div className="flex flex-col">
        <button type="button" disabled={first} onClick={() => onMove("up")} className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label={t("ticketSetup.up")}>
          <ArrowUp className="size-4" />
        </button>
        <button type="button" disabled={last} onClick={() => onMove("down")} className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label={t("ticketSetup.down")}>
          <ArrowDown className="size-4" />
        </button>
      </div>
      <Input
        value={name}
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setName(s.name);
        }}
        className="h-9 w-56 font-medium"
        aria-label={t("ticketSetup.sources.name")}
      />
      <span className="ml-auto text-xs text-muted-foreground">{t("ticketSetup.tickets", { count: s.tickets })}</span>
      <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" aria-label={t("common.delete")} onClick={onDelete}>
        <Trash2 className="size-4" />
      </Button>
    </li>
  );
}

// ── Statuses ──
type StatusItem = { value: string; sourceLabel: string; sourceKind: string; label: string | null; kind: string; hidden: boolean; tickets: number };
type StatusData = { kinds: string[]; items: StatusItem[] };
const ST_KEY = ["admin", "ticket-statuses"];
function StatusesCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ST_KEY, queryFn: () => api.get<StatusData>("/admin/ticket-setup/statuses") });
  const [rows, setRows] = useState<StatusItem[]>([]);
  useEffect(() => data && setRows(data.items), [data]);
  const dirty = data ? JSON.stringify(rows.map((r) => [r.value, r.label || null, r.kind, r.hidden])) !== JSON.stringify(data.items.map((r) => [r.value, r.label || null, r.kind, r.hidden])) : false;
  const save = useMutation({
    mutationFn: () =>
      api.put("/admin/ticket-setup/statuses", {
        // the source's own wording is not stored as an override
        items: rows.map((r) => ({ value: r.value, label: r.label && r.label !== r.sourceLabel ? r.label : null, kind: r.kind === r.sourceKind ? null : r.kind, hidden: r.hidden })),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ST_KEY });
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      toast.success(t("common.saved"));
    },
    onError: fail(t),
  });
  const patch = (i: number, p: Partial<StatusItem>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const move = (i: number, d: -1 | 1) =>
    setRows((r) => {
      const j = i + d;
      if (j < 0 || j >= r.length) return r;
      const n = [...r];
      [n[i], n[j]] = [n[j]!, n[i]!];
      return n;
    });
  return (
    <Card title={t("ticketSetup.statuses.title")} hint={t("ticketSetup.statuses.hint")}>
      {isLoading && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
      <ul className="space-y-2">
        {rows.map((r, i) => (
          <li key={r.value} className={cn("flex flex-wrap items-center gap-3 rounded-xl border bg-card/80 p-2.5", r.hidden && "opacity-70")}>
            <div className="flex flex-col">
              <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label={t("ticketSetup.up")}>
                <ArrowUp className="size-4" />
              </button>
              <button type="button" disabled={i === rows.length - 1} onClick={() => move(i, 1)} className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label={t("ticketSetup.down")}>
                <ArrowDown className="size-4" />
              </button>
            </div>
            <Input
              value={r.label ?? ""}
              maxLength={60}
              placeholder={r.sourceLabel}
              onChange={(e) => patch(i, { label: e.target.value })}
              className="h-9 w-56 font-medium"
              aria-label={t("ticketSetup.statuses.label")}
            />
            <select
              value={r.kind}
              onChange={(e) => patch(i, { kind: e.target.value })}
              className="h-9 rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40"
              aria-label={t("ticketSetup.statuses.kind")}
            >
              {(data?.kinds ?? []).map((k) => (
                <option key={k} value={k}>
                  {t(`tickets.status.${k}`, { defaultValue: k })}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-xs text-muted-foreground" title={t("ticketSetup.statuses.offeredHint")}>
              <Switch checked={!r.hidden} onCheckedChange={(v) => patch(i, { hidden: !v })} />
              {r.hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />} {t("ticketSetup.statuses.offered")}
            </label>
            <span className="ml-auto text-xs text-muted-foreground">
              {r.sourceLabel !== (r.label || r.sourceLabel) && <span className="mr-2">{t("ticketSetup.statuses.in", { name: r.sourceLabel })}</span>}
              {t("ticketSetup.tickets", { count: r.tickets })}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex items-center gap-3">
        <Button type="button" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
          {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} {t("common.save")}
        </Button>
        {dirty && (
          <Button type="button" variant="ghost" onClick={() => data && setRows(data.items)}>
            {t("common.cancel")}
          </Button>
        )}
      </div>
    </Card>
  );
}
