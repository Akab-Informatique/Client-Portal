import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Flag, Plus, Search, X } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Pager } from "@/components/Pager";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCan, useMe } from "@/lib/session";
import { ClientPick } from "./ClientPick";
import { cn } from "@/lib/utils";
import { OPP_SOURCES } from "@shared/opps";
import { NewOppDialog } from "./NewOppDialog";
import { OppDialog } from "./OppDialog";
import { OppReport } from "./OppReport";
import { OppRows } from "./OppRows";
import { useDebounced, useOppCandidates, useOppFilters, useOppList, type OppClient, type OppTab } from "./shared";

const ALL = "all";

/** Opportunités: what technicians flag for sales, who takes it, what it became. */
export function OppsPage() {
  const { t } = useTranslation();
  const can = useCan();
  const me = useMe();
  const f = useOppFilters();
  const [creating, setCreating] = useState(false);
  const [qInput, setQInput] = useState(f.q);
  const q = useDebounced(qInput);
  useEffect(() => setQInput(f.q), [f.q]);
  useEffect(() => {
    if (q !== f.q) f.set({ q: q || null });
    // f.set is recreated at each render; only the typed text matters here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, f.q]);

  const archived = f.tab === "archives";
  const list = useOppList({ status: archived ? "closed" : "open", owner: f.owner, source: f.source, client: f.client, q: f.q, page: f.page, size: f.size });
  const mine = useOppList({ status: "open", owner: "me", size: 1 });
  const data = list.data;
  const counts = data?.counts;
  // the owner list and the client search come from the opportunities scope (needs opps.create)
  const candidates = useOppCandidates(can("opps.create"));
  const [clientPicked, setClientPicked] = useState<OppClient | null>(null);
  const filtered = Boolean(f.owner !== ALL || f.source || f.client || f.q);
  const canCreate = can("opps.create");

  const tabs: { key: OppTab; label: string }[] = [
    { key: "open", label: t("opps.tabs.open") },
    { key: "archives", label: t("opps.tabs.archives") },
    { key: "report", label: t("opps.tabs.report") },
  ];

  const tiles = [
    { key: "new", value: counts?.new ?? 0, label: t("opps.tiles.new"), go: { tab: "open", owner: "none" }, attention: (counts?.new ?? 0) > 0 },
    { key: "working", value: counts?.working ?? 0, label: t("opps.tiles.working"), go: { tab: "open", owner: "all" }, attention: false },
    { key: "mine", value: mine.data?.total ?? 0, label: t("opps.tiles.mine"), go: { tab: "open", owner: "me" }, attention: false },
    { key: "archived", value: counts?.closed ?? 0, label: t("opps.tiles.archived"), go: { tab: "archives", owner: "all" }, attention: false },
  ];

  return (
    <div className="relative isolate space-y-5">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Flag className="size-6 text-primary" /> {t("opps.title")}
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t("opps.subtitle")}</p>
        </div>
        {canCreate && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" /> {t("opps.add")}
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((x) => (
          <button
            key={x.key}
            type="button"
            onClick={() => f.set({ tab: x.go.tab === "open" ? null : x.go.tab, owner: x.go.owner === "all" ? null : x.go.owner })}
            aria-label={x.label}
            className={cn(
              "glass rounded-xl border p-4 text-left transition-colors hover:border-[color:var(--gold)]/50",
              x.attention && "animate-attention border-[color:var(--gold)]/70 ring-2 ring-[color:var(--gold)]/40",
            )}
            title={x.attention ? t("opps.flashNew") : undefined}
          >
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{x.label}</div>
            <div className="mt-1 font-display text-3xl font-bold tabular-nums">{x.value}</div>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div role="tablist" className="glass inline-flex rounded-xl border p-1">
          {tabs.map((x) => (
            <button
              key={x.key}
              role="tab"
              aria-selected={f.tab === x.key}
              onClick={() => f.set({ tab: x.key === "open" ? null : x.key })}
              className={cn("rounded-lg px-3 py-1.5 text-sm transition-colors", f.tab === x.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {x.label}
            </button>
          ))}
        </div>
      </div>

      {f.tab !== "report" && (
        <div className="glass flex flex-wrap items-center gap-2 rounded-xl border p-3">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder={t("opps.search")} aria-label={t("opps.search")} className="h-9 pl-8" />
          </div>
          <FilterSelect label={t("opps.owner.label")} value={f.owner} onChange={(v) => f.set({ owner: v === ALL ? null : v })} width="sm:w-44">
            <SelectItem value={ALL}>{t("opps.owner.all")}</SelectItem>
            <SelectItem value="me">{t("opps.owner.me")}</SelectItem>
            <SelectItem value="none">{t("opps.owner.none")}</SelectItem>
            {(candidates.data ?? [])
              .filter((c) => c.sales && c.id !== me.id)
              .map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
          </FilterSelect>
          <FilterSelect label={t("opps.source.label")} value={f.source || ALL} onChange={(v) => f.set({ source: v === ALL ? null : v })} width="sm:w-48">
            <SelectItem value={ALL}>{t("opps.source.all")}</SelectItem>
            {OPP_SOURCES.map((s) => (
              <SelectItem key={s} value={s}>
                {t(`opps.sources.${s}`)}
              </SelectItem>
            ))}
          </FilterSelect>
          {can("opps.create") && (
            <div className="w-full sm:w-56">
              <ClientPick
                value={f.client ? { id: f.client, name: clientPicked?.id === f.client ? clientPicked.name : t("opps.client.label") } : null}
                onChange={(c) => {
                  setClientPicked(c);
                  f.set({ client: c.id });
                }}
                label={t("opps.client.label")}
                placeholder={t("opps.client.all")}
              />
            </div>
          )}
          {filtered && (
            <Button variant="ghost" size="sm" onClick={() => { setQInput(""); f.set({ owner: null, source: null, client: null, q: null }); }}>
              <X className="size-4" /> {t("opps.clearFilters")}
            </Button>
          )}
        </div>
      )}

      {f.tab === "report" ? (
        <OppReport />
      ) : (
        <div className="glass overflow-hidden rounded-xl border">
          {list.isLoading ? null : data && data.rows.length > 0 ? (
            <OppRows rows={data.rows} archived={archived} onOpen={(id) => f.set({ opp: id })} />
          ) : (
            <p className="px-4 py-12 text-center text-sm text-muted-foreground">{archived ? t("opps.emptyArchive") : t("opps.empty")}</p>
          )}
          {data && data.total > 0 && (
            <Pager total={data.total} page={f.page} size={f.size} onPage={(p) => f.set({ page: String(p) })} onSize={(s) => f.set({ size: String(s), page: null })} />
          )}
        </div>
      )}

      {f.opp && <OppDialog id={f.opp} onClose={() => f.set({ opp: null })} />}
      {creating && <NewOppDialog onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); f.set({ opp: id }); }} />}
    </div>
  );
}

function FilterSelect({ label, value, onChange, width, children }: { label: string; value: string; onChange: (v: string) => void; width: string; children: ReactNode }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className={cn("h-9 w-full", width)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}
