import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Boxes, Loader2, PackageSearch, PenLine, Plus, Receipt, Search, Warehouse, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { currentLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { ticketErrorText, type TicketDetail } from "./shared";

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
type Product = { id: string; name: string; description: string; sku: string | null; manufacturer: string | null; unitPrice: number | null; unitCost: number | null; materialCodeId: string | null };
type InventoryItem = { id: string; product: Product; location: string; onHand: number };
type Source = "product" | "inventory" | "manual";

const money = (n: number) => new Intl.NumberFormat(currentLocale() === "en" ? "en-CA" : "fr-CA", { style: "currency", currency: "CAD" }).format(n);

export function useCharges(ticketId: number, enabled: boolean) {
  return useQuery({
    queryKey: ["tickets", "charges", ticketId],
    queryFn: () => api.get<Charge[]>(`/tickets/${ticketId}/charges`),
    enabled,
    staleTime: 60_000,
  });
}

/** Billable total of the charges, for the section title. */
export function chargesSummary(list: Charge[] | undefined): string | null {
  if (!list?.length) return null;
  const total = list.filter((c) => c.billable).reduce((s, c) => s + c.quantity * (c.unitPrice ?? 0), 0);
  return `${list.length} · ${money(total)}`;
}

/** The ticket's charges (material, expenses…), and adding one (sent to Autotask). */
export function ChargesContent({ tk, partial }: { tk: TicketDetail; partial: boolean }) {
  const { t } = useTranslation();
  const { data: list, isLoading } = useCharges(tk.id, !partial);
  if (partial || isLoading) return <Skeleton className="h-12" />;
  if (!list?.length) return <p className="text-sm text-muted-foreground">{t("tickets.charges.none")}</p>;
  const total = list.filter((c) => c.billable).reduce((s, c) => s + c.quantity * (c.unitPrice ?? 0), 0);
  return (
    <div className="space-y-2 text-sm">
      <ul className="charges-list space-y-1.5">
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
              {c.materialCode && <span>· {c.materialCode}</span>}
              <span className={cn("rounded-full px-1.5 py-px text-[10px] font-medium", c.billable ? "bg-emerald-500/15 text-emerald-300" : "bg-muted text-muted-foreground")}>
                {c.billable ? t("tickets.charges.billable") : t("tickets.charges.notBillable")}
              </span>
            </div>
          </li>
        ))}
      </ul>
      <p className="flex justify-between border-t pt-2 text-xs">
        <span className="text-muted-foreground">{t("tickets.charges.total")}</span>
        <span className="font-mono font-semibold text-primary">{money(total)}</span>
      </p>
    </div>
  );
}

/** "+ Add" in the section header: the charge form. */
export function AddCharge({ tk }: { tk: TicketDetail }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <Plus className="size-3" /> {t("tickets.charges.add")}
      </button>
      {open && <ChargeDialog tk={tk} onClose={() => setOpen(false)} />}
    </>
  );
}

function ChargeDialog({ tk, onClose }: { tk: TicketDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: o } = useQuery({ queryKey: ["tickets", "charge-options"], queryFn: () => api.get<ChargeOptions>("/tickets/charge-options"), staleTime: 10 * 60_000 });
  const [f, setF] = useState({ name: "", description: "", quantity: "1", unitPrice: "", unitCost: "", billable: true, typeId: "", statusId: "", materialCodeId: "", date: new Date().toISOString().slice(0, 10) });
  const [source, setSource] = useState<Source>("product");
  // The product picked (catalogue or stock): linked to the charge in Autotask
  const [picked, setPicked] = useState<{ product: Product; stock?: { id: string; location: string; onHand: number } } | null>(null);
  const choose = (product: Product, stock?: { id: string; location: string; onHand: number }) => {
    setPicked({ product, stock });
    setF((x) => ({
      ...x,
      name: product.name.slice(0, 100),
      description: product.description.slice(0, 2000),
      unitPrice: product.unitPrice !== null ? String(product.unitPrice) : "",
      unitCost: product.unitCost !== null ? String(product.unitCost) : "",
      materialCodeId: product.materialCodeId && o?.materialCodes.some((c) => c.value === product.materialCodeId) ? product.materialCodeId : x.materialCodeId,
    }));
  };
  const set = (k: keyof typeof f) => (v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const num = (s: string) => (s.trim() === "" ? null : Number(s.replace(",", ".")));
  const qty = num(f.quantity);
  const price = num(f.unitPrice);
  const valid = f.name.trim() && qty !== null && qty > 0 && (price === null || price >= 0) && (!picked?.stock || (Number.isInteger(qty) && qty <= picked.stock.onHand));
  const save = useMutation({
    mutationFn: () =>
      api.post<Charge[]>(`/tickets/${tk.id}/charges`, {
        name: f.name.trim(),
        description: f.description.trim(),
        quantity: qty,
        unitPrice: price,
        unitCost: num(f.unitCost),
        billable: f.billable,
        typeId: f.typeId || null,
        statusId: f.statusId || null,
        materialCodeId: f.materialCodeId || null,
        date: f.date || null,
        // from the portal inventory: taken out of stock; from the catalogue: linked to the product
        productId: picked && !picked.stock ? picked.product.id : null,
        stockId: picked?.stock?.id ?? null,
      }),
    onSuccess: (list) => {
      qc.setQueryData(["tickets", "charges", tk.id], list);
      if (picked?.stock) {
        void qc.invalidateQueries({ queryKey: ["tickets", "inventory"] });
        void qc.invalidateQueries({ queryKey: ["store"] });
      }
      toast.success(t("tickets.charges.added"));
      onClose();
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
  const pick = (k: "typeId" | "statusId" | "materialCodeId", label: string, list: Choice[] | undefined, none?: string) =>
    list && list.length > 0 ? (
      <div className="space-y-1.5">
        <Label>{label}</Label>
        <Select value={f[k] || "_"} onValueChange={(v) => set(k)(v === "_" ? "" : v)}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="_">{none ?? list[0].label}</SelectItem>
            {(none ? list : list.slice(1)).map((x) => (
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
        className="sm:max-w-lg"
        // straight into the product search (the first field)
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector<HTMLInputElement>("input")?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Receipt className="size-5 text-primary" /> {t("tickets.charges.new")}
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono text-primary">{tk.number}</span> · {tk.title}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          {/* Where the item comes from */}
          <div className="grid grid-cols-3 gap-1 rounded-xl border p-1 text-xs">
            {(
              [
                ["product", PackageSearch, t("tickets.charges.fromProduct")],
                ["inventory", Warehouse, t("tickets.charges.fromInventory")],
                ["manual", PenLine, t("tickets.charges.fromManual")],
              ] as const
            ).map(([k, Icon, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setSource(k)}
                className={cn("flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 font-medium transition-colors", source === k ? "bg-grad-gold text-[#1a1204]" : "text-muted-foreground hover:text-foreground")}
              >
                <Icon className="size-3.5" /> {label}
              </button>
            ))}
          </div>
          {picked ? (
            <div className="flex items-center gap-3 rounded-xl border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/5 px-3 py-2 text-sm">
              {picked.stock ? <Warehouse className="size-4 shrink-0 text-primary" /> : <Boxes className="size-4 shrink-0 text-primary" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{picked.product.name}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {[picked.product.sku, picked.product.manufacturer, picked.stock && t("tickets.charges.inStock", { count: picked.stock.onHand, location: picked.stock.location })].filter(Boolean).join(" · ")}
                </span>
              </span>
              <button type="button" onClick={() => setPicked(null)} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label={t("tickets.charges.unpick")}>
                <X className="size-4" />
              </button>
            </div>
          ) : source === "product" ? (
            <ProductSearch onPick={(p) => choose(p)} />
          ) : source === "inventory" ? (
            <InventoryPick onPick={(i) => choose(i.product, { id: i.id, location: i.location, onHand: i.onHand })} />
          ) : null}
          {picked?.stock && qty !== null && qty > picked.stock.onHand && <p className="-mt-2 text-xs text-orange-300">{t("tickets.charges.moreThanStock", { count: picked.stock.onHand })}</p>}

          <div className="space-y-1.5">
            <Label htmlFor="ch-name">{t("tickets.charges.name")}</Label>
            <Input id="ch-name" autoFocus={source === "manual"} maxLength={100} value={f.name} onChange={(e) => set("name")(e.target.value)} placeholder={t("tickets.charges.namePlaceholder")} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ch-qty">{t("tickets.charges.quantity")}</Label>
              <Input id="ch-qty" inputMode="decimal" value={f.quantity} onChange={(e) => set("quantity")(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ch-price">{t("tickets.charges.unitPrice")}</Label>
              <Input id="ch-price" inputMode="decimal" value={f.unitPrice} onChange={(e) => set("unitPrice")(e.target.value)} placeholder="0,00" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ch-cost">{t("tickets.charges.unitCost")}</Label>
              <Input id="ch-cost" inputMode="decimal" value={f.unitCost} onChange={(e) => set("unitCost")(e.target.value)} placeholder="0,00" />
            </div>
          </div>
          {qty !== null && price !== null && qty > 0 && (
            <p className="-mt-2 text-right text-xs text-muted-foreground">
              {t("tickets.charges.total")} : <span className="font-mono text-foreground">{money(qty * price)}</span>
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {pick("materialCodeId", t("tickets.charges.materialCode"), o?.materialCodes, t("tickets.charges.noCode"))}
            {pick("typeId", t("tickets.charges.type"), o?.types)}
            {pick("statusId", t("tickets.charges.status"), o?.statuses)}
            <div className="space-y-1.5">
              <Label htmlFor="ch-date">{t("tickets.charges.date")}</Label>
              <Input id="ch-date" type="date" value={f.date} onChange={(e) => set("date")(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ch-desc">{t("tickets.charges.description")}</Label>
            <Textarea id="ch-desc" rows={2} maxLength={2000} value={f.description} onChange={(e) => set("description")(e.target.value)} />
          </div>
          <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
            {t("tickets.charges.billableToClient")}
            <Switch checked={f.billable} onCheckedChange={(v) => set("billable")(v)} />
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!valid || save.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
              {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("tickets.charges.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Search the Autotask product catalogue. */
function ProductSearch({ onPick }: { onPick: (p: Product) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(id);
  }, [text]);
  const { data, isFetching } = useQuery({
    queryKey: ["tickets", "products", q],
    queryFn: () => api.get<Product[]>(`/tickets/products?q=${encodeURIComponent(q)}`),
    enabled: q.length >= 2,
    staleTime: 60_000,
  });
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={t("tickets.charges.searchProduct")} className="pl-9" />
        {isFetching && <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
      </div>
      {q.length >= 2 && data && (
        <ul className="max-h-52 overflow-y-auto rounded-xl border">
          {data.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted-foreground">{t("tickets.charges.noProduct")}</li>}
          {data.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => onPick(p)} className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent">
                <Boxes className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{p.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{[p.sku, p.manufacturer].filter(Boolean).join(" · ")}</span>
                </span>
                {p.unitPrice !== null && <span className="shrink-0 font-mono text-xs">{money(p.unitPrice)}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Products in stock, filtered here (location + quantity on hand). */
function InventoryPick({ onPick }: { onPick: (i: InventoryItem) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const { data, isLoading } = useQuery({ queryKey: ["tickets", "inventory"], queryFn: () => api.get<InventoryItem[]>("/tickets/inventory"), staleTime: 2 * 60_000 });
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (data ?? []).filter((i) => words.every((w) => `${i.product.name} ${i.product.sku ?? ""} ${i.location}`.toLowerCase().includes(w)));
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={t("tickets.charges.searchInventory")} className="pl-9" />
      </div>
      {isLoading ? (
        <Skeleton className="h-24" />
      ) : (
        <ul className="max-h-52 overflow-y-auto rounded-xl border">
          {shown.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted-foreground">{t("tickets.charges.noStock")}</li>}
          {shown.map((i) => (
            <li key={i.id}>
              <button type="button" onClick={() => onPick(i)} className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent">
                <Warehouse className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{i.product.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{i.location}</span>
                </span>
                <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">{t("tickets.charges.onHand", { count: i.onHand })}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
