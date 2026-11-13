import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Building2, Check, Eye, Loader2, Search, Wrench } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
 * Searchable list of the clients to view the portal as. Rendered outside the
 * dropdown (it stays open when the menu closes). The server then answers as
 * that client (read only) until switched back.
 */
export function ViewClientPicker({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const [q, setQ] = useState("");
  const { busy, run } = useSwitch();
  const { data: clients, isLoading } = useQuery({
    queryKey: ["view-as-clients"],
    queryFn: () => api.get<ClientRow[]>("/view-as/clients"),
    enabled: open,
  });
  const list = (clients ?? []).filter((c) => `${c.name} ${c.code ?? ""}`.toLowerCase().includes(q.toLowerCase()));

  const choose = (id: string) => {
    onOpenChange(false);
    void run(() => api.post("/view-as", { clientId: id }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 p-0">
        <DialogHeader className="border-b p-4 text-left">
          <DialogTitle>{t("viewAs.pickTitle")}</DialogTitle>
          <DialogDescription>{t("viewAs.pickText")}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b px-4">
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
                disabled={busy}
                onClick={() => choose(c.id)}
                className={cn("flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-accent")}
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
      </DialogContent>
    </Dialog>
  );
}

/**
 * The technician / client choice, as entries of a dropdown menu. Choosing
 * "Client" calls onPickClient (the caller opens ViewClientPicker); choosing
 * "Technicien" while viewing as a client gets back to the technician view.
 * Render it inside a DropdownMenuContent.
 */
export function ViewMenuItems({ onPickClient }: { onPickClient: () => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const inClientView = Boolean(me.viewAs);
  const { busy, run } = useSwitch();
  return (
    <>
      <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t("viewAs.menuTitle")}</DropdownMenuLabel>
      <DropdownMenuItem disabled={busy} onSelect={() => inClientView && void run(() => api.del("/view-as"))}>
        <Wrench className="size-4" /> {t("viewAs.staff")}
        {!inClientView && <Check className="ml-auto size-4 text-primary" />}
      </DropdownMenuItem>
      <DropdownMenuItem disabled={busy} onSelect={onPickClient}>
        <Eye className="size-4" /> {inClientView ? me.viewAs!.clientName : t("viewAs.pickMenu")}
        {inClientView && <Check className="ml-auto size-4 text-primary" />}
      </DropdownMenuItem>
    </>
  );
}

/**
 * Client view only: a button in the client top bar (shown while viewing as a
 * client) that opens the same technician / client choice.
 */
export function ViewSwitchButton() {
  const { t } = useTranslation();
  const [pickOpen, setPickOpen] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-full border border-[color:var(--glass-border)] px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground data-[state=open]:text-foreground"
          >
            <Eye className="size-3.5" /> {t("viewAs.switchView")}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="glass-strong w-64">
          <ViewMenuItems onPickClient={() => setPickOpen(true)} />
        </DropdownMenuContent>
      </DropdownMenu>
      <ViewClientPicker open={pickOpen} onOpenChange={setPickOpen} />
    </>
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
