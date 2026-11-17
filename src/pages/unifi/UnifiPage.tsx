import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, Loader2, Network, RefreshCw, Router, Search, Server, Wifi } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type Host = { id: string; name: string; model: string; type: string; firmware: string; ip: string; online: boolean; state: string; lastChange: string | null };
type Site = { id: string; hostId: string; name: string; devices: number; offline: number; pendingUpdates: number; clients: number };
type Device = { id: string; hostId: string; hostName: string; siteId: string; name: string; model: string; kind: string; mac: string; ip: string; firmware: string; updateAvailable: string; online: boolean; status: string; uptimeSince: string | null; isConsole: boolean };
type Overview = { hosts: Host[]; sites: Site[]; devices: Device[]; fetchedAt: string };
type Status = { configured: boolean; enabled: boolean; ready: boolean };
type Filter = "all" | "online" | "offline" | "attention";

const needsAttention = (d: Device) => !d.online || Boolean(d.updateAvailable);

/** My IT tools > UniFi console: the consoles, sites and devices of the Ubiquiti account (read only) */
export function UnifiPage() {
  const { t } = useTranslation();
  const status = useQuery({ queryKey: ["unifi", "status"], queryFn: () => api.get<Status>("/unifi/status") });
  const ready = status.data?.ready === true;
  const ov = useQuery({ queryKey: ["unifi", "overview"], queryFn: () => api.get<Overview>("/unifi/overview"), enabled: ready, staleTime: 60_000, retry: false });
  const [q, setQ] = useState("");
  const [host, setHost] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const data = ov.data;
  const inScope = useMemo(() => (data?.devices ?? []).filter((d) => !host || d.hostId === host), [data, host]);
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return inScope.filter((d) => (filter === "all" || (filter === "online" ? d.online : filter === "offline" ? !d.online : needsAttention(d))) && words.every((w) => `${d.name} ${d.model} ${d.ip} ${d.mac} ${d.firmware} ${d.hostName} ${d.kind}`.toLowerCase().includes(w)));
  }, [inScope, q, filter]);

  const header = (
    <div className="flex flex-wrap items-center gap-3">
      <span className="flex size-11 items-center justify-center rounded-xl bg-grad-gold text-[#1a1204]">
        <Network className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h1 className="font-display text-2xl font-semibold">{t("unifi.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("unifi.subtitle")}</p>
      </div>
      <Button asChild variant="outline" size="sm">
        <a href="https://unifi.ui.com" target="_blank" rel="noopener noreferrer">
          <ExternalLink className="mr-1 size-4" />
          {t("unifi.open")}
        </a>
      </Button>
      {ready && (
        <Button variant="outline" size="sm" disabled={ov.isFetching} onClick={() => void ov.refetch()}>
          <RefreshCw className={cn("mr-1 size-4", ov.isFetching && "animate-spin")} />
          {t("unifi.refresh")}
        </Button>
      )}
    </div>
  );

  if (status.isLoading) return <Loader2 className="mx-auto my-16 size-5 animate-spin text-muted-foreground" />;
  if (!ready)
    return (
      <div className="space-y-6">
        {header}
        <div className="rounded-xl border border-dashed p-10 text-center">
          <p className="font-medium">{t("unifi.notConfigured")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("unifi.notConfiguredHint")}</p>
        </div>
      </div>
    );

  const tiles: [Filter | "consoles" | "sites", string, number, string][] = data
    ? [
        ["consoles", "consoles", (host ? data.hosts.filter((h) => h.id === host) : data.hosts).length, ""],
        ["sites", "sites", (host ? data.sites.filter((s) => s.hostId === host) : data.sites).length, ""],
        ["online", "online", inScope.filter((d) => d.online).length, "text-emerald-300"],
        ["offline", "offline", inScope.filter((d) => !d.online).length, "text-red-300"],
        ["attention", "attention", inScope.filter(needsAttention).length, "text-amber-300"],
      ]
    : [];

  return (
    <div className="space-y-5">
      {header}
      {ov.isLoading && <Loader2 className="mx-auto my-10 size-5 animate-spin text-muted-foreground" />}
      {ov.isError && (
        <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-300">
          <AlertTriangle className="size-4" />
          {t("unifi.failed", { code: ov.error instanceof ApiError ? ov.error.code : "error" })}
        </div>
      )}
      {data && (
        <>
          <div className="grid gap-2 sm:grid-cols-5">
            {tiles.map(([key, label, n, tone]) => {
              const clickable = key !== "consoles" && key !== "sites";
              return (
                <button key={key} type="button" disabled={!clickable} aria-pressed={filter === key} onClick={() => clickable && setFilter(filter === key ? "all" : (key as Filter))} className={cn("rounded-xl border bg-background/40 px-3 py-2.5 text-left transition-colors enabled:hover:bg-accent/40", filter === key && "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/[0.06]")}>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t(`unifi.tile.${label}`)}</p>
                  <p className={cn("font-mono text-xl font-semibold", tone)}>{n}</p>
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("unifi.search")} className="pl-8" />
            </div>
            <select value={host} onChange={(e) => setHost(e.target.value)} className="h-9 rounded-md border bg-transparent px-2 text-sm" aria-label={t("unifi.allSites")}>
              <option value="" className="bg-background">
                {t("unifi.allSites")}
              </option>
              {data.hosts.map((h) => (
                <option key={h.id} value={h.id} className="bg-background">
                  {h.name}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">{t("unifi.updatedAt", { when: relativeTime(data.fetchedAt) })}</span>
          </div>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {data.hosts
              .filter((h) => !host || h.id === host)
              .map((h) => {
                const sites = data.sites.filter((s) => s.hostId === h.id);
                return (
                  <div key={h.id} className="rounded-xl border bg-background/40 px-4 py-3 text-sm">
                    <div className="flex items-center gap-2">
                      <span className={cn("size-2 rounded-full", h.online ? "bg-emerald-400" : "bg-muted-foreground/60")} title={t(h.online ? "unifi.online" : "unifi.consoleOffline")} />
                      <span className="truncate font-medium">{h.name}</span>
                      <Badge variant="outline" className="ml-auto shrink-0">
                        {t("unifi.console")}
                      </Badge>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{[h.model, h.ip, h.firmware].filter(Boolean).join(" · ") || "—"}</p>
                    {sites.map((s) => (
                      <p key={s.id} className="mt-1 truncate text-xs">
                        <span className="font-medium">{s.name}</span> <span className="text-muted-foreground">{t("unifi.siteLine", { devices: s.devices, offline: s.offline, updates: s.pendingUpdates })}</span>
                      </p>
                    ))}
                  </div>
                );
              })}
          </div>
          <ul className="divide-y divide-border/50 overflow-hidden rounded-xl border">
            {list.length === 0 && <li className="p-8 text-center text-sm text-muted-foreground">{t("unifi.empty")}</li>}
            {list.map((d) => {
              const Icon = d.isConsole ? Server : /wifi|ap|u6|u7|uap/i.test(`${d.kind} ${d.model}`) ? Wifi : Router;
              return (
                <li key={`${d.hostId}:${d.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
                  <span className="flex min-w-48 flex-1 items-center gap-3">
                    <span className="relative">
                      <Icon className="size-5 text-muted-foreground" />
                      <span className={cn("absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background", d.online ? "bg-emerald-400" : "bg-red-400")} title={t(d.online ? "unifi.online" : "unifi.offline")} />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{d.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{[d.model, d.hostName].filter(Boolean).join(" · ") || "—"}</span>
                    </span>
                  </span>
                  <span className="w-32 font-mono text-xs text-muted-foreground">{d.ip || "—"}</span>
                  <span className="w-36 truncate font-mono text-xs text-muted-foreground">{d.mac || "—"}</span>
                  <span className="w-28 truncate font-mono text-xs text-muted-foreground" title={d.firmware}>
                    {d.firmware || "—"}
                  </span>
                  {d.updateAvailable && (
                    <Badge variant="outline" className="border-amber-500/40 text-amber-300" title={t("unifi.update", { version: d.updateAvailable })}>
                      {t("unifi.updateAvailable")}
                    </Badge>
                  )}
                  <span className="w-40 text-xs text-muted-foreground">{d.online && d.uptimeSince ? t("unifi.uptime", { when: relativeTime(d.uptimeSince) }) : t(d.online ? "unifi.online" : "unifi.offline")}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
