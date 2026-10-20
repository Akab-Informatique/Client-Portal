import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ExternalLink, HardDrive, Laptop, Link2, Loader2, MonitorPlay, Plus, RefreshCw, Search, Server, ShieldAlert, Unlink, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AssetView, TicketDetail } from "./shared";

const iconOf = (a: Pick<AssetView, "type" | "name">) => (/serv/i.test(`${a.type} ${a.name}`) ? Server : /port|lap|note/i.test(`${a.type} ${a.name}`) ? Laptop : HardDrive);

/** Where a device comes from: the RMM sync, or made in the portal. */
export function OriginBadge({ origin }: { origin: AssetView["origin"] }) {
  const { t } = useTranslation();
  const local = origin === "local";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium",
        local ? "border-violet-400/40 bg-violet-500/10 text-violet-300" : "border-emerald-400/40 bg-emerald-500/10 text-emerald-300",
      )}
    >
      {local ? <HardDrive className="size-2.5" /> : <RefreshCw className="size-2.5" />} {local ? t("tickets.asset.originLocal") : t("tickets.asset.originRmm")}
    </span>
  );
}

/** Makes a device in the portal (the RMM does not know it) and links it to the ticket. */
export function NewAssetDialog({ tk, open, onOpenChange, onCreated }: { tk: TicketDetail; open: boolean; onOpenChange: (v: boolean) => void; onCreated: (a: AssetView) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const empty = {
    name: "",
    type: "",
    hostname: "",
    serial: "",
    ip: "",
    os: "",
  };
  const [f, setF] = useState(empty);
  const create = useMutation({
    mutationFn: () =>
      api.post<AssetView>(`/tickets/companies/${tk.company.id}/assets`, {
        ...f,
        contactId: tk.contactId,
        contactName: tk.contact || null,
      }),
    onSuccess: (a) => {
      void qc.invalidateQueries({
        queryKey: ["tickets", "assets", tk.company.id],
      });
      setF(empty);
      onOpenChange(false);
      onCreated(a);
      toast.success(t("tickets.asset.created"));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("common.error")),
  });
  const field = (k: keyof typeof empty, label: string, ph?: string) => (
    <label className="block space-y-1 text-xs text-muted-foreground">
      {label}
      <Input value={f[k]} maxLength={120} placeholder={ph} onChange={(e) => setF({ ...f, [k]: e.target.value })} className="text-foreground" />
    </label>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("tickets.asset.newTitle")}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">{t("tickets.asset.newHint", { company: tk.company.name })}</p>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (f.name.trim()) create.mutate();
          }}
        >
          {field("name", t("tickets.asset.name"), "PC-COMPTA-01")}
          <div className="grid grid-cols-2 gap-3">
            {field("type", t("tickets.asset.type"), t("tickets.asset.typePh"))}
            {field("hostname", t("tickets.asset.hostname"))}
            {field("serial", t("tickets.asset.serial"))}
            {field("ip", t("tickets.asset.ip"))}
          </div>
          {field("os", t("tickets.asset.os"))}
          <Button type="submit" className="w-full" disabled={!f.name.trim() || create.isPending}>
            {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} {t("tickets.asset.create")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function useAssets(companyId: number, enabled = true) {
  return useQuery({
    queryKey: ["tickets", "assets", companyId],
    queryFn: () => api.get<AssetView[]>(`/tickets/companies/${companyId}/assets`),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/**
 * The ticket's device (Autotask configuration item): who uses it, its RMM
 * details, and the RMM links (device page, web remote control) in a new tab.
 * The picker shows the contact's devices first.
 */
export function AssetContent({ tk, editable, partial, onPick }: { tk: TicketDetail; editable: boolean; partial: boolean; onPick: (assetId: string | null) => void }) {
  const { t } = useTranslation();
  const asset = tk.asset ?? null;
  // Without a device yet: the contact's devices are suggested
  const { data: list, isLoading } = useAssets(tk.company.id, !partial && !asset && Boolean(tk.contactId));
  const suggested = (list ?? []).filter((a) => a.contactId === tk.contactId).slice(0, 3);
  const [creating, setCreating] = useState(false);

  return (
    <div className="text-sm">
      {partial ? (
        <Skeleton className="h-16" />
      ) : asset ? (
        <AssetDetails a={asset} ticketContactId={tk.contactId} />
      ) : (
        <div className="space-y-2">
          <p className="text-muted-foreground">{t("tickets.asset.none")}</p>
          {isLoading && tk.contactId && <Skeleton className="h-8" />}
          {editable &&
            suggested.map((a) => {
              const Icon = iconOf(a);
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => onPick(a.id)}
                  className="flex w-full items-center gap-2 rounded-xl border border-dashed border-[color:var(--gold)]/30 px-3 py-2 text-left transition hover:border-[color:var(--gold)]/60 hover:bg-[color:var(--gold)]/5"
                >
                  <Icon className="size-4 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{a.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {t("tickets.asset.ofContact", {
                        name: a.contactName ?? tk.contact,
                      })}
                    </span>
                  </span>
                  <Link2 className="size-3.5 text-primary" />
                </button>
              );
            })}
          {editable && (
            <Button type="button" variant="outline" size="sm" className="w-full border-dashed" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" /> {t("tickets.asset.createLocal")}
            </Button>
          )}
        </div>
      )}
      <NewAssetDialog tk={tk} open={creating} onOpenChange={setCreating} onCreated={(a) => onPick(a.id)} />
    </div>
  );
}

function AssetDetails({ a, ticketContactId }: { a: AssetView; ticketContactId: string | null }) {
  const { t } = useTranslation();
  const Icon = iconOf(a);
  const warrantyOver = a.warrantyEnd ? new Date(a.warrantyEnd).getTime() < Date.now() : false;
  const rows: [string, string | null][] = [
    [t("tickets.asset.hostname"), a.hostname],
    [t("tickets.asset.ip"), a.ip],
    [t("tickets.asset.os"), a.os],
    [t("tickets.asset.lastUser"), a.lastUser],
    [t("tickets.asset.serial"), a.serial],
  ];
  const hasRmmId = Boolean(a.rmm.uid || a.rmm.id);
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <span className="hex flex size-10 shrink-0 items-center justify-center bg-[color:var(--gold)]/15 text-primary">
          <Icon className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-semibold">
            <span className="truncate">{a.name}</span> <OriginBadge origin={a.origin} />
          </p>
          <p className="truncate text-xs text-muted-foreground">{[a.type, a.lastSeen && t("tickets.asset.seen", { when: relativeTime(a.lastSeen) })].filter(Boolean).join(" · ")}</p>
        </div>
      </div>

      <p className="flex items-center gap-2 text-xs">
        <UserRound className="size-3.5 text-muted-foreground" />
        {a.contactName ? (
          <span>
            {a.contactName}
            {a.contactId && a.contactId !== ticketContactId && <span className="ml-1 text-orange-300">({t("tickets.asset.otherContact")})</span>}
          </span>
        ) : (
          <span className="text-muted-foreground">{t("tickets.asset.noContact")}</span>
        )}
      </p>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="truncate font-mono text-[11px]" title={v!}>
                {v}
              </dd>
            </div>
          ))}
        {a.warrantyEnd && (
          <div className="contents">
            <dt className="text-muted-foreground">{t("tickets.asset.warranty")}</dt>
            <dd className={cn("flex items-center gap-1", warrantyOver && "text-destructive")}>
              {warrantyOver && <ShieldAlert className="size-3" />}
              {new Date(a.warrantyEnd).toLocaleDateString()}
            </dd>
          </div>
        )}
      </dl>

      {(a.links.remote || a.links.device) && (
        <div className="flex flex-wrap gap-2 pt-1">
          {a.links.remote && (
            <Button asChild size="sm" className="bg-grad-gold font-semibold text-[#1a1204] glow-gold hover:brightness-105">
              <a href={a.links.remote} target="_blank" rel="noopener noreferrer">
                <MonitorPlay className="size-4" /> {t("tickets.asset.remote")}
              </a>
            </Button>
          )}
          {a.links.device && (
            <Button asChild size="sm" variant="outline">
              <a href={a.links.device} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-3.5" /> {a.links.rmm ? t("tickets.asset.openIn", { name: a.links.rmm }) : t("tickets.asset.openRmm")}
              </a>
            </Button>
          )}
        </div>
      )}
      {!a.links.remote && !a.links.device && hasRmmId && <p className="text-[11px] text-muted-foreground">{t("tickets.asset.rmmNotSet")}</p>}
    </div>
  );
}

export function AssetPicker({ tk, onPick }: { tk: TicketDetail; onPick: (assetId: string | null) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const { data: list, isLoading } = useAssets(tk.company.id, open);
  const groups = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (a: AssetView) => words.every((w) => `${a.name} ${a.type ?? ""} ${a.hostname ?? ""} ${a.serial ?? ""} ${a.contactName ?? ""}`.toLowerCase().includes(w));
    const all = (list ?? []).filter(hit);
    return {
      contact: all.filter((a) => tk.contactId && a.contactId === tk.contactId),
      others: all.filter((a) => !tk.contactId || a.contactId !== tk.contactId),
    };
  }, [list, q, tk.contactId]);

  const item = (a: AssetView) => {
    const Icon = iconOf(a);
    const on = a.id === tk.assetId;
    return (
      <button
        key={a.id}
        type="button"
        onClick={() => {
          setOpen(false);
          if (!on) onPick(a.id);
        }}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent"
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate">{a.name}</span> <OriginBadge origin={a.origin} />
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">{[a.type, a.hostname !== a.name && a.hostname, a.contactName].filter(Boolean).join(" · ")}</span>
        </span>
        {on && <Check className="size-4 text-primary" />}
      </button>
    );
  };

  return (
    <>
      <NewAssetDialog tk={tk} open={creating} onOpenChange={setCreating} onCreated={(a) => onPick(a.id)} />
      <Popover open={open} onOpenChange={setOpen} modal>
        <PopoverTrigger asChild>
          <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            {tk.asset ? t("tickets.asset.change") : t("tickets.asset.link")} <ChevronDown className="size-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 p-2">
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("tickets.asset.search")}
              className="h-8 w-full rounded-md border bg-transparent pl-8 pr-2 text-sm outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40"
            />
          </div>
          <div className="max-h-72 overflow-y-auto">
            {isLoading && <Skeleton className="h-24" />}
            {groups.contact.length > 0 && (
              <>
                <p className="px-2 pb-1 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground">{t("tickets.asset.contactDevices", { name: tk.contact })}</p>
                {groups.contact.map(item)}
              </>
            )}
            {groups.others.length > 0 && (
              <>
                <p className="px-2 pb-1 pt-2 text-[10px] uppercase tracking-wide text-muted-foreground">{t("tickets.asset.companyDevices", { name: tk.company.name })}</p>
                {groups.others.map(item)}
              </>
            )}
            {list && !groups.contact.length && !groups.others.length && <p className="px-2 py-4 text-center text-sm text-muted-foreground">{t("tickets.asset.empty")}</p>}
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setCreating(true);
            }}
            className="mt-1 flex w-full items-center gap-2 border-t px-2 pt-2 text-xs text-primary hover:underline"
          >
            <Plus className="size-3.5" /> {t("tickets.asset.createLocal")}
          </button>
          {tk.asset && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onPick(null);
              }}
              className="mt-1 flex w-full items-center gap-2 border-t px-2 pt-2 text-xs text-muted-foreground hover:text-destructive"
            >
              <Unlink className="size-3.5" /> {t("tickets.asset.remove")}
            </button>
          )}
        </PopoverContent>
      </Popover>
    </>
  );
}
