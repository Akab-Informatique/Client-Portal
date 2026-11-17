import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ExternalLink, Laptop, Loader2, MonitorPlay, MonitorSmartphone, Search, Server, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ClientDevice } from "@/pages/crm/ClientDevices";

type Device = ClientDevice & { clientId: string | null; clientName: string | null; lastReboot: string | null };
type Fleet = { connected: boolean; syncedAt: string | null; devices: Device[] };

const DAY = 86_400_000;
const isServer = (d: Device) => /server/i.test(`${d.category} ${d.kind}`);
const isLaptop = (d: Device) => /laptop|notebook/i.test(`${d.category} ${d.kind}`);
const stale = (d: Device) => !d.online && (!d.lastSeen || Date.now() - new Date(d.lastSeen).getTime() > 7 * DAY);
const patchLate = (d: Device) => d.patchesPending > 0 || (d.patchStatus !== "" && !/fully|nopolicy|nodata/i.test(d.patchStatus));
const eol = (d: Device) => /windows (7|8|8\.1|xp|vista|10)\b/i.test(d.os) || /server (2003|2008|2012)/i.test(d.os);
const warrantyExpired = (d: Device) => d.warrantyDate !== "" && d.warrantyDate < new Date().toISOString().slice(0, 10);
const avGood = (d: Device) => /running|active|up.?to.?date|enabled|ok/i.test(d.antivirusStatus);
const clientOf = (d: Device) => d.clientName ?? d.siteName;

/** What needs doing on a device, worst first: the chip text and its colour (red = act now) */
function todoOf(d: Device, t: (k: string, o?: Record<string, unknown>) => string): { tone: "red" | "amber"; text: string }[] {
  const out: { tone: "red" | "amber"; text: string }[] = [];
  if (stale(d)) out.push({ tone: "amber", text: t("devicesPage.todo.stale") });
  if (eol(d)) out.push({ tone: "red", text: t("devicesPage.todo.eol") });
  if (d.patchesPending > 0) out.push({ tone: d.patchesPending >= 5 ? "red" : "amber", text: t("devicesPage.todo.patches", { count: d.patchesPending }) });
  else if (patchLate(d)) out.push({ tone: "amber", text: d.patchStatus });
  if (d.rebootRequired) out.push({ tone: "amber", text: t("devicesPage.todo.reboot") });
  if (!d.antivirus) out.push({ tone: "amber", text: t("devicesPage.todo.noAv") });
  else if (d.antivirusStatus && !avGood(d)) out.push({ tone: "red", text: t("devicesPage.todo.avBad", { status: d.antivirusStatus }) });
  if (warrantyExpired(d)) out.push({ tone: "amber", text: t("devicesPage.todo.warranty") });
  return out;
}
const needsAction = (d: Device) => d.patchesPending > 0 || patchLate(d) || d.rebootRequired || stale(d) || eol(d) || (d.antivirus !== "" && d.antivirusStatus !== "" && !avGood(d));
const rank = (d: Device) => todoOf(d, () => "").reduce((n, x) => n + (x.tone === "red" ? 3 : 1), 0);

const chipCls = (tone: "red" | "amber") => (tone === "red" ? "border-red-400/40 bg-red-400/10 text-red-300" : "border-amber-400/40 bg-amber-400/10 text-amber-300");

/** The two data sources of a device: Datto RMM (D, blue) and the AKAB agent (A, gold, dashed while there is none) */
function Sources({ datto, agent }: { datto: boolean; agent: boolean }) {
  const { t } = useTranslation();
  return (
    <span className="flex justify-end gap-1">
      <span title={t("devicesPage.sourceDatto")} className={cn("grid size-5 place-items-center rounded-md border text-[10px] font-bold", datto ? "border-sky-300/40 bg-sky-300/10 text-sky-300" : "border-dashed border-muted-foreground/40 text-muted-foreground/50")}>
        D
      </span>
      <span title={agent ? t("devicesPage.sourceAgent") : t("devicesPage.agentSoon")} className={cn("grid size-5 place-items-center rounded-md border text-[10px] font-bold", agent ? "border-transparent bg-[image:var(--grad-gold)] text-[#1a1204]" : "border-dashed border-muted-foreground/40 text-muted-foreground/50")}>
        A
      </span>
    </span>
  );
}

const useFleet = () => useQuery({ queryKey: ["rmm", "fleet"], queryFn: () => api.get<Fleet>("/rmm/devices"), staleTime: 60_000, refetchInterval: 120_000 });
const CLOSED_KEY = "akab.devices.closed";
function loadClosed(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(CLOSED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

type Filter = "all" | "attention" | "offline" | "online" | "eol";

/** Appareils: every device of every client, read from Datto RMM (read only); the AKAB agent will add its own data later */
export function DevicesPage() {
  const { t } = useTranslation();
  const { data, isLoading } = useFleet();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [closed, setClosed] = useState<Set<string>>(loadClosed);
  const [openId, setOpenId] = useState<string | null>(null);
  const all = data?.devices ?? [];
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return all
      .filter((d) => (filter === "all" ? true : filter === "attention" ? needsAction(d) : filter === "offline" ? !d.online : filter === "online" ? d.online : eol(d)))
      .filter((d) => words.every((w) => `${d.hostname} ${d.description} ${clientOf(d)} ${d.lastUser} ${d.os} ${d.ip} ${d.kind} ${d.category}`.toLowerCase().includes(w)))
      .sort((a, b) => rank(b) - rank(a) || a.hostname.localeCompare(b.hostname));
  }, [all, q, filter]);
  const groups = useMemo(() => {
    const m = new Map<string, Device[]>();
    for (const d of list) m.set(clientOf(d), [...(m.get(clientOf(d)) ?? []), d]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [list]);
  const toggle = (name: string) =>
    setClosed((s) => {
      const n = new Set(s);
      if (!n.delete(name)) n.add(name);
      try {
        sessionStorage.setItem(CLOSED_KEY, JSON.stringify([...n]));
      } catch {
        /* the page works without it */
      }
      return n;
    });
  const setAll = (open: boolean) => {
    const n = open ? new Set<string>() : new Set(groups.map(([name]) => name));
    setClosed(n);
    try {
      sessionStorage.setItem(CLOSED_KEY, JSON.stringify([...n]));
    } catch {
      /* ignore */
    }
  };
  const open = all.find((d) => d.id === openId) ?? null;
  const tiles: [Filter, number, string][] = [
    ["all", all.length, "text-foreground"],
    ["attention", all.filter(needsAction).length, "text-red-300"],
    ["offline", all.filter((d) => !d.online).length, "text-amber-300"],
    ["online", all.filter((d) => d.online).length, "text-emerald-300"],
    ["eol", all.filter(eol).length, "text-amber-300"],
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">{t("devicesPage.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("devicesPage.subtitle")}
            {data?.syncedAt ? ` · ${t("devicesPage.syncedAt", { when: relativeTime(data.syncedAt) })}` : ""}
          </p>
        </div>
      </div>

      {isLoading ? (
        <Loader2 className="mx-auto my-16 size-5 animate-spin text-muted-foreground" />
      ) : all.length === 0 ? (
        <p className="rounded-2xl border border-dashed p-12 text-center text-sm text-muted-foreground">{t(data?.connected ? "devicesPage.empty" : "devicesPage.notConnected")}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
            {tiles.map(([key, n, tone]) => (
              <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(filter === key ? "all" : key)} className={cn("glass rounded-2xl border px-3.5 py-3 text-left transition-all hover:border-[color:var(--gold)]/40", filter === key && "border-[color:var(--gold)]/60 shadow-[0_0_24px_-12px_rgba(255,206,26,.5)]")}>
                <p className={cn("font-mono text-2xl font-semibold leading-tight", tone)}>{n}</p>
                <p className="text-xs text-muted-foreground">{t(`devicesPage.tile.${key}`)}</p>
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-52 flex-1">
              <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("devicesPage.search")} className="pl-9" />
            </div>
            <Button variant="outline" size="sm" onClick={() => setAll(true)}>
              {t("devicesPage.expandAll")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAll(false)}>
              {t("devicesPage.collapseAll")}
            </Button>
          </div>

          {list.length === 0 && <p className="rounded-2xl border border-dashed p-10 text-center text-sm text-muted-foreground">{t("devicesPage.noMatch")}</p>}

          <div className="hidden grid-cols-[minmax(10rem,1.1fr)_minmax(8rem,.8fr)_minmax(12rem,1.6fr)_minmax(9rem,1fr)_7rem_3.5rem] gap-3 px-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground lg:grid">
            <span>{t("devicesPage.col.device")}</span>
            <span>{t("devicesPage.col.lastUser")}</span>
            <span>{t("devicesPage.col.todo")}</span>
            <span>{t("devicesPage.col.system")}</span>
            <span>{t("devicesPage.col.contact")}</span>
            <span className="text-right">{t("devicesPage.col.sources")}</span>
          </div>

          {groups.map(([name, devices]) => {
            const folded = closed.has(name);
            const act = devices.filter(needsAction).length;
            return (
              <section key={name}>
                <button type="button" onClick={() => toggle(name)} aria-expanded={!folded} className="mb-1.5 flex w-full items-center gap-2.5 px-1 text-left">
                  <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", folded && "-rotate-90")} />
                  <span className="font-display text-base font-semibold">{name}</span>
                  {act > 0 && <span className="rounded-full border border-red-400/40 bg-red-400/10 px-2 py-px text-[11px] text-red-300">{t("devicesPage.attention", { count: act })}</span>}
                  <span className="ml-auto text-xs text-muted-foreground">{t("devicesPage.devicesCount", { count: devices.length })}</span>
                </button>
                {!folded &&
                  devices.map((d) => {
                    const Icon = isServer(d) ? Server : isLaptop(d) ? Laptop : MonitorSmartphone;
                    const todo = todoOf(d, t);
                    const worst = todo.some((x) => x.tone === "red") ? "bg-red-400" : todo.length ? "bg-amber-400" : "bg-emerald-400";
                    return (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => setOpenId(d.id)}
                        className={cn("glass relative mb-2 grid w-full grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 overflow-hidden rounded-2xl border px-4 py-2.5 pl-5 text-left transition-colors hover:border-[color:var(--gold)]/40 lg:grid-cols-[minmax(10rem,1.1fr)_minmax(8rem,.8fr)_minmax(12rem,1.6fr)_minmax(9rem,1fr)_7rem_3.5rem]", openId === d.id && "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/[0.05]")}
                      >
                        <span aria-hidden className={cn("absolute inset-y-2.5 left-0 w-[3px] rounded-full", worst)} />
                        <span className="flex min-w-0 items-center gap-3">
                          <span className="relative grid size-9 shrink-0 place-items-center rounded-xl border bg-background/40">
                            <Icon className="size-[18px] text-muted-foreground" />
                            <span className={cn("absolute -right-0.5 -top-0.5 size-2.5 rounded-full ring-2 ring-background", d.online ? "bg-emerald-400" : "bg-muted-foreground/60")} />
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate font-semibold">{d.hostname || d.uid}</span>
                            <span className="block truncate text-xs text-muted-foreground">{d.description || d.kind || d.category || "—"}</span>
                          </span>
                        </span>
                        <span className="hidden min-w-0 lg:block">
                          <span className="block truncate text-sm">{d.lastUser || t("devicesPage.neverUser")}</span>
                        </span>
                        <span className="col-span-2 flex flex-wrap gap-1 lg:col-span-1">
                          {todo.length === 0 ? <span className="text-xs text-muted-foreground">{t("devicesPage.fine")}</span> : todo.map((x, i) => <span key={i} className={cn("rounded-full border px-2 py-px text-[11.5px]", chipCls(x.tone))}>{x.text}</span>)}
                        </span>
                        <span className="hidden min-w-0 lg:block">
                          <span className="block truncate text-sm font-medium">{d.os || "—"}</span>
                          <span className="block truncate font-mono text-xs text-muted-foreground">{d.ip}</span>
                        </span>
                        <span className="hidden text-xs text-muted-foreground lg:block">{d.online ? t("devices.online") : d.lastSeen ? relativeTime(d.lastSeen) : t("devices.neverSeen")}</span>
                        <span className="hidden lg:block">
                          <Sources datto agent={false} />
                        </span>
                      </button>
                    );
                  })}
              </section>
            );
          })}
        </>
      )}

      <Sheet open={Boolean(open)} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg" aria-describedby={undefined}>
          {open && <Detail d={open} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Detail({ d }: { d: Device }) {
  const { t } = useTranslation();
  const todo = todoOf(d, t);
  const when = (iso: string | null) => (iso ? relativeTime(iso) : t("devicesPage.detail.none"));
  const rows: [string, string][] = [
    [t("devicesPage.detail.type"), [d.category, d.kind].filter(Boolean).join(" · ") || "—"],
    [t("devicesPage.detail.os"), d.os || "—"],
    [t("devicesPage.detail.ip"), d.ip || "—"],
    [t("devicesPage.detail.lastUser"), d.lastUser || "—"],
    [t("devicesPage.detail.lastSeen"), d.online ? t("devices.online") : when(d.lastSeen)],
    [t("devicesPage.detail.lastReboot"), when(d.lastReboot)],
    [t("devicesPage.detail.warranty"), d.warrantyDate || "—"],
    [t("devicesPage.detail.site"), d.siteName],
  ];
  const sec: [string, string][] = [
    [t("devicesPage.detail.antivirus"), [d.antivirus, d.antivirusStatus].filter(Boolean).join(" · ") || "—"],
    [t("devicesPage.detail.patches"), d.patchesPending > 0 ? t("devicesPage.todo.patches", { count: d.patchesPending }) : d.patchStatus || "—"],
  ];
  return (
    <div className="space-y-4 p-5">
      <div>
        <SheetTitle className="font-display text-2xl">{d.hostname || d.uid}</SheetTitle>
        <SheetDescription className="mt-1">{clientOf(d)}</SheetDescription>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-px text-xs", d.online ? "border-emerald-400/40 text-emerald-300" : "border-muted-foreground/40 text-muted-foreground")}>
            <span className={cn("size-2 rounded-full", d.online ? "bg-emerald-400" : "bg-muted-foreground/60")} /> {t(d.online ? "devices.online" : "devices.offline")}
          </span>
          <Sources datto agent={false} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {d.remoteUrl && (
            <Button asChild size="sm">
              <a href={d.remoteUrl} target="_blank" rel="noopener noreferrer">
                <MonitorPlay className="size-4" /> {t("devices.remote")}
              </a>
            </Button>
          )}
          {d.portalUrl && (
            <Button asChild size="sm" variant="outline">
              <a href={d.portalUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-4" /> {t("devices.open")}
              </a>
            </Button>
          )}
          <Button size="sm" variant="outline" disabled title={t("devicesPage.detail.terminalSoon")}>
            <Terminal className="size-4" /> Terminal
          </Button>
          {d.clientId && (
            <Button asChild size="sm" variant="ghost">
              <Link to={`/crm/${d.clientId}`}>{t("devicesPage.detail.openClient")}</Link>
            </Button>
          )}
        </div>
      </div>

      <section className="glass rounded-2xl border p-4">
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">{t("devicesPage.detail.todoTitle")}</h3>
        {todo.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("devicesPage.fine")}</p>
        ) : (
          <ul className="space-y-1.5">
            {todo.map((x, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <span className={cn("size-2 rounded-full", x.tone === "red" ? "bg-red-400" : "bg-amber-400")} /> {x.text}
              </li>
            ))}
          </ul>
        )}
      </section>

      {[
        [t("devicesPage.detail.hardware"), rows],
        [t("devicesPage.detail.security"), sec],
      ].map(([title, list]) => (
        <section key={title as string} className="glass rounded-2xl border p-4">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">{title as string}</h3>
          <dl className="grid grid-cols-[8rem_1fr_auto] items-center gap-x-3 gap-y-1.5 text-sm">
            {(list as [string, string][]).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="min-w-0 truncate">{v}</dd>
                <dd>
                  <span title={t("devicesPage.sourceDatto")} className="rounded border border-sky-300/40 px-1 text-[10px] font-bold text-sky-300">
                    D
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <p className="text-xs text-muted-foreground">{t("devicesPage.detail.conflictNote")}</p>
    </div>
  );
}
