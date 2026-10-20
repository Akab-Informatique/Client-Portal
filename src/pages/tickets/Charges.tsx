import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Boxes, ChevronDown, Loader2, PackagePlus, Plus, Receipt, Search, Wallet, Warehouse, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AiTextarea } from "@/components/AiPolish";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, ApiError } from "@/lib/api";
import { currentLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { ticketErrorText, type TicketDetail } from "./shared";
import { SerialChecklist } from "@/pages/store/SerialChecklist";

export type Charge = {
  id: string;
  name: string;
  description: string;
  quantity: number;
  unitPrice: number | null;
  unitCost: number | null;
  billable: boolean;
  type: string | null;
  status: string | null;
  materialCode: string | null;
  date: string | null;
  author: string | null;
};
type Choice = { value: string; label: string };
type ChargeOptions = { types: Choice[]; statuses: Choice[]; materialCodes: Choice[] };
/** A product of the portal inventory, with its stock per location. */
type StoreProduct = {
  id: string;
  name: string;
  description: string;
  sku: string | null;
  manufacturer: string | null;
  unitPrice: number;
  unitCost: number;
  materialCodeId: string | null;
  serialized: boolean;
  stock: { locationId: string; location: string; quantity: number }[];
  total: number;
};

const money = (n: number) => new Intl.NumberFormat(currentLocale() === "en" ? "en-CA" : "fr-CA", { style: "currency", currency: "CAD" }).format(n);
const num = (s: string) => (s.trim() === "" ? null : Number(s.replace(/\s/g, "").replace(",", ".")));
const NO_STOCK = "none";

export function useCharges(ticketId: number, enabled: boolean) {
  return useQuery({
    queryKey: ["tickets", "charges", ticketId],
    queryFn: () => api.get<Charge[]>(`/tickets/${ticketId}/charges`),
    enabled,
    staleTime: 60_000,
  });
}

const billableTotal = (list: Charge[]) => list.filter((c) => c.billable).reduce((s, c) => s + c.quantity * (c.unitPrice ?? 0), 0);

/**
 * Small buttons above the note box: Charges (count · total; opens the list
 * and the form) and Expense (coming next).
 */
export function ChargeButtons({ tk, editable, partial }: { tk: TicketDetail; editable: boolean; partial: boolean }) {
  const { t } = useTranslation();
  const { data: list } = useCharges(tk.id, !partial);
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" disabled={partial} onClick={() => setOpen(true)}>
        <Receipt className="size-3.5 text-primary" /> {t("tickets.charges.title")}
        {list && list.length > 0 && (
          <span className="rounded-full bg-[color:var(--gold)]/15 px-1.5 py-px font-mono text-[10px] text-primary">
            {list.length} · {money(billableTotal(list))}
          </span>
        )}
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* span: a disabled button shows no tooltip */}
          <span>
            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" disabled>
              <Wallet className="size-3.5" /> {t("tickets.expenses.button")}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t("tickets.expenses.soon")}</TooltipContent>
      </Tooltip>
      {open && <ChargesDialog tk={tk} editable={editable} onClose={() => setOpen(false)} />}
    </div>
  );
}

function ChargesList({ list }: { list: Charge[] }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5 text-sm">
      <ul className="max-h-40 space-y-1.5 overflow-y-auto">
        {list.map((c) => (
          <li key={c.id} className="rounded-lg border bg-background/30 px-3 py-2">
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate font-medium" title={c.description || c.name}>
                {c.name}
              </span>
              <span className="shrink-0 font-mono text-xs">{c.unitPrice !== null ? money(c.quantity * c.unitPrice) : "—"}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
              <span>
                {c.quantity.toLocaleString()} × {c.unitPrice !== null ? money(c.unitPrice) : "—"}
              </span>
              {c.author && <span>· {c.author}</span>}
              <span className={cn("rounded-full px-1.5 py-px text-[10px] font-medium", c.billable ? "bg-emerald-500/15 text-emerald-300" : "bg-muted text-muted-foreground")}>
                {c.billable ? t("tickets.charges.billable") : t("tickets.charges.notBillable")}
              </span>
            </div>
          </li>
        ))}
      </ul>
      <p className="flex justify-between px-1 text-xs">
        <span className="text-muted-foreground">{t("tickets.charges.total")}</span>
        <span className="font-mono font-semibold text-primary">{money(billableTotal(list))}</span>
      </p>
    </div>
  );
}

/** The ticket's charges and the form: a product of the portal inventory → a charge on the ticket. */
function ChargesDialog({ tk, editable, onClose }: { tk: TicketDetail; editable: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: list, isLoading } = useCharges(tk.id, true);
  const { data: o } = useQuery({ queryKey: ["tickets", "charge-options"], queryFn: () => api.get<ChargeOptions>("/tickets/charge-options"), staleTime: 10 * 60_000, enabled: editable });
  const [product, setProduct] = useState<StoreProduct | null>(null);
  const [from, setFrom] = useState(NO_STOCK);
  const [more, setMore] = useState(false);
  const [serialIds, setSerialIds] = useState<string[]>([]);
  const [f, setF] = useState({ quantity: "1", unitPrice: "", unitCost: "", billable: true, description: "", typeId: "", statusId: "", materialCodeId: "", date: new Date().toISOString().slice(0, 10) });
  const set = (k: keyof typeof f) => (v: string | boolean) => setF((x) => ({ ...x, [k]: v }));

  const choose = (p: StoreProduct) => {
    setProduct(p);
    setSerialIds([]);
    // where the units come from: the location with the most stock, else none taken
    const best = [...p.stock].sort((x, y) => y.quantity - x.quantity)[0];
    setFrom(best ? best.locationId : NO_STOCK);
    setF((x) => ({
      ...x,
      unitPrice: String(p.unitPrice),
      unitCost: String(p.unitCost),
      description: p.description.slice(0, 2000),
      materialCodeId: p.materialCodeId && o?.materialCodes.some((c) => c.value === p.materialCodeId) ? p.materialCodeId : x.materialCodeId,
    }));
  };
  // Serialized and taken from stock: the quantity is the number of serials ticked
  const bySerial = Boolean(product?.serialized && from !== NO_STOCK);
  const { data: serials } = useQuery({
    queryKey: ["tickets", "store-products", product?.id, "serials", from],
    queryFn: () => api.get<{ id: string; serial: string }[]>(`/tickets/store-products/${product!.id}/serials?locationId=${from}`),
    enabled: bySerial,
  });
  const qty = bySerial ? serialIds.length : num(f.quantity);
  const price = num(f.unitPrice);
  const onHand = product?.stock.find((s) => s.locationId === from)?.quantity ?? null;
  const tooMany = onHand !== null && qty !== null && qty > onHand;
  const valid = product && qty !== null && qty > 0 && (price === null || price >= 0) && (from === NO_STOCK || (Number.isInteger(qty) && !tooMany));

  const save = useMutation({
    mutationFn: () =>
      api.post<Charge[]>(`/tickets/${tk.id}/charges`, {
        name: product!.name.slice(0, 100),
        description: f.description.trim(),
        quantity: qty,
        unitPrice: price,
        unitCost: num(f.unitCost),
        billable: f.billable,
        typeId: f.typeId || null,
        statusId: f.statusId || null,
        materialCodeId: f.materialCodeId || null,
        date: f.date || null,
        storeProductId: product!.id,
        locationId: from === NO_STOCK ? null : from,
        serialIds: bySerial ? serialIds : [],
      }),
    onSuccess: (next) => {
      qc.setQueryData(["tickets", "charges", tk.id], next);
      void qc.invalidateQueries({ queryKey: ["tickets", "store-products"] });
      void qc.invalidateQueries({ queryKey: ["store"] });
      toast.success(t("tickets.charges.added"));
      setProduct(null);
      setF((x) => ({ ...x, quantity: "1", description: "" }));
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });

  // Default shown when nothing is chosen: the status "Approved", else the first value
  const fallback = (k: "typeId" | "statusId" | "materialCodeId", options: Choice[]) =>
    k === "statusId" ? (options.find((s) => /approu?v/i.test(s.label)) ?? options[0]).value : options[0].value;
  const pick = (k: "typeId" | "statusId" | "materialCodeId", label: string, options: Choice[] | undefined, none?: string) =>
    options && options.length > 0 ? (
      <div className="space-y-1.5">
        <Label>{label}</Label>
        <Select value={f[k] || (none ? "_" : fallback(k, options))} onValueChange={(v) => set(k)(v === "_" ? "" : v)}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {none && <SelectItem value="_">{none}</SelectItem>}
            {options.map((x) => (
              <SelectItem key={x.value} value={x.value}>
                {x.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    ) : null;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector<HTMLInputElement>("#charge-search")?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Receipt className="size-5 text-primary" /> {t("tickets.charges.title")}
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono text-primary">{tk.number}</span> · {tk.title}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? <Skeleton className="h-12" /> : list && list.length > 0 ? <ChargesList list={list} /> : <p className="text-sm text-muted-foreground">{t("tickets.charges.none")}</p>}

        {editable && (
          <form
            className="space-y-4 border-t pt-4"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (valid) save.mutate();
            }}
          >
            <p className="text-sm font-semibold">{t("tickets.charges.new")}</p>
            {product ? (
              <div className="flex items-center gap-3 rounded-xl border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/5 px-3 py-2 text-sm">
                <Boxes className="size-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{product.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {[product.sku, product.manufacturer].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <button type="button" onClick={() => setProduct(null)} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label={t("tickets.charges.unpick")}>
                  <X className="size-4" />
                </button>
              </div>
            ) : (
              <LocalProductSearch onPick={choose} />
            )}

            {product && (
              <>
                <div className="space-y-1.5">
                  <Label>{t("tickets.charges.from")}</Label>
                  <Select
                    value={from}
                    onValueChange={(v) => {
                      setFrom(v);
                      setSerialIds([]);
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {product.stock.map((s) => (
                        <SelectItem key={s.locationId} value={s.locationId}>
                          {t("tickets.charges.fromLocation", { location: s.location, count: s.quantity })}
                        </SelectItem>
                      ))}
                      <SelectItem value={NO_STOCK}>{t("tickets.charges.noStockTaken")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {bySerial && (
                  <div className="space-y-1.5">
                    <Label>{t("tickets.charges.whichSerials")}</Label>
                    {serials ? <SerialChecklist serials={serials} picked={serialIds} onChange={setSerialIds} empty={t("store.noSerialHere")} /> : <Skeleton className="h-20" />}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="ch-qty">{t("tickets.charges.quantity")}</Label>
                    <Input id="ch-qty" inputMode="decimal" value={bySerial ? String(serialIds.length) : f.quantity} disabled={bySerial} onChange={(e) => set("quantity")(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ch-price">{t("tickets.charges.unitPrice")}</Label>
                    <Input id="ch-price" inputMode="decimal" value={f.unitPrice} onChange={(e) => set("unitPrice")(e.target.value)} />
                  </div>
                </div>
                {tooMany && <p className="-mt-2 text-xs text-orange-300">{t("tickets.charges.moreThanStock", { count: onHand ?? 0 })}</p>}
                {qty !== null && price !== null && qty > 0 && (
                  <p className="-mt-2 text-right text-xs text-muted-foreground">
                    {t("tickets.charges.lineTotal")} : <span className="font-mono text-foreground">{money(qty * price)}</span>
                  </p>
                )}
                <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
                  {t("tickets.charges.billableToClient")}
                  <Switch checked={f.billable} onCheckedChange={(v) => set("billable")(v)} />
                </label>

                <button type="button" onClick={() => setMore((m) => !m)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                  <ChevronDown className={cn("size-3.5 transition-transform", !more && "-rotate-90")} /> {t("tickets.charges.moreOptions")}
                </button>
                {more && (
                  <div className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="ch-cost">{t("tickets.charges.unitCost")}</Label>
                        <Input id="ch-cost" inputMode="decimal" value={f.unitCost} onChange={(e) => set("unitCost")(e.target.value)} />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="ch-date">{t("tickets.charges.date")}</Label>
                        <Input id="ch-date" type="date" value={f.date} onChange={(e) => set("date")(e.target.value)} />
                      </div>
                      {pick("materialCodeId", t("tickets.charges.materialCode"), o?.materialCodes, t("tickets.charges.noCode"))}
                      {pick("typeId", t("tickets.charges.type"), o?.types)}
                      {pick("statusId", t("tickets.charges.status"), o?.statuses)}
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="ch-desc">{t("tickets.charges.description")}</Label>
                      <AiTextarea id="ch-desc" rows={2} maxLength={2000} value={f.description} onChange={(e) => set("description")(e.target.value)} />
                    </div>
                  </div>
                )}
              </>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                {t("common.close")}
              </Button>
              <Button type="submit" disabled={!valid || save.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
                {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("tickets.charges.save")}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Search the portal inventory; a product that does not exist can be added on the spot. */
function LocalProductSearch({ onPick }: { onPick: (p: StoreProduct) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setQ(text.trim()), 200);
    return () => clearTimeout(id);
  }, [text]);
  const { data, isFetching } = useQuery({
    queryKey: ["tickets", "store-products", q],
    queryFn: () => api.get<StoreProduct[]>(`/tickets/store-products?q=${encodeURIComponent(q)}`),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  if (creating) return <QuickProduct name={text.trim()} onCancel={() => setCreating(false)} onCreated={onPick} />;
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input id="charge-search" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("tickets.charges.searchLocal")} className="pl-9" />
        {isFetching && <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
      </div>
      <ul className="max-h-56 overflow-y-auto rounded-xl border">
        {data?.length === 0 && <li className="px-3 py-3 text-center text-sm text-muted-foreground">{q ? t("tickets.charges.noLocal") : t("tickets.charges.emptyInventory")}</li>}
        {data?.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => onPick(p)} className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent">
              <Boxes className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{p.name}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {[p.sku, p.stock.length ? p.stock.map((s) => `${s.location} ${s.quantity}`).join(" · ") : null].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block font-mono text-xs">{money(p.unitPrice)}</span>
                <span className={cn("block text-[10px]", p.total > 0 ? "text-emerald-400" : "text-muted-foreground")}>
                  {p.total > 0 ? t("tickets.charges.onHand", { count: p.total }) : t("tickets.charges.outOfStock")}
                </span>
              </span>
            </button>
          </li>
        ))}
        <li className="border-t">
          <button type="button" onClick={() => setCreating(true)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-primary hover:bg-accent">
            <PackagePlus className="size-4" /> {text.trim() ? t("tickets.charges.createNamed", { name: text.trim() }) : t("tickets.charges.create")}
          </button>
        </li>
      </ul>
    </div>
  );
}

/** Add a product to the portal inventory (from a ticket), then charge it. */
function QuickProduct({ name, onCancel, onCreated }: { name: string; onCancel: () => void; onCreated: (p: StoreProduct) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [f, setF] = useState({ name, sku: "", manufacturer: "", price: "", cost: "" });
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const price = num(f.price);
  const cost = f.cost.trim() ? num(f.cost) : 0;
  const ok = f.name.trim() && price !== null && price >= 0 && cost !== null && cost >= 0;
  const create = useMutation({
    mutationFn: () =>
      api.post<StoreProduct>("/tickets/store-products", {
        name: f.name.trim(),
        sku: f.sku.trim() || null,
        manufacturer: f.manufacturer.trim() || null,
        priceCents: Math.round((price ?? 0) * 100),
        costCents: Math.round((cost ?? 0) * 100),
      }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ["tickets", "store-products"] });
      void qc.invalidateQueries({ queryKey: ["store"] });
      toast.success(t("tickets.charges.productCreated"));
      onCreated(p);
    },
    onError: (e) => toast.error(e instanceof ApiError && e.code === "sku_taken" ? t("store.errors.sku_taken") : t("common.error")),
  });
  return (
    <div className="space-y-3 rounded-xl border border-dashed border-[color:var(--gold)]/40 p-3">
      <p className="flex items-center gap-2 text-sm font-medium">
        <PackagePlus className="size-4 text-primary" /> {t("tickets.charges.newProduct")}
      </p>
      <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
        <Input autoFocus value={f.name} maxLength={200} onChange={(e) => set("name")(e.target.value)} placeholder={t("store.fields.name")} aria-label={t("store.fields.name")} />
        <Input value={f.sku} maxLength={60} onChange={(e) => set("sku")(e.target.value)} placeholder={t("store.fields.sku")} aria-label={t("store.fields.sku")} className="font-mono" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Input value={f.manufacturer} maxLength={120} onChange={(e) => set("manufacturer")(e.target.value)} placeholder={t("store.fields.manufacturer")} aria-label={t("store.fields.manufacturer")} />
        <Input inputMode="decimal" value={f.price} onChange={(e) => set("price")(e.target.value)} placeholder={t("store.fields.price")} aria-label={t("store.fields.price")} />
        <Input inputMode="decimal" value={f.cost} onChange={(e) => set("cost")(e.target.value)} placeholder={t("store.fields.cost")} aria-label={t("store.fields.cost")} />
      </div>
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Warehouse className="size-3" /> {t("tickets.charges.newProductHint")}
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="button" size="sm" disabled={!ok || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} {t("tickets.charges.createAndPick")}
        </Button>
      </div>
    </div>
  );
}
