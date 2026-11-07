import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, Laptop, Loader2, MonitorPlay, MonitorSmartphone, Search, Server } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export type ClientDevice = {
  id: string;
  uid: string;
  siteName: string;
  hostname: string;
  description: string;
  ip: string;
  os: string;
  lastUser: string;
  category: string;
  kind: string;
  online: boolean;
  rebootRequired: boolean;
  lastSeen: string | null;
  patchStatus: string;
  patchesPending: number;
  antivirus: string;
  antivirusStatus: string;
  warrantyDate: string;
  portalUrl: string | null;
  remoteUrl: string | null;
};
export type ClientDevices = { connected: boolean; sites: number; syncedAt: string | null; devices: ClientDevice[] };
export const devicesKey = (clientId: string) => ["rmm", "client", clientId, "devices"];
export const useClientDevices = (clientId: string) => useQuery({ queryKey: devicesKey(clientId), queryFn: () => api.get<ClientDevices>(`/rmm/clients/${clientId}/devices`), staleTime: 60_000 });

const DAY = 86_400_000;
const isServer = (d: ClientDevice) => /server/i.test(`${d.category} ${d.kind}`);
/** Offline for a week or more */
const stale = (d: ClientDevice) => !d.online && (!d.lastSeen || Date.now() - new Date(d.lastSeen).getTime() > 7 * DAY);
const patchLate = (d: ClientDevice) => d.patchesPending > 0 || (d.patchStatus !== "" && !/fully|nopolicy|noData/i.test(d.patchStatus));

type Filter = "all" | "online" | "offline" | "attention";

/** CRM › client › Appareils: the client's computers as the RMM (Datto) sees them (read only) */
export function ClientDevicesTab({ clientId }: { clientId: string }) {
  const { t } = useTranslation();
  const { data, isLoading } = useClientDevices(clientId);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (data?.devices ?? []).filter(
      (d) =>
        (filter === "all" || (filter === "online" ? d.online : filter === "offline" ? !d.online : stale(d) || d.rebootRequired || patchLate(d))) &&
        words.every((w) => `${d.hostname} ${d.description} ${d.lastUser} ${d.os} ${d.ip} ${d.kind} ${d.category}`.toLowerCase().includes(w)),
    );
  }, [data, q, filter]);
  if (isLoading || !data) return <Loader2 className="mx-auto my-10 size-5 animate-spin text-muted-foreground" />;
  const all = data.devices;
  const tiles: [Filter, string, number, string][] = [
    ["all", "all", all.length, ""],
    ["online", "online", all.filter((d) => d.online).length, "text-emerald-300"],
    ["offline", "offline", all.filter((d) => !d.online).length, "text-muted-foreground"],
    ["attention", "attention", all.filter((d) => stale(d) || d.rebootRequired || patchLate(d)).length, "text-amber-300"],
  ];
  if (all.length === 0)
    return <p className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">{t(data.connected ? "devices.none" : "devices.notConnected")}</p>;
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-4">
        {tiles.map(([key, label, n, tone]) => (
          <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)} className={cn("rounded-xl border bg-background/40 px-3 py-2.5 text-left transition-colors hover:bg-accent/40", filter === key && "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/[0.06]")}>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{t(`devices.tile.${label}`)}</p>
            <p className={cn("font-mono text-xl font-semibold", tone)}>{n}</p>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("devices.search")} className="pl-8" />
        </div>
        {data.syncedAt && <span className="text-xs text-muted-foreground">{t("devices.syncedAt", { when: relativeTime(data.syncedAt) })}</span>}
      </div>
      <ul className="divide-y divide-border/50 overflow-hidden rounded-xl border">
        {list.length === 0 && <li className="p-8 text-center text-sm text-muted-foreground">{t("devices.noMatch")}</li>}
        {list.map((d) => {
          const Icon = isServer(d) ? Server : /laptop|notebook/i.test(`${d.category} ${d.kind}`) ? Laptop : MonitorSmartphone;
          return (
            <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
              <span className="flex min-w-48 flex-1 items-center gap-3">
                <span className="relative">
                  <Icon className="size-5 text-muted-foreground" />
                  <span className={cn("absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background", d.online ? "bg-emerald-400" : "bg-muted-foreground/60")} title={t(d.online ? "devices.online" : "devices.offline")} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium">{d.hostname || d.uid}</span>
                  <span className="block truncate text-xs text-muted-foreground">{[d.description, d.lastUser && t("devices.user", { name: d.lastUser })].filter(Boolean).join(" · ") || "—"}</span>
                </span>
              </span>
              <span className="w-56 min-w-0 text-xs text-muted-foreground">
                <span className="block truncate">{d.os || "—"}</span>
                <span className="block truncate font-mono">{d.ip || ""}</span>
              </span>
              <span className="w-36 text-xs text-muted-foreground">{d.online ? t("devices.online") : d.lastSeen ? t("devices.lastSeen", { when: relativeTime(d.lastSeen) }) : t("devices.neverSeen")}</span>
              <span className="flex w-52 flex-wrap items-center gap-1">
                {d.rebootRequired && <Badge variant="outline" className="border-amber-500/40 text-amber-300">{t("devices.reboot")}</Badge>}
                {patchLate(d) && (
                  <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-300">
                    <AlertTriangle className="size-3" /> {d.patchesPending > 0 ? t("devices.patches", { count: d.patchesPending }) : d.patchStatus}
                  </Badge>
                )}
                {stale(d) && <Badge variant="outline" className="border-destructive/40 text-red-300">{t("devices.stale")}</Badge>}
              </span>
              <span className="flex items-center gap-1">
                {d.remoteUrl && (
                  <Button asChild size="sm" variant="outline" className="h-8 gap-1">
                    <a href={d.remoteUrl} target="_blank" rel="noopener noreferrer">
                      <MonitorPlay className="size-3.5" /> {t("devices.remote")}
                    </a>
                  </Button>
                )}
                {d.portalUrl && (
                  <Button asChild size="sm" variant="ghost" className="h-8 gap-1">
                    <a href={d.portalUrl} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="size-3.5" /> {t("devices.open")}
                    </a>
                  </Button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
