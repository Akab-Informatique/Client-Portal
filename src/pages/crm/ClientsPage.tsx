import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Building2, CornerDownRight, Loader2, Network, Phone, Plus, Search, Ticket, UsersRound } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { ticketErrorText } from "@/pages/tickets/shared";
import { crmErrorText, useCrmClients, type CrmClient, type CrmListItem } from "./shared";

type Filter = "active" | "inactive" | "parents";

/** CRM: every client, subsidiaries under their parent company. */
export function ClientsPage() {
  const { t } = useTranslation();
  const can = useCan();
  const { data: clients = [], isLoading } = useCrmClients();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("active");
  const [creating, setCreating] = useState(false);

  const rows = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = clients.filter((c) => {
      if (filter === "inactive" ? c.active : !c.active) return false;
      if (filter === "parents" && c.children === 0) return false;
      const hay = `${c.name} ${c.city ?? ""} ${c.phone ?? ""} ${c.code ?? ""} ${c.parentName ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    // no search: each subsidiary right under its parent company
    if (words.length || filter === "parents") return shown.map((c) => ({ c, depth: 0 }));
    const ids = new Set(shown.map((c) => c.id));
    const out: { c: CrmListItem; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const c of shown.filter((x) => (parent ? x.parentId === parent : !x.parentId || !ids.has(x.parentId)))) {
        out.push({ c, depth });
        walk(c.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [clients, q, filter]);

  const counts = { active: clients.filter((c) => c.active).length, inactive: clients.filter((c) => !c.active).length, parents: clients.filter((c) => c.active && c.children > 0).length };

  return (
    <div className="relative isolate space-y-5">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Building2 className="size-6 text-primary" /> {t("crm.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("crm.subtitle")}</p>
        </div>
        {can("crm.edit") && (
          <Button onClick={() => setCreating(true)} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
            <Plus className="size-4" /> {t("crm.new")}
          </Button>
        )}
      </div>

      <div className="glass flex flex-wrap items-center gap-2 rounded-2xl border p-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("crm.search")} className="h-9 rounded-xl border-[color:var(--glass-border)] bg-background/40 pl-9" />
        </div>
        <div className="flex gap-1">
          {(["active", "parents", "inactive"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                "flex h-9 items-center gap-1.5 rounded-xl border px-3 text-sm transition-colors",
                filter === f ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              {t(f === "active" ? "crm.all" : f === "parents" ? "crm.parents" : "crm.inactive")}
              <span className="font-mono text-[11px] text-muted-foreground">{counts[f]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="glass overflow-hidden rounded-2xl border">
        <div className="hidden grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_90px_110px] gap-3 border-b px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground md:grid">
          <span>{t("crm.col.client")}</span>
          <span>{t("crm.col.city")}</span>
          <span>{t("crm.col.phone")}</span>
          <span>{t("crm.col.billingEmail")}</span>
          <span className="text-right">{t("crm.col.contacts")}</span>
          <span className="text-right">{t("crm.col.tickets")}</span>
        </div>
        {isLoading && <Loader2 className="mx-auto my-10 size-5 animate-spin text-muted-foreground" />}
        {!isLoading && rows.length === 0 && <p className="py-12 text-center text-sm text-muted-foreground">{t("crm.none")}</p>}
        <ul className="divide-y divide-border/60">
          {rows.map(({ c, depth }) => (
            <li key={c.id}>
              <Link
                to={`/crm/${c.id}`}
                className="grid grid-cols-1 gap-x-3 gap-y-1 px-4 py-2.5 transition-colors hover:bg-accent/40 md:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_90px_110px] md:items-center"
              >
                <span className="flex min-w-0 items-center gap-2" style={{ paddingLeft: depth * 22 }}>
                  {depth > 0 ? <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" /> : <Building2 className="size-4 shrink-0 text-muted-foreground" />}
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{c.name}</span>
                    {c.parentName && depth === 0 ? <span className="block truncate text-[11px] text-muted-foreground">{t("crm.childOf", { name: c.parentName })}</span> : null}
                  </span>
                  {c.children > 0 && (
                    <span className="ml-1 flex shrink-0 items-center gap-1 rounded-full border border-[color:var(--gold)]/30 px-1.5 py-0.5 text-[10px] text-primary" title={t("crm.children", { count: c.children })}>
                      <Network className="size-3" /> {c.children}
                    </span>
                  )}
                </span>
                <span className="truncate text-sm text-muted-foreground">{[c.city, c.province].filter(Boolean).join(", ") || "—"}</span>
                <span className="flex items-center gap-1.5 truncate text-sm text-muted-foreground">
                  <Phone className="size-3.5 shrink-0 md:hidden" />
                  {c.phone || "—"}
                </span>
                <span className="truncate text-sm" title={c.billingEmail ?? c.email ?? undefined}>
                  {c.billingEmail ? (
                    <span className="text-muted-foreground">{c.billingEmail}</span>
                  ) : c.email ? (
                    <span className="italic text-muted-foreground/60">{c.email}</span>
                  ) : (
                    <span className="text-red-400">{t("crm.col.noBillingEmail")}</span>
                  )}
                </span>
                <span className="flex items-center gap-1 text-sm text-muted-foreground md:justify-end">
                  <UsersRound className="size-3.5 md:hidden" /> <span className="font-mono">{c.contacts}</span>
                </span>
                <span className="flex items-center gap-1 md:justify-end">
                  <Ticket className="size-3.5 text-muted-foreground md:hidden" />
                  <span className={cn("rounded-md px-1.5 font-mono text-sm", c.openTickets > 0 ? "bg-[color:var(--gold)]/10 text-primary" : "text-muted-foreground")}>{c.openTickets}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-xs text-muted-foreground">{t("crm.count", { count: rows.length })}</p>

      <NewClientDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function NewClientDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [f, setF] = useState({ name: "", phone: "" });
  const create = useMutation({
    mutationFn: () => api.post<CrmClient>("/crm/clients", f),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ["crm"] });
      void qc.invalidateQueries({ queryKey: ["tickets", "companies"] });
      toast.success(t("crm.created", { name: c.name }));
      onOpenChange(false);
      setF({ name: "", phone: "" });
      navigate(`/crm/${c.id}`);
    },
    onError: (e) => toast.error(crmErrorText(t, e) ?? ticketErrorText(t, e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="size-5 text-primary" /> {t("crm.new")}
          </DialogTitle>
          <DialogDescription>{t("crm.newText")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="crm-name">{t("crm.name")}</Label>
            <Input id="crm-name" required minLength={2} maxLength={100} autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="crm-phone">{t("crm.phone")}</Label>
            <Input id="crm-phone" type="tel" required minLength={7} maxLength={40} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={create.isPending} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
              {create.isPending && <Loader2 className="size-4 animate-spin" />} {t("crm.create")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
