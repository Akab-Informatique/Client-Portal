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
  autotaskProductId: number | null;
  autotaskProductName: string | null;
  materialCodeId: string | null;
  active: boolean;
  stock: { locationId: string; location: string; quantity: number }[];
  total: number;
  low: boolean;
};
type StoreData = { products: Product[]; locations: Location[]; stats: { active: number; low: number; out: number; valueCents: number; units: number } };
type Movement = { id: string; delta: number; kind: "receive" | "adjust" | "ticket"; note: string; ticketNumber: string | null; createdAt: string; location: string; user: string | null };
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
      {dialog?.kind === "stock" && data && <StockDialog product={dialog.product} mode={dialog.mode} locations={data.locations} onClose={() => setDialog(null)} onLocations={() => setDialog({ kind: "locations" })} />}
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
          {p.autotaskProductId && <span className="shrink-0 rounded border border-sky-500/40 px-1 text-[9px] font-semibold text-sky-300">AUTOTASK</span>}
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
                  <SlidersHorizontal className="size-4" /> {t("store.adjust")}
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

/** Create or edit a product (with its optional link to an Autotask product). */
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
    active: product?.active ?? true,
  });
  const [link, setLink] = useState<{ id: number; name: string } | null>(product?.autotaskProductId ? { id: product.autotaskProductId, name: product.autotaskProductName ?? `#${product.autotaskProductId}` } : null);
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
        autotaskProductId: link?.id ?? null,
        autotaskProductName: link?.name ?? null,
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
          <Field id="sp-desc" label={t("store.fields.description")}>
            <Textarea id="sp-desc" rows={2} maxLength={4000} value={f.description} onChange={(e) => set("description")(e.target.value)} />
          </Field>

          {/* When charged on a ticket in Autotask */}
          <div className="space-y-3 rounded-xl border p-3">
            <p className="text-xs font-medium text-muted-foreground">{t("store.autotaskBlock")}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("store.fields.autotaskProduct")}>
                <AutotaskProductPick value={link} onChange={setLink} />
              </Field>
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

/** Search the Autotask catalogue to link the product (numeric Autotask ids only). */
function AutotaskProductPick({ value, onChange }: { value: { id: number; name: string } | null; onChange: (v: { id: number; name: string } | null) => void }) {
  const { t } = useTranslation();
  const can = useCan();
  const [text, setText] = useState("");
  const q = text.trim();
  const { data, isFetching } = useQuery({
    queryKey: ["tickets", "products", q],
    queryFn: () => api.get<{ id: string; name: string; sku: string | null }[]>(`/tickets/products?q=${encodeURIComponent(q)}`),
    enabled: q.length >= 2 && can("tickets.edit"),
    staleTime: 60_000,
  });
  if (value) {
    return (
      <div className="flex h-9 items-center gap-2 rounded-md border px-3 text-sm">
        <span className="min-w-0 flex-1 truncate">{value.name}</span>
        <button type="button" onClick={() => onChange(null)} className="text-xs text-muted-foreground hover:text-destructive">
          {t("store.unlink")}
        </button>
      </div>
    );
  }
  const results = (data ?? []).filter((p) => /^\d+$/.test(p.id));
  return (
    <div className="relative">
      <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("store.searchAutotask")} />
      {isFetching && <Loader2 className="absolute right-3 top-2.5 size-4 animate-spin text-muted-foreground" />}
      {q.length >= 2 && data && (
        <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border bg-popover shadow-lg">
          {results.length === 0 && <li className="px-3 py-2 text-xs text-muted-foreground">{t("tickets.charges.noProduct")}</li>}
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => {
                  onChange({ id: Number(p.id), name: p.name });
                  setText("");
                }}
                className="block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-accent"
              >
                {p.name} {p.sku && <span className="text-xs text-muted-foreground">· {p.sku}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Receive stock (adds) or count it (sets the quantity) at a location. */
function StockDialog({ product, mode, locations, onClose, onLocations }: { product: Product; mode: "receive" | "adjust"; locations: Location[]; onClose: () => void; onLocations: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const err = useStoreError();
  const active = locations.filter((l) => l.active);
  const [locationId, setLocationId] = useState(active[0]?.id ?? "");
  const current = product.stock.find((s) => s.locationId === locationId)?.quantity ?? 0;
  const [qty, setQty] = useState(mode === "adjust" ? String(current) : "");
  const [note, setNote] = useState("");
  const n = Number(qty);
  const valid = locationId && qty.trim() !== "" && Number.isInteger(n) && n >= 0 && (mode === "adjust" || n > 0);
  const save = useMutation({
    mutationFn: () => api.post(`/store/products/${product.id}/stock`, { locationId, kind: mode, quantity: n, note }),
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
      <DialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={(e) => {
          const el = (e.currentTarget as HTMLElement).querySelector<HTMLInputElement>("#st-qty");
          if (el) {
            e.preventDefault();
            el.focus();
            el.select();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {mode === "receive" ? <PackagePlus className="size-5 text-primary" /> : <SlidersHorizontal className="size-5 text-primary" />}
            {mode === "receive" ? t("store.receive") : t("store.adjust")}
          </DialogTitle>
          <DialogDescription>{product.name}</DialogDescription>
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
            <Field label={t("store.location")}>
              <Select
                value={locationId}
                onValueChange={(v) => {
                  setLocationId(v);
                  if (mode === "adjust") setQty(String(product.stock.find((s) => s.locationId === v)?.quantity ?? 0));
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
            <Field
              id="st-qty"
              label={mode === "receive" ? t("store.qtyReceived") : t("store.qtyCounted")}
              hint={mode === "receive" ? t("store.nowAt", { count: current, after: current + (Number.isInteger(n) ? n : 0) }) : t("store.wasAt", { count: current })}
            >
              <Input id="st-qty" autoFocus inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
            </Field>
            <Field id="st-note" label={t("store.note")}>
              <Input id="st-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={mode === "receive" ? t("store.noteReceive") : t("store.noteAdjust")} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={!valid || save.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
                {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("common.save")}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function HistoryDialog({ product, onClose }: { product: Product; onClose: () => void }) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({ queryKey: [...KEY, "movements", product.id], queryFn: () => api.get<Movement[]>(`/store/products/${product.id}/movements`) });
  const icon = { receive: PackagePlus, adjust: SlidersHorizontal, ticket: PackageMinus } as const;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="size-5 text-primary" /> {t("store.history")}
          </DialogTitle>
          <DialogDescription>{product.name}</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <Skeleton className="h-40" />
        ) : !data?.length ? (
          <p className="text-sm text-muted-foreground">{t("store.noHistory")}</p>
        ) : (
          <ul className="max-h-[60vh] space-y-2 overflow-y-auto">
            {data.map((m) => {
              const Icon = icon[m.kind];
              return (
                <li key={m.id} className="flex items-start gap-3 rounded-lg border px-3 py-2 text-sm">
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block">
                      {t(`store.kind.${m.kind}`)} · {m.location}
                      {m.ticketNumber && <span className="ml-1 font-mono text-xs text-primary">{m.ticketNumber}</span>}
                    </span>
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
        )}
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
