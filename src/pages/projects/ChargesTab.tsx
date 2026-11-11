import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRightLeft, Boxes, Loader2, Plus, Search, Trash2, X } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { MoveChargeDialog } from "@/components/MoveChargeDialog";
import { RebateInput, afterRebate, percentOf } from "@/components/RebateInput";
import { AiTextarea } from "@/components/AiPolish";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, ApiError } from "@/lib/api";
import { currentLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { shortDate } from "@/pages/tickets/shared";
import { Card } from "./ui";
import { KEY, type ProjectDetail } from "./shared";

type ProjectCharge = {
  id: string;
  name: string;
  description: string;
  quantity: number;
  unitPrice: number | null;
  rebate: number;
  unitCost: number | null;
  billable: boolean;
  date: string | null;
  author: string | null;
  billing: string | null;
  movable: boolean;
};
type StoreProduct = { id: string; name: string; description: string; sku: string | null; unitPrice: number; unitCost: number; total: number };

const money = (n: number) => new Intl.NumberFormat(currentLocale() === "en" ? "en-CA" : "fr-CA", { style: "currency", currency: "CAD" }).format(n);
const num = (s: string) => (s.trim() === "" ? null : Number(s.replace(/\s/g, "").replace(",", ".")));
const lineTotal = (c: ProjectCharge) => c.quantity * (c.unitPrice === null ? 0 : afterRebate(c.unitPrice, c.rebate));
const BILLING_STYLE: Record<string, string> = { pending: "border-amber-400/40 text-amber-300", approved: "border-emerald-400/40 text-emerald-300", excluded: "border-muted-foreground/40 text-muted-foreground", posted: "border-sky-400/40 text-sky-300" };

/** The charges of a project: what was put on it (by hand, or moved from a ticket), where each stands in billing, and a way to add one. */
export function ChargesTab({ p, edit }: { p: ProjectDetail; edit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [moving, setMoving] = useState<{ id: string; name: string } | null>(null);
  const key = [...KEY, "charges", p.id];
  const { data: charges = [], isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<ProjectCharge[]>(`/projects/${p.id}/charges`) });
  const remove = useMutation({
    mutationFn: (id: string) => api.del<ProjectCharge[]>(`/projects/${p.id}/charges/${id}`),
    onSuccess: (next) => qc.setQueryData(key, next),
    onError: (e) => toast.error(errorText(t, e)),
  });
  const total = charges.filter((c) => c.billable).reduce((n, c) => n + lineTotal(c), 0);
  return (
    <div className="space-y-4">
      <Card title={t("projects.charges.title")}>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">{t("projects.charges.hint")}</p>
          <span className="ml-auto font-mono text-sm">
            {t("projects.charges.total")} : <span className="font-semibold text-foreground">{money(total)}</span>
          </span>
          {edit && (
            <Button size="sm" className="gap-1.5" onClick={() => setAdding(true)}>
              <Plus className="size-4" /> {t("projects.charges.add")}
            </Button>
          )}
        </div>
        {isLoading ? (
          <Loader2 className="mx-auto my-6 size-5 animate-spin text-muted-foreground" />
        ) : charges.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">{t("projects.charges.none")}</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {charges.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{c.name}</span>
                  {c.description && <span className="block truncate text-xs text-muted-foreground">{c.description}</span>}
                  <span className="block text-[11px] text-muted-foreground">
                    {[c.date ? shortDate(c.date) : null, c.author].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {c.quantity.toLocaleString()} × {c.unitPrice != null ? money(c.unitPrice) : "—"}
                  {c.rebate > 0 && <span className="ml-1 text-emerald-300">−{c.rebate} %</span>}
                </span>
                <span className="w-24 text-right font-mono">{c.billable ? money(lineTotal(c)) : <span className="text-muted-foreground">{t("projects.charges.notBilled")}</span>}</span>
                {c.billable && c.billing && <span className={cn("rounded-full border px-2 py-0.5 text-[10px]", BILLING_STYLE[c.billing] ?? "text-muted-foreground")}>{t(`projects.charges.billing.${c.billing}`)}</span>}
                {edit && c.movable ? (
                  <span className="flex items-center gap-1">
                    <button type="button" onClick={() => setMoving({ id: c.id, name: c.name })} title={t("chargeMove.button")} aria-label={t("chargeMove.button")} className="rounded p-1 text-muted-foreground hover:text-primary">
                      <ArrowRightLeft className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void confirm({ title: t("projects.charges.removeTitle"), description: t("projects.charges.removeText"), confirmLabel: t("common.delete"), destructive: true }).then((ok) => ok && remove.mutate(c.id))}
                      title={t("common.delete")}
                      aria-label={t("common.delete")}
                      className="rounded p-1 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </span>
                ) : (
                  <span className="text-[10px] text-muted-foreground">{t("chargeMove.locked")}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {adding && <AddCharge p={p} onClose={() => setAdding(false)} onAdded={(next) => qc.setQueryData(key, next)} />}
      {moving && <MoveChargeDialog name={moving.name} path={`/projects/${p.id}/charges/${moving.id}/move`} exclude={{ projectId: p.id }} onClose={() => setMoving(null)} onMoved={() => void qc.invalidateQueries({ queryKey: key })} />}
    </div>
  );
}

function errorText(t: (k: string) => string, e: unknown) {
  if (e instanceof ApiError && ["project_closed", "project_needs_client", "charge_billed"].includes(e.code)) return t(`projects.charges.errors.${e.code}`);
  return t("common.error");
}

/** A charge typed on the spot, or an inventory item (its name and prices fill the form; no stock is taken). */
function AddCharge({ p, onClose, onAdded }: { p: ProjectDetail; onClose: () => void; onAdded: (next: ProjectCharge[]) => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"inventory" | "oneTime">("oneTime");
  const [product, setProduct] = useState<StoreProduct | null>(null);
  const [f, setF] = useState({ name: "", quantity: "1", unitPrice: "", rebate: "", unitCost: "", billable: true, description: "", date: new Date().toLocaleDateString("en-CA") });
  const set = (k: keyof typeof f) => (v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const choose = (x: StoreProduct) => {
    setProduct(x);
    setF((old) => ({ ...old, name: x.name, unitPrice: String(x.unitPrice), unitCost: String(x.unitCost), description: x.description.slice(0, 2000) }));
  };
  const qty = num(f.quantity);
  const price = num(f.unitPrice);
  const valid = f.name.trim().length > 0 && qty !== null && qty > 0 && (price === null || price >= 0);
  const save = useMutation({
    mutationFn: () =>
      api.post<ProjectCharge[]>(`/projects/${p.id}/charges`, {
        name: f.name.trim().slice(0, 100),
        description: f.description.trim(),
        quantity: qty,
        unitPrice: price,
        rebate: percentOf(f.rebate),
        unitCost: num(f.unitCost),
        billable: f.billable,
        date: f.date || null,
      }),
    onSuccess: (next) => {
      onAdded(next);
      toast.success(t("projects.charges.added"));
      onClose();
    },
    onError: (e) => toast.error(errorText(t, e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("projects.charges.add")}</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-primary">{p.number}</span> · {p.name}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (valid && !save.isPending) save.mutate();
          }}
        >
          <div className="grid grid-cols-2 gap-1 rounded-lg border p-0.5 text-xs" role="tablist">
            {(["oneTime", "inventory"] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={cn("rounded-md px-2 py-1.5 font-medium", mode === m ? "bg-grad-gold text-[#1a1204]" : "text-muted-foreground hover:text-foreground")}>
                {t(`tickets.charges.mode.${m}`)}
              </button>
            ))}
          </div>
          {mode === "inventory" && !product && <ProductSearch onPick={choose} />}
          {mode === "inventory" && product && (
            <div className="flex items-center gap-3 rounded-xl border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/5 px-3 py-2 text-sm">
              <Boxes className="size-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate font-medium">{product.name}</span>
              <button type="button" onClick={() => setProduct(null)} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label={t("tickets.charges.unpick")}>
                <X className="size-4" />
              </button>
            </div>
          )}
          {(mode === "oneTime" || product) && (
            <>
              {mode === "oneTime" && (
                <div className="space-y-1.5">
                  <Label htmlFor="pc-name">{t("tickets.charges.oneTimeName")}</Label>
                  <Input id="pc-name" maxLength={100} value={f.name} onChange={(e) => set("name")(e.target.value)} placeholder={t("tickets.charges.oneTimePlaceholder")} autoFocus />
                </div>
              )}
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="pc-qty">{t("tickets.charges.quantity")}</Label>
                  <Input id="pc-qty" inputMode="decimal" value={f.quantity} onChange={(e) => set("quantity")(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pc-price">{t("tickets.charges.unitPrice")}</Label>
                  <Input id="pc-price" inputMode="decimal" value={f.unitPrice} onChange={(e) => set("unitPrice")(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pc-cost">{t("tickets.charges.unitCost")}</Label>
                  <Input id="pc-cost" inputMode="decimal" value={f.unitCost} onChange={(e) => set("unitCost")(e.target.value)} />
                </div>
              </div>
              <RebateInput id="pc-rebate" regular={price} percent={f.rebate} onPercent={(v) => set("rebate")(v)} unit="/ unité" />
              {qty !== null && price !== null && qty > 0 && (
                <p className="-mt-2 text-right text-xs text-muted-foreground">
                  {t("tickets.charges.lineTotal")} : <span className="font-mono text-foreground">{money(qty * afterRebate(price, percentOf(f.rebate)))}</span>
                </p>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="pc-date">{t("tickets.charges.date")}</Label>
                <Input id="pc-date" type="date" value={f.date} onChange={(e) => set("date")(e.target.value)} className="w-44" />
              </div>
              <div className="space-y-1.5">
                <Label>{t("tickets.charges.description")}</Label>
                <AiTextarea rows={3} value={f.description} onChange={(e) => set("description")(e.target.value)} maxLength={2000} />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={f.billable} onCheckedChange={(v) => set("billable")(v)} /> {t("tickets.charges.billable")}
              </label>
              {mode === "inventory" && <p className="text-xs text-muted-foreground">{t("projects.charges.noStock")}</p>}
            </>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("projects.charges.add")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProductSearch({ onPick }: { onPick: (p: StoreProduct) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setQ(text.trim()), 200);
    return () => clearTimeout(id);
  }, [text]);
  const { data, isFetching } = useQuery({ queryKey: ["tickets", "store-products", q], queryFn: () => api.get<StoreProduct[]>(`/tickets/store-products?q=${encodeURIComponent(q)}`), placeholderData: keepPreviousData, staleTime: 30_000 });
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={t("tickets.charges.searchLocal")} className="pl-9" />
        {isFetching && <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
      </div>
      <ul className="max-h-56 overflow-y-auto rounded-xl border">
        {data?.length === 0 && <li className="px-3 py-3 text-center text-sm text-muted-foreground">{q ? t("tickets.charges.noLocal") : t("tickets.charges.emptyInventory")}</li>}
        {data?.map((x) => (
          <li key={x.id}>
            <button type="button" onClick={() => onPick(x)} className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent">
              <Boxes className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{x.name}</span>
                {x.sku && <span className="block truncate text-[11px] text-muted-foreground">{x.sku}</span>}
              </span>
              <span className="shrink-0 font-mono text-xs">{money(x.unitPrice)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
