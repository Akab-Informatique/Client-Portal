import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Archive,
  Boxes,
  DollarSign,
  History,
  Loader2,
  MapPin,
  MoreHorizontal,
  PackageMinus,
  PackagePlus,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Store,
  Warehouse,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { api, ApiError } from "@/lib/api";
import { currentLocale } from "@/i18n";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { longDateTime } from "@/pages/tickets/shared";
import { SerialChecklist } from "./SerialChecklist";

type Location = { id: string; name: string; active: boolean };
type Product = {
  id: string;
  sku: string | null;
  name: string;
  description: string;
  manufacturer: string | null;
  category: string | null;
  priceCents: number;
  costCents: number;
  minQuantity: number;
  materialCodeId: string | null;
  serialized: boolean;
  active: boolean;
  stock: { locationId: string; location: string; quantity: number }[];
  total: number;
  low: boolean;
};
type StoreData = { products: Product[]; locations: Location[]; stats: { active: number; low: number; out: number; valueCents: number; units: number } };
type Movement = {
  id: string;
  delta: number;
  kind: "receive" | "adjust" | "ticket";
  note: string;
  ticketNumber: string | null;
  serials: string[];
  supplier: string | null;
  reference: string | null;
  createdAt: string;
  location: string;
  user: string | null;
};
type Filter = "all" | "low" | "out" | "archived";

const KEY = ["store"];
const money = (cents: number) => new Intl.NumberFormat(currentLocale() === "en" ? "en-CA" : "fr-CA", { style: "currency", currency: "CAD" }).format(cents / 100);
const toCents = (s: string) => {
  const n = Number(s.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};
const fromCents = (c: number) => (c / 100).toFixed(2);

function useStoreError() {
  const { t } = useTranslation();
  return (e: unknown) => t(`store.errors.${e instanceof ApiError ? e.code : "x"}`, { defaultValue: t("common.error") });
}

/**
 * Store inventory: the products AKAB sells, kept in the portal, with stock per
 * location and the history of every movement. Items used on a ticket (charge
 * from inventory) come out of here automatically.
 */
export function StorePage() {
  const { t } = useTranslation();
  const can = useCan();
  const manage = can("store.manage");
  const { data, isLoading } = useQuery({ queryKey: KEY, queryFn: () => api.get<StoreData>("/store") });
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [dialog, setDialog] = useState<
    { kind: "product"; product: Product | null } | { kind: "stock"; product: Product; mode: "receive" | "adjust" } | { kind: "history"; product: Product } | { kind: "locations" } | null
  >(null);

  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (data?.products ?? []).filter((p) => {
      if (filter === "archived" ? p.active : !p.active) return false;
      if (filter === "low" && !(p.low && p.total > 0)) return false;
      if (filter === "out" && p.total > 0) return false;
      return words.every((w) => `${p.name} ${p.sku ?? ""} ${p.manufacturer ?? ""} ${p.category ?? ""}`.toLowerCase().includes(w));
    });
  }, [data, q, filter]);

  return (
    <div className="relative isolate space-y-4">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Store className="size-6 text-primary" /> {t("store.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("store.subtitle")}</p>
        </div>
        {manage && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="h-9" onClick={() => setDialog({ kind: "locations" })}>
              <MapPin className="size-4" /> {t("store.locations")}
            </Button>
            <Button size="sm" className="h-9 bg-grad-gold font-semibold text-[#1a1204] glow-gold hover:brightness-105" onClick={() => setDialog({ kind: "product", product: null })}>
              <Plus className="size-4" /> {t("store.newProduct")}
            </Button>
          </div>
        )}
      </div>

      {/* Key numbers */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile icon={Boxes} label={t("store.stats.active")} value={data ? String(data.stats.active) : "…"} />
        <Tile icon={Warehouse} label={t("store.stats.units")} value={data ? data.stats.units.toLocaleString() : "…"} />
        <Tile icon={DollarSign} label={t("store.stats.value")} value={data ? money(data.stats.valueCents) : "…"} hint={t("store.stats.valueHint")} />
        <Tile
          icon={AlertTriangle}
          label={t("store.stats.attention")}
          value={data ? String(data.stats.low + data.stats.out) : "…"}
          hint={data ? t("store.stats.attentionHint", { low: data.stats.low, out: data.stats.out }) : undefined}
          alert={Boolean(data && data.stats.low + data.stats.out > 0)}
          onClick={() => setFilter(data && data.stats.out > 0 ? "out" : "low")}
        />
      </div>

      {/* Search and filters */}
      <div className="glass flex flex-wrap items-center gap-1.5 rounded-2xl border p-1.5">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("store.search")}
            className="h-9 w-full rounded-xl bg-transparent pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        {(["all", "low", "out", "archived"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              filter === f ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/15 text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`store.filter.${f}`)}
          </button>
        ))}
      </div>

      {/* Products */}
      <div className="glass overflow-hidden rounded-2xl border">
        <div className="hidden grid-cols-[minmax(0,1fr)_140px_110px_110px_80px_150px_44px] gap-3 border-b px-5 py-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground xl:grid">
          <span>{t("store.cols.product")}</span>
          <span>{t("store.cols.category")}</span>
          <span className="text-right">{t("store.cols.price")}</span>
          <span className="text-right">{t("store.cols.cost")}</span>
          <span className="text-right">{t("store.cols.margin")}</span>
          <span>{t("store.cols.stock")}</span>
          <span />
        </div>
        {isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
            <Boxes className="size-10 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">{data?.products.length ? t("store.noMatch") : t("store.empty")}</p>
            {manage && !data?.products.length && (
              <Button size="sm" className="bg-grad-gold font-semibold text-[#1a1204]" onClick={() => setDialog({ kind: "product", product: null })}>
                <Plus className="size-4" /> {t("store.newProduct")}
              </Button>
            )}
          </div>
        ) : (
          <ul className="divide-y">
            {shown.map((p) => (
              <ProductRow key={p.id} p={p} manage={manage} open={(d) => setDialog(d)} />
            ))}
          </ul>
        )}
      </div>

      {dialog?.kind === "product" && <ProductDialog product={dialog.product} onClose={() => setDialog(null)} />}
      {dialog?.kind === "stock" && data && dialog.mode === "receive" && (
        <ReceiveDialog product={dialog.product} locations={data.locations} onClose={() => setDialog(null)} onLocations={() => setDialog({ kind: "locations" })} />
      )}
      {dialog?.kind === "stock" && data && dialog.mode === "adjust" && <AdjustDialog product={dialog.product} locations={data.locations} onClose={() => setDialog(null)} />}
      {dialog?.kind === "history" && <HistoryDialog product={dialog.product} onClose={() => setDialog(null)} />}
      {dialog?.kind === "locations" && data && <LocationsDialog locations={data.locations} onClose={() => setDialog(null)} />}
    </div>
  );
}

function Tile({ icon: Icon, label, value, hint, alert, onClick }: { icon: typeof Boxes; label: string; value: string; hint?: string; alert?: boolean; onClick?: () => void }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      {...(onClick ? { type: "button" as const, onClick } : {})}
      className={cn("glass flex items-center gap-4 rounded-2xl border p-4 text-left", onClick && "transition hover:border-[color:var(--gold)]/40", alert && "border-orange-500/40")}
    >
      <span className={cn("hex flex size-11 shrink-0 items-center justify-center", alert ? "bg-orange-500/15 text-orange-300" : "bg-[color:var(--gold)]/15 text-primary")}>
        <Icon className="size-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-xs text-muted-foreground">{label}</span>
        <span className="block font-display text-2xl font-bold">{value}</span>
        {hint && <span className="block truncate text-[11px] text-muted-foreground">{hint}</span>}
      </span>
    </Tag>
  );
}

type Open = (d: { kind: "product"; product: Product } | { kind: "stock"; product: Product; mode: "receive" | "adjust" } | { kind: "history"; product: Product }) => void;

function ProductRow({ p, manage, open }: { p: Product; manage: boolean; open: Open }) {
  const { t } = useTranslation();
  const margin = p.priceCents > 0 ? Math.round(((p.priceCents - p.costCents) / p.priceCents) * 100) : null;
  return (
    <li className={cn("grid grid-cols-1 gap-x-3 gap-y-1 px-5 py-3 xl:grid-cols-[minmax(0,1fr)_140px_110px_110px_80px_150px_44px] xl:items-center", !p.active && "opacity-60")}>
      <span className="min-w-0">
        <span className="flex items-baseline gap-2">
          <span className="truncate font-medium">{p.name}</span>
          {p.serialized && <span className="shrink-0 rounded border border-[color:var(--gold)]/40 px-1 text-[9px] font-semibold text-primary">{t("store.serializedTag")}</span>}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{[p.sku, p.manufacturer].filter(Boolean).join(" · ") || "—"}</span>
      </span>
      <span className="truncate text-sm text-muted-foreground">{p.category ?? "—"}</span>
      <span className="text-sm xl:text-right">{money(p.priceCents)}</span>
      <span className="text-sm text-muted-foreground xl:text-right">{money(p.costCents)}</span>
      <span className={cn("text-sm xl:text-right", margin !== null && margin < 15 ? "text-orange-300" : "text-emerald-400")}>{margin !== null ? `${margin} %` : "—"}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex items-center gap-2">
            <span
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs font-semibold",
                p.total <= 0 ? "border-destructive/50 bg-destructive/10 text-destructive" : p.low ? "border-orange-500/50 bg-orange-500/10 text-orange-300" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
              )}
            >
              {p.total.toLocaleString()}
            </span>
            <span className="text-[11px] text-muted-foreground">{p.total <= 0 ? t("store.status.out") : p.low ? t("store.status.low") : t("store.status.ok")}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {p.stock.length ? p.stock.map((s) => <p key={s.locationId}>{`${s.location} : ${s.quantity}`}</p>) : t("store.noStockAnywhere")}
          <p className="mt-1 opacity-70">{t("store.minHint", { count: p.minQuantity })}</p>
        </TooltipContent>
      </Tooltip>
      <span className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label={t("store.actions")}>
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {manage && (
              <>
                <DropdownMenuItem onSelect={() => open({ kind: "stock", product: p, mode: "receive" })}>
                  <PackagePlus className="size-4" /> {t("store.receive")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => open({ kind: "stock", product: p, mode: "adjust" })}>
                  <SlidersHorizontal className="size-4" /> {p.serialized ? t("store.removeSerials") : t("store.adjust")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => open({ kind: "product", product: p })}>
                  <Pencil className="size-4" /> {t("store.edit")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onSelect={() => open({ kind: "history", product: p })}>
              <History className="size-4" /> {t("store.history")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </li>
  );
}

function Field({ id, label, children, hint }: { id?: string; label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Create or edit a product. */
function ProductDialog({ product, onClose }: { product: Product | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const err = useStoreError();
  const can = useCan();
  const [f, setF] = useState({
    sku: product?.sku ?? "",
    name: product?.name ?? "",
    description: product?.description ?? "",
    manufacturer: product?.manufacturer ?? "",
    category: product?.category ?? "",
    price: product ? fromCents(product.priceCents) : "",
    cost: product ? fromCents(product.costCents) : "",
    minQuantity: String(product?.minQuantity ?? 0),
    materialCodeId: product?.materialCodeId ?? "",
    serialized: product?.serialized ?? false,
    active: product?.active ?? true,
  });
  const set = (k: keyof typeof f) => (v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const { data: codes } = useQuery({
    queryKey: ["tickets", "charge-options"],
    queryFn: () => api.get<{ materialCodes: { value: string; label: string }[] }>("/tickets/charge-options"),
    enabled: can("tickets.edit"),
    staleTime: 10 * 60_000,
  });
  const price = toCents(f.price);
  const cost = f.cost.trim() ? toCents(f.cost) : 0;
  const min = Number(f.minQuantity);
  const valid = f.name.trim() && price !== null && cost !== null && Number.isInteger(min) && min >= 0;
  const save = useMutation({
    mutationFn: () => {
      const payload = {
        sku: f.sku.trim() || null,
        name: f.name.trim(),
        description: f.description.trim(),
        manufacturer: f.manufacturer.trim() || null,
        category: f.category.trim() || null,
        priceCents: price,
        costCents: cost,
        minQuantity: min,
        materialCodeId: f.materialCodeId || null,
        serialized: f.serialized,
        active: f.active,
      };
      return product ? api.patch(`/store/products/${product.id}`, payload) : api.post("/store/products", payload);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["tickets", "inventory"] });
      toast.success(t("common.saved"));
      onClose();
    },
    onError: (e) => toast.error(err(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{product ? t("store.editProduct") : t("store.newProduct")}</DialogTitle>
          <DialogDescription>{t("store.productHint")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
            <Field id="sp-name" label={t("store.fields.name")}>
              <Input id="sp-name" autoFocus value={f.name} maxLength={200} onChange={(e) => set("name")(e.target.value)} />
            </Field>
            <Field id="sp-sku" label={t("store.fields.sku")}>
              <Input id="sp-sku" value={f.sku} maxLength={60} onChange={(e) => set("sku")(e.target.value)} className="font-mono" />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="sp-man" label={t("store.fields.manufacturer")}>
              <Input id="sp-man" value={f.manufacturer} maxLength={120} onChange={(e) => set("manufacturer")(e.target.value)} />
            </Field>
            <Field id="sp-cat" label={t("store.fields.category")}>
              <Input id="sp-cat" value={f.category} maxLength={120} onChange={(e) => set("category")(e.target.value)} placeholder={t("store.fields.categoryHint")} />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field id="sp-price" label={t("store.fields.price")}>
              <Input id="sp-price" inputMode="decimal" value={f.price} onChange={(e) => set("price")(e.target.value)} placeholder="0,00" />
            </Field>
            <Field id="sp-cost" label={t("store.fields.cost")}>
              <Input id="sp-cost" inputMode="decimal" value={f.cost} onChange={(e) => set("cost")(e.target.value)} placeholder="0,00" />
            </Field>
            <Field id="sp-min" label={t("store.fields.min")}>
              <Input id="sp-min" inputMode="numeric" value={f.minQuantity} onChange={(e) => set("minQuantity")(e.target.value)} />
            </Field>
          </div>
          {price !== null && price > 0 && cost !== null && (
            <p className="-mt-2 text-right text-xs text-muted-foreground">
              {t("store.cols.margin")} : <span className="text-foreground">{Math.round(((price - cost) / price) * 100)} %</span> · {money(price - cost)}
            </p>
          )}
          <label className={cn("flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm", product && product.total > 0 && "opacity-60")}>
            <span>
              {t("store.fields.serialized")}
              <span className="block text-[11px] text-muted-foreground">{product && product.total > 0 ? t("store.serializedLocked") : t("store.fields.serializedHint")}</span>
            </span>
            <Switch checked={f.serialized} disabled={Boolean(product && product.total > 0)} onCheckedChange={(v) => set("serialized")(v)} />
          </label>
          <Field id="sp-desc" label={t("store.fields.description")}>
            <Textarea id="sp-desc" rows={2} maxLength={4000} value={f.description} onChange={(e) => set("description")(e.target.value)} />
          </Field>

          {/* When charged on a ticket */}
          <div className="space-y-3 rounded-xl border p-3">
            <p className="text-xs font-medium text-muted-foreground">{t("store.chargeBlock")}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {codes && codes.materialCodes.length > 0 && (
                <Field label={t("store.fields.materialCode")}>
                  <Select value={f.materialCodeId || "_"} onValueChange={(v) => set("materialCodeId")(v === "_" ? "" : v)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      <SelectItem value="_">{t("tickets.charges.noCode")}</SelectItem>
                      {codes.materialCodes.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </div>
          </div>

          {product && (
            <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
              <span className="flex items-center gap-2">
                <Archive className="size-4 text-muted-foreground" /> {t("store.fields.active")}
              </span>
              <Switch checked={f.active} onCheckedChange={(v) => set("active")(v)} />
            </label>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!valid || save.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
              {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Receive a purchase: where it was bought, at what cost; serial numbers for serialized products. */
function ReceiveDialog({ product, locations, onClose, onLocations }: { product: Product; locations: Location[]; onClose: () => void; onLocations: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const err = useStoreError();
  const active = locations.filter((l) => l.active);
  const { data: knownSuppliers = [] } = useQuery({ queryKey: [...KEY, "suppliers"], queryFn: () => api.get<string[]>("/store/suppliers"), staleTime: 60_000 });
  const [f, setF] = useState({
    locationId: active[0]?.id ?? "",
    quantity: "",
    serials: "",
    cost: fromCents(product.costCents),
    supplier: "",
    reference: "",
    purchasedAt: new Date().toISOString().slice(0, 10),
    note: "",
    updateCost: true,
  });
  const [conflicts, setConflicts] = useState<string[]>([]);
  const set = (k: keyof typeof f) => (v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  // One serial per line (a scanner types one, then Enter)
  const lines = f.serials
    .split(/[\n,;\t]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const dupes = lines.filter((s, i) => lines.findIndex((x) => x.toUpperCase() === s.toUpperCase()) !== i);
  const qty = product.serialized ? lines.length : Number(f.quantity);
  const cost = toCents(f.cost);
  const valid = f.locationId && Number.isInteger(qty) && qty > 0 && cost !== null && !dupes.length;
  const current = product.stock.find((s) => s.locationId === f.locationId)?.quantity ?? 0;
  const save = useMutation({
    mutationFn: () =>
      api.post(`/store/products/${product.id}/receive`, {
        locationId: f.locationId,
        quantity: product.serialized ? 1 : qty,
        serials: product.serialized ? lines : [],
        unitCostCents: cost,
        supplier: f.supplier.trim() || null,
        reference: f.reference.trim() || null,
        purchasedAt: f.purchasedAt || null,
        note: f.note.trim(),
        updateCost: f.updateCost,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["tickets", "store-products"] });
      toast.success(t("store.received", { count: qty }));
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "serial_exists") setConflicts((e.fields ?? []).map((x) => x.message));
      toast.error(err(e));
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
        onOpenAutoFocus={(e) => {
          const el = (e.currentTarget as HTMLElement).querySelector<HTMLElement>(product.serialized ? "#rc-serials" : "#rc-qty");
          if (el) {
            e.preventDefault();
            el.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackagePlus className="size-5 text-primary" /> {t("store.receive")}
          </DialogTitle>
          <DialogDescription>
            {product.name}
            {product.serialized && <span className="ml-2 rounded border border-sky-500/40 px-1 text-[9px] font-semibold text-sky-300">{t("store.serializedTag")}</span>}
          </DialogDescription>
        </DialogHeader>
        {active.length === 0 ? (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">{t("store.needLocation")}</p>
            <Button onClick={onLocations}>
              <MapPin className="size-4" /> {t("store.locations")}
            </Button>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (valid) save.mutate();
            }}
          >
            {/* 1. What came in, where */}
            <section className="space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("store.step.what")}</p>
              <Field label={t("store.location")} hint={t("store.nowAt", { count: current, after: current + (qty > 0 ? qty : 0) })}>
                <Select value={f.locationId} onValueChange={(v) => set("locationId")(v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {active.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {product.serialized ? (
                <Field id="rc-serials" label={t("store.serials")} hint={t("store.serialsHint")}>
                  <Textarea
                    id="rc-serials"
                    rows={5}
                    value={f.serials}
                    onChange={(e) => {
                      set("serials")(e.target.value);
                      setConflicts([]);
                    }}
                    className="font-mono text-sm"
                    placeholder={"SN-0001\nSN-0002"}
                  />
                  <p className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded-full bg-[color:var(--gold)]/15 px-2 py-0.5 font-medium text-primary">{t("store.serialCount", { count: lines.length })}</span>
                    {dupes.length > 0 && <span className="text-destructive">{t("store.serialDupes", { list: [...new Set(dupes)].join(", ") })}</span>}
                    {conflicts.length > 0 && <span className="text-destructive">{t("store.serialTaken", { list: conflicts.join(", ") })}</span>}
                  </p>
                </Field>
              ) : (
                <Field id="rc-qty" label={t("store.qtyReceived")}>
                  <Input id="rc-qty" inputMode="numeric" value={f.quantity} onChange={(e) => set("quantity")(e.target.value)} />
                </Field>
              )}
            </section>

            {/* 2. Where it was bought */}
            <section className="space-y-3 border-t pt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("store.step.purchase")}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="rc-supplier" label={t("store.supplier")}>
                  <Input id="rc-supplier" list="store-suppliers" maxLength={120} value={f.supplier} onChange={(e) => set("supplier")(e.target.value)} placeholder={t("store.supplierHint")} />
                  <datalist id="store-suppliers">
                    {knownSuppliers.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </Field>
                <Field id="rc-ref" label={t("store.reference")}>
                  <Input id="rc-ref" maxLength={120} value={f.reference} onChange={(e) => set("reference")(e.target.value)} placeholder={t("store.referenceHint")} />
                </Field>
                <Field id="rc-date" label={t("store.purchasedAt")}>
                  <Input id="rc-date" type="date" value={f.purchasedAt} onChange={(e) => set("purchasedAt")(e.target.value)} />
                </Field>
                <Field id="rc-cost" label={t("store.unitCost")} hint={cost !== null && qty > 0 ? t("store.purchaseTotal", { total: money(cost * qty) }) : undefined}>
                  <Input id="rc-cost" inputMode="decimal" value={f.cost} onChange={(e) => set("cost")(e.target.value)} />
                </Field>
              </div>
              <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
                <span>
                  {t("store.updateCost")}
                  <span className="block text-[11px] text-muted-foreground">{t("store.updateCostHint", { cost: money(product.costCents) })}</span>
                </span>
                <Switch checked={f.updateCost} onCheckedChange={(v) => set("updateCost")(v)} />
              </label>
              <Field id="rc-note" label={t("store.note")}>
                <Input id="rc-note" maxLength={500} value={f.note} onChange={(e) => set("note")(e.target.value)} />
              </Field>
            </section>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={!valid || save.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
                {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("store.receiveN", { count: qty > 0 ? qty : 0 })}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Count (sets the quantity) — or take serial numbers out (broken, lost, returned…). */
function AdjustDialog({ product, locations, onClose }: { product: Product; locations: Location[]; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const err = useStoreError();
  const active = locations.filter((l) => l.active);
  const [locationId, setLocationId] = useState(product.stock.find((s) => s.quantity > 0)?.locationId ?? active[0]?.id ?? "");
  const current = product.stock.find((s) => s.locationId === locationId)?.quantity ?? 0;
  const [qty, setQty] = useState(String(current));
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const { data: serials } = useQuery({
    queryKey: [...KEY, "serials", product.id],
    queryFn: () => api.get<SerialRow[]>(`/store/products/${product.id}/serials`),
    enabled: product.serialized,
  });
  const here = (serials ?? []).filter((s) => s.status === "in_stock" && s.locationId === locationId);
  const n = Number(qty);
  const valid = product.serialized ? picked.length > 0 && note.trim().length > 0 : qty.trim() !== "" && Number.isInteger(n) && n >= 0;
  const save = useMutation({
    mutationFn: () =>
      api.post(`/store/products/${product.id}/adjust`, product.serialized ? { locationId, removeSerialIds: picked, note: note.trim() } : { locationId, quantity: n, note: note.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["tickets", "store-products"] });
      toast.success(t("common.saved"));
      onClose();
    },
    onError: (e) => toast.error(err(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SlidersHorizontal className="size-5 text-primary" /> {product.serialized ? t("store.removeSerials") : t("store.adjust")}
          </DialogTitle>
          <DialogDescription>{product.name}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (valid) save.mutate();
          }}
        >
          <Field label={t("store.location")}>
            <Select
              value={locationId}
              onValueChange={(v) => {
                setLocationId(v);
                setPicked([]);
                setQty(String(product.stock.find((s) => s.locationId === v)?.quantity ?? 0));
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {active.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {product.serialized ? (
            <Field label={t("store.pickToRemove")}>
              <SerialChecklist serials={here} picked={picked} onChange={setPicked} empty={t("store.noSerialHere")} />
            </Field>
          ) : (
            <Field id="st-qty" label={t("store.qtyCounted")} hint={t("store.wasAt", { count: current })}>
              <Input id="st-qty" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
            </Field>
          )}
          <Field id="st-note" label={product.serialized ? t("store.reason") : t("store.note")}>
            <Input id="st-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={product.serialized ? t("store.reasonHint") : t("store.noteAdjust")} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!valid || save.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
              {save.isPending && <Loader2 className="size-4 animate-spin" />} {product.serialized ? t("store.removeN", { count: picked.length }) : t("common.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type SerialRow = { id: string; serial: string; status: "in_stock" | "used" | "removed"; location: string; locationId: string; ticketNumber: string | null; note: string; supplier: string | null; reference: string | null; updatedAt: string };
type Receipt = { id: string; quantity: number; unitCostCents: number; supplier: string | null; reference: string | null; purchasedAt: string | null; note: string; location: string; user: string | null; createdAt: string };

/** Everything about a product's stock, in three tabs: movements, purchases, serial numbers. */
function HistoryDialog({ product, onClose }: { product: Product; onClose: () => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"moves" | "receipts" | "serials">("moves");
  const { data: moves, isLoading } = useQuery({ queryKey: [...KEY, "movements", product.id], queryFn: () => api.get<Movement[]>(`/store/products/${product.id}/movements`) });
  const { data: receipts } = useQuery({ queryKey: [...KEY, "receipts", product.id], queryFn: () => api.get<Receipt[]>(`/store/products/${product.id}/receipts`), enabled: tab === "receipts" });
  const { data: serials } = useQuery({ queryKey: [...KEY, "serials", product.id], queryFn: () => api.get<SerialRow[]>(`/store/products/${product.id}/serials`), enabled: tab === "serials" });
  const icon = { receive: PackagePlus, adjust: SlidersHorizontal, ticket: PackageMinus } as const;
  const tabs = (["moves", "receipts", ...(product.serialized ? (["serials"] as const) : [])] as const).map((k) => k);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="size-5 text-primary" /> {t("store.history")}
          </DialogTitle>
          <DialogDescription>{product.name}</DialogDescription>
        </DialogHeader>
        <div className="flex gap-1 rounded-xl border p-1 text-xs">
          {tabs.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={cn("flex-1 rounded-lg px-2 py-1.5 font-medium", tab === k ? "bg-grad-gold text-[#1a1204]" : "text-muted-foreground hover:text-foreground")}
            >
              {t(`store.tabs.${k}`)}
            </button>
          ))}
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {tab === "moves" &&
            (isLoading ? (
              <Skeleton className="h-40" />
            ) : !moves?.length ? (
              <p className="text-sm text-muted-foreground">{t("store.noHistory")}</p>
            ) : (
              <ul className="space-y-2">
                {moves.map((m) => {
                  const Icon = icon[m.kind];
                  return (
                    <li key={m.id} className="flex items-start gap-3 rounded-lg border px-3 py-2 text-sm">
                      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block">
                          {t(`store.kind.${m.kind}`)} · {m.location}
                          {m.ticketNumber && <span className="ml-1 font-mono text-xs text-primary">{m.ticketNumber}</span>}
                          {m.supplier && <span className="text-muted-foreground"> · {m.supplier}</span>}
                          {m.reference && <span className="text-muted-foreground"> · {m.reference}</span>}
                        </span>
                        {m.serials.length > 0 && (
                          <span className="mt-1 flex flex-wrap gap-1">
                            {m.serials.map((s) => (
                              <span key={s} className="rounded bg-muted px-1.5 font-mono text-[10px]">
                                {s}
                              </span>
                            ))}
                          </span>
                        )}
                        <span className="block text-[11px] text-muted-foreground">
                          {longDateTime(m.createdAt)}
                          {m.user && ` · ${m.user}`}
                          {m.note && ` · ${m.note}`}
                        </span>
                      </span>
                      <span className={cn("shrink-0 font-mono font-semibold", m.delta > 0 ? "text-emerald-400" : m.delta < 0 ? "text-orange-300" : "text-muted-foreground")}>
                        {m.delta > 0 ? `+${m.delta}` : m.delta}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ))}

          {tab === "receipts" &&
            (!receipts ? (
              <Skeleton className="h-40" />
            ) : !receipts.length ? (
              <p className="text-sm text-muted-foreground">{t("store.noReceipt")}</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="pb-2 font-medium">{t("store.purchasedAt")}</th>
                    <th className="pb-2 font-medium">{t("store.supplier")}</th>
                    <th className="pb-2 font-medium">{t("store.reference")}</th>
                    <th className="pb-2 text-right font-medium">{t("store.qty")}</th>
                    <th className="pb-2 text-right font-medium">{t("store.unitCost")}</th>
                    <th className="pb-2 text-right font-medium">{t("store.total")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {receipts.map((r) => (
                    <tr key={r.id} title={[r.location, r.user, r.note].filter(Boolean).join(" · ")}>
                      <td className="py-1.5">{r.purchasedAt ?? longDateTime(r.createdAt).split(" ")[0]}</td>
                      <td className="py-1.5">{r.supplier ?? "—"}</td>
                      <td className="py-1.5 font-mono text-xs">{r.reference ?? "—"}</td>
                      <td className="py-1.5 text-right">{r.quantity}</td>
                      <td className="py-1.5 text-right">{money(r.unitCostCents)}</td>
                      <td className="py-1.5 text-right font-medium">{money(r.unitCostCents * r.quantity)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}

          {tab === "serials" &&
            (!serials ? (
              <Skeleton className="h-40" />
            ) : (
              <ul className="divide-y rounded-lg border text-sm">
                {serials.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="font-mono">{s.serial}</span>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[10px] font-medium",
                        s.status === "in_stock" ? "bg-emerald-500/15 text-emerald-300" : s.status === "used" ? "bg-sky-500/15 text-sky-300" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {t(`store.serialStatus.${s.status}`)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {s.status === "used" && s.ticketNumber ? <span className="font-mono text-primary">{s.ticketNumber}</span> : s.location}
                      {s.supplier && ` · ${s.supplier}`}
                      {s.note && ` · ${s.note}`}
                    </span>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LocationsDialog({ locations, onClose }: { locations: Location[]; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const err = useStoreError();
  const [name, setName] = useState("");
  const done = () => void qc.invalidateQueries({ queryKey: KEY });
  const add = useMutation({
    mutationFn: () => api.post("/store/locations", { name: name.trim() }),
    onSuccess: () => {
      setName("");
      done();
    },
    onError: (e) => toast.error(err(e)),
  });
  const toggle = useMutation({
    mutationFn: (l: Location) => api.patch(`/store/locations/${l.id}`, { active: !l.active }),
    onSuccess: done,
    onError: (e) => toast.error(err(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={(e) => {
          const el = (e.currentTarget as HTMLElement).querySelector<HTMLInputElement>("#loc-name");
          if (el) {
            e.preventDefault();
            el.focus();
            el.select();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MapPin className="size-5 text-primary" /> {t("store.locations")}
          </DialogTitle>
          <DialogDescription>{t("store.locationsHint")}</DialogDescription>
        </DialogHeader>
        <ul className="space-y-1.5">
          {locations.map((l) => (
            <li key={l.id} className={cn("flex items-center gap-3 rounded-lg border px-3 py-2 text-sm", !l.active && "opacity-60")}>
              <Warehouse className="size-4 text-muted-foreground" />
              <span className="flex-1">{l.name}</span>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                {l.active ? t("store.locationActive") : t("store.locationArchived")}
                <Switch checked={l.active} onCheckedChange={() => toggle.mutate(l)} />
              </label>
            </li>
          ))}
          {locations.length === 0 && <p className="text-sm text-muted-foreground">{t("store.noLocation")}</p>}
        </ul>
        <form
          className="flex gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (name.trim()) add.mutate();
          }}
        >
          <Input id="loc-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={t("store.locationPlaceholder")} />
          <Button type="submit" disabled={!name.trim() || add.isPending}>
            <Plus className="size-4" /> {t("store.add")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
