import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Building2, Check, Eye, Loader2, Search, Wrench } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { useMe } from "@/lib/session";
import { cn } from "@/lib/utils";

type ClientRow = { id: string; name: string; code: string | null };

/** Re-render the whole app as the new identity (staff ↔ client view). */
function useSwitch() {
  const qc = useQueryClient();
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "auth" });
      await qc.invalidateQueries({ queryKey: ["auth"] });
      window.history.replaceState(null, "", "/");
    } catch {
      toast.error(t("common.error"));
    } finally {
      setBusy(false);
    }
  }
  return { busy, run };
}

/**
 * Technician / Client view toggle. Choosing "Client" opens a searchable list;
 * the server then answers as that client (read only) until switched back.
 * Shown only to technicians holding clientview.use (or while viewing as a client).
 */
export function ViewSwitcher({ className }: { className?: string }) {
  const { t } = useTranslation();
  const me = useMe();
  const inClientView = Boolean(me.viewAs);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const { busy, run } = useSwitch();
  const { data: clients, isLoading } = useQuery({
    queryKey: ["view-as-clients"],
    queryFn: () => api.get<ClientRow[]>("/view-as/clients"),
    enabled: open,
  });
  const list = (clients ?? []).filter((c) => `${c.name} ${c.code ?? ""}`.toLowerCase().includes(q.toLowerCase()));

  const choose = (id: string) => {
    setOpen(false);
    void run(() => api.post("/view-as", { clientId: id }));
  };
  const backToStaff = () => void run(() => api.del("/view-as"));

  return (
    <div className={cn("relative flex items-center rounded-full border bg-card/60 p-0.5 text-xs font-semibold backdrop-blur", className)}>
      <button
        type="button"
        onClick={() => inClientView && backToStaff()}
        disabled={busy}
        className={cn(
          "relative z-10 flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors",
          !inClientView ? "text-[#1a1204]" : "text-muted-foreground hover:text-foreground",
        )}
        aria-pressed={!inClientView}
      >
        {!inClientView && <motion.span layoutId="view-pill" className="absolute inset-0 -z-10 rounded-full bg-grad-gold" />}
        <Wrench className="size-3.5" /> {t("viewAs.staff")}
      </button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={busy}
            className={cn(
              "relative z-10 flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors",
              inClientView ? "text-[#1a1204]" : "text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={inClientView}
          >
            {inClientView && <motion.span layoutId="view-pill" className="absolute inset-0 -z-10 rounded-full bg-grad-gold" />}
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Eye className="size-3.5" />}
            <span className="max-w-40 truncate">{inClientView ? me.viewAs!.clientName : t("viewAs.client")}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-0">
          <div className="border-b p-3">
            <p className="text-sm font-semibold">{t("viewAs.pickTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("viewAs.pickText")}</p>
          </div>
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="size-4 text-muted-foreground" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("common.search")}
              className="h-10 flex-1 bg-transparent text-sm outline-none"
            />
          </div>
          <ul className="max-h-72 overflow-y-auto p-1 scrollbar-thin">
            {isLoading && (
              <li className="flex justify-center p-4">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </li>
            )}
            {list.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => choose(c.id)}
                  className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-accent"
                >
                  <span className="flex size-8 items-center justify-center rounded-md bg-muted font-mono text-[10px] font-semibold">
                    {c.code?.slice(0, 4) || <Building2 className="size-4" />}
                  </span>
                  <span className="flex-1 truncate">{c.name}</span>
                  {me.viewAs?.clientId === c.id && <Check className="size-4 text-primary" />}
                </button>
              </li>
            ))}
            {!isLoading && !list.length && <li className="p-4 text-center text-xs text-muted-foreground">{t("viewAs.none")}</li>}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Gold bar shown across the client view while a technician is viewing as a client. */
export function ViewAsBanner() {
  const { t } = useTranslation();
  const me = useMe();
  const { busy, run } = useSwitch();
  if (!me.viewAs) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 bg-grad-gold px-4 py-2 text-sm text-[#1a1204]">
      <span className="flex items-center gap-2 font-medium">
        <Eye className="size-4" />
        {t("viewAs.banner", { client: me.viewAs.clientName })}
        <span className="rounded bg-black/10 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide">{t("viewAs.readOnly")}</span>
      </span>
      <span className="hidden text-xs opacity-75 sm:inline">{t("viewAs.as", { name: me.realUser?.name ?? "" })}</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void run(() => api.del("/view-as"))}
        className="flex items-center gap-1.5 rounded-full bg-[#1a1204] px-3 py-1 text-xs font-semibold text-[#ffce1a] transition-opacity hover:opacity-90"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Wrench className="size-3.5" />} {t("viewAs.back")}
      </button>
    </div>
  );
}
