import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Search, Trash2, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { useConfirm } from "@/components/ConfirmDialog";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";

/** The margin on the price, in percent: (price − cost) / price. */
const marginOf = (price: number, cost: number) => (price > 0 ? Math.round(((price - cost) / price) * 1000) / 10 : 0);
const toNum = (v: string) => {
  const n = Number(v.replace(",", "."));
  return v.trim() === "" || Number.isNaN(n) ? null : n;
};
const fmt = (n: number) => String(Math.round(n * 100) / 100);

type Service = { id: string; name: string; description: string; kind: "one_time" | "recurring" | "recurring_yearly"; priceCents: number; costCents: number; taxable: boolean; active: boolean; sku?: string | null; vendorName?: string | null };
const KEY = ["services"];

/** Services, under Inventory: what the company sells besides products (one time or monthly). */
export function ServicesPage() {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const manage = can("services.manage");
  const { data = [], isLoading } = useQuery({ queryKey: KEY, queryFn: () => api.get<Service[]>("/services") });
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Service | "new" | null>(null);
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return data.filter((s) => words.every((w) => `${s.name} ${s.description}`.toLowerCase().includes(w)));
  }, [data, q]);
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/services/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
    onError: () => toast.error(t("common.error")),
  });
  const toggle = useMutation({
    mutationFn: (p: { id: string; active: boolean }) => api.patch(`/services/${p.id}`, { active: p.active }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
    onError: () => toast.error(t("common.error")),
  });
  return (
    <div className="relative isolate space-y-5">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Wrench className="size-6 text-primary" /> {t("services.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("services.subtitle")}</p>
        </div>
        {manage && (
          <Button onClick={() => setEditing("new")} className="bg-grad-gold font-semibold text-[#1a1204]">
            <Plus className="size-4" /> {t("services.new")}
          </Button>
        )}
      </div>
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("services.search")} className="pl-9" />
      </div>
      {isLoading && <Loader2 className="mx-auto my-10 size-5 animate-spin text-muted-foreground" />}
      {!isLoading && list.length === 0 && <p className="glass rounded-2xl border border-dashed py-12 text-center text-sm text-muted-foreground">{t("services.none")}</p>}
      {list.length > 0 && (
        <ul className="glass divide-y divide-border/60 overflow-hidden rounded-2xl border">
          {list.map((s) => (
            <li key={s.id} className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3", !s.active && "opacity-60")}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{s.name}</span>
                {s.description && <span className="block truncate text-xs text-muted-foreground">{s.description}</span>}
                {(s.sku || s.vendorName) && (
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {s.sku}
                    {s.vendorName ? ` · ${s.vendorName}` : ""}
                  </span>
                )}
              </span>
              <span className="rounded-md border px-2 py-0.5 text-[11px] text-muted-foreground">{t(`services.kind.${s.kind}`)}</span>
              <span className="w-32 text-right font-mono text-sm">
                {money(s.priceCents, i18n.language)}
                {s.kind === "recurring" && <span className="text-[10px] text-muted-foreground">{t("services.perMonth")}</span>}
                {s.kind === "recurring_yearly" && <span className="text-[10px] text-muted-foreground">{t("services.perYear")}</span>}
                <span className="block text-[10px] font-sans text-muted-foreground">
                  {t("services.costShort")} {money(s.costCents, i18n.language)}
                  {s.priceCents > 0 && <span className={cn("ml-1.5", s.costCents > s.priceCents ? "text-destructive" : "text-emerald-300")}>{marginOf(s.priceCents / 100, s.costCents / 100)} %</span>}
                </span>
              </span>
              {manage && (
                <>
                  <Switch checked={s.active} onCheckedChange={(v) => toggle.mutate({ id: s.id, active: v })} aria-label={t("services.active")} />
                  <Button size="icon" variant="ghost" className="size-8" onClick={() => setEditing(s)} aria-label={t("common.edit")}>
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8 text-muted-foreground hover:text-destructive"
                    onClick={() => void confirm({ title: t("services.deleteTitle", { name: s.name }), description: t("services.deleteText"), confirmLabel: t("services.delete"), destructive: true }).then((ok) => ok && remove.mutate(s.id))}
                    aria-label={t("services.delete")}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <ServiceDialog service={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ServiceDialog({ service, onClose }: { service: Service | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: service?.name ?? "",
    description: service?.description ?? "",
    // a new service is recurring (monthly) unless said otherwise
    kind: service?.kind ?? ("recurring" as Service["kind"]),
    price: service ? String(service.priceCents / 100) : "",
    cost: service ? String(service.costCents / 100) : "",
    margin: service && service.priceCents > 0 ? fmt(marginOf(service.priceCents / 100, service.costCents / 100)) : "",
    taxable: service?.taxable ?? true,
  });
  // cost, price and margin (on the price) fill each other: with two of them, the third follows
  const setCost = (v: string) => {
    const next = { ...f, cost: v };
    const c = toNum(v);
    const p = toNum(f.price);
    const m = toNum(f.margin);
    if (c !== null && p !== null && p > 0) next.margin = fmt(marginOf(p, c));
    else if (c !== null && m !== null && m < 100) next.price = fmt(c / (1 - m / 100));
    setF(next);
  };
  const setPrice = (v: string) => {
    const next = { ...f, price: v };
    const p = toNum(v);
    const c = toNum(f.cost);
    const m = toNum(f.margin);
    if (p !== null && p > 0 && c !== null) next.margin = fmt(marginOf(p, c));
    else if (p !== null && m !== null && m < 100) next.cost = fmt(p * (1 - m / 100));
    setF(next);
  };
  const setMargin = (v: string) => {
    const next = { ...f, margin: v };
    const m = toNum(v);
    const c = toNum(f.cost);
    const p = toNum(f.price);
    if (m !== null && m < 100) {
      if (c !== null) next.price = fmt(c / (1 - m / 100));
      else if (p !== null) next.cost = fmt(p * (1 - m / 100));
    }
    setF(next);
  };
  const cents = (v: string) => Math.round((Number(v.replace(",", ".")) || 0) * 100);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.name.trim(), description: f.description.trim(), kind: f.kind, priceCents: cents(f.price), costCents: cents(f.cost), taxable: f.taxable };
      return service ? api.patch(`/services/${service.id}`, body) : api.post("/services", body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      toast.success(t("services.saved"));
      onClose();
    },
    onError: () => toast.error(t("common.error")),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{service ? t("services.edit") : t("services.new")}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (f.name.trim()) save.mutate();
          }}
        >
          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">{t("services.name")}</span>
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={200} autoFocus />
          </label>
          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">{t("services.description")}</span>
            <Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} rows={3} maxLength={4000} />
          </label>
          <label className="block space-y-1 text-xs">
            <span className="text-muted-foreground">{t("services.kindLabel")}</span>
            <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Service["kind"] })} className="h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40">
              <option value="recurring">{t("services.kind.recurring")}</option>
              <option value="recurring_yearly">{t("services.kind.recurring_yearly")}</option>
              <option value="one_time">{t("services.kind.one_time")}</option>
            </select>
          </label>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">{t("services.cost")}</span>
              <Input value={f.cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" placeholder="0" />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">{t("services.price")}</span>
              <Input value={f.price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="0" />
            </label>
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">{t("services.margin")}</span>
              <Input value={f.margin} onChange={(e) => setMargin(e.target.value)} inputMode="decimal" placeholder="0" />
            </label>
          </div>
          <p className="text-[11px] text-muted-foreground">{t("services.marginHint")}</p>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={f.taxable} onCheckedChange={(v) => setF({ ...f, taxable: v })} /> {t("services.taxable")}
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending || !f.name.trim()} className="bg-grad-gold font-semibold text-[#1a1204]">
              {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("services.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
