import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  AlertTriangle,
  Building2,
  Calculator,
  Check,
 
  CircleCheck,
  CircleDashed,
  Clock,
  FileX,
  ChevronDown,
  CornerDownRight,
  FileText,
  Loader2,
  Mail,
  Network,
  Pencil,
  Phone,
  Plus,
  Receipt,
  RefreshCw,
  Search,
  Smartphone,
  KeyRound,
  Ticket,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Button } from "@/components/ui/button";
import { AiTextarea } from "@/components/AiPolish";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useConfirm } from "@/components/ConfirmDialog";
import { relativeTime } from "@/lib/format";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ClientStatementDialog, InvoiceMailButtons, InvoicePdfButton } from "@/pages/accounting/Statements";
import { api, ApiError } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { PRIORITY_STYLE, STATUS_STYLE, shortDate, ticketErrorText } from "@/pages/tickets/shared";
import { crmErrorText, money, useCrmClients, type CrmInvoice, type CrmInvoices, type InvoiceStatus, type CrmClient, type CrmContact, type CrmContract, type CrmDetail, type CrmTicket, type InvoiceSettings } from "./shared";
import { ContractWindow, NewContractDialog } from "./ContractDialog";

const TABS = ["info", "tickets", "invoices", "contacts", "contracts", "invoice"] as const;
type Tab = (typeof TABS)[number];

/** One client: info (with its group of companies), tickets, contacts, contracts, invoicing. */
export function ClientPage() {
  const { t } = useTranslation();
  const can = useCan();
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (TABS as readonly string[]).includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "info";
  const { data: client, isLoading, isError } = useQuery({ queryKey: ["crm", "client", id], queryFn: () => api.get<CrmDetail>(`/crm/clients/${id}`) });

  if (isLoading) return <Loader2 className="mx-auto mt-16 size-6 animate-spin text-muted-foreground" />;
  if (isError || !client)
    return (
      <div className="space-y-4">
        <BackLink />
        <p className="text-sm text-muted-foreground">{t("crm.notFound")}</p>
      </div>
    );

  return (
    <div className="relative isolate space-y-5">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <BackLink />
      <div className="flex flex-wrap items-start gap-4">
        <span className="grid size-12 shrink-0 place-items-center rounded-2xl border border-[color:var(--gold)]/30 bg-[color:var(--gold)]/10">
          <Building2 className="size-6 text-primary" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-bold">{client.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {!client.active && <span className="rounded-md border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-red-300">{t("crm.inactiveTag")}</span>}
            {client.parent && (
              <Link to={`/crm/${client.parent.id}`} className="flex items-center gap-1 hover:text-primary">
                <CornerDownRight className="size-3" /> {t("crm.childOf", { name: client.parent.name })}
              </Link>
            )}
            {client.children.length > 0 && (
              <span className="flex items-center gap-1 text-primary">
                <Network className="size-3" /> {t("crm.children", { count: client.children.length })}
              </span>
            )}
            {client.phone && (
              <a href={`tel:${client.phone}`} className="flex items-center gap-1 hover:text-foreground">
                <Phone className="size-3" /> {client.phone}
              </a>
            )}
          </div>
        </div>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => {
          const next = new URLSearchParams(params);
          if (v === "info") next.delete("tab");
          else next.set("tab", v);
          setParams(next, { replace: true });
        }}
      >
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="info">
            <Building2 className="size-4" /> {t("crm.tabs.info")}
          </TabsTrigger>
          <TabsTrigger value="tickets">
            <Ticket className="size-4" /> {t("crm.tabs.tickets")}
          </TabsTrigger>
          {can("accounting.view") && (
            <TabsTrigger value="invoices">
              <Receipt className="size-4" /> {t("crm.tabs.invoices")}
            </TabsTrigger>
          )}
          <TabsTrigger value="contacts">
            <UsersRound className="size-4" /> {t("crm.tabs.contacts")}
          </TabsTrigger>
          <TabsTrigger value="contracts">
            <FileText className="size-4" /> {t("crm.tabs.contracts")}
          </TabsTrigger>
          <TabsTrigger value="invoice">
            <Receipt className="size-4" /> {t("crm.tabs.invoice")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="info" className="mt-4">
          <InfoTab client={client} />
        </TabsContent>
        <TabsContent value="tickets" className="mt-4">
          <TicketsTab client={client} />
        </TabsContent>
        {can("accounting.view") && (
          <TabsContent value="invoices" className="mt-4">
            <InvoicesTab client={client} />
          </TabsContent>
        )}
        <TabsContent value="contacts" className="mt-4">
          <ContactsTab client={client} />
        </TabsContent>
        <TabsContent value="contracts" className="mt-4">
          <ContractsTab client={client} />
        </TabsContent>
        <TabsContent value="invoice" className="mt-4">
          <InvoiceTab client={client} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function BackLink() {
  const { t } = useTranslation();
  return (
    <Link to="/crm" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-4" /> {t("crm.back")}
    </Link>
  );
}

function Card({ title, icon, children, aside }: { title: string; icon: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="glass space-y-4 rounded-2xl border p-4">
      <div className="flex items-center gap-2">
        <span className="text-primary">{icon}</span>
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="ml-auto">{aside}</div>
      </div>
      {children}
    </section>
  );
}

function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

const useSaved = (clientId: string) => {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["crm", "client", clientId] });
    void qc.invalidateQueries({ queryKey: ["crm", "clients"] });
  };
};

// ── Info ──
function InfoTab({ client }: { client: CrmDetail }) {
  const { t } = useTranslation();
  const can = useCan();
  const editable = can("crm.edit");
  const saved = useSaved(client.id);
  const pick = (c: CrmClient) => ({
    name: c.name,
    phone: c.phone ?? "",
    email: c.email ?? "",
    website: c.website ?? "",
    address: c.address ?? "",
    city: c.city ?? "",
    province: c.province ?? "",
    postalCode: c.postalCode ?? "",
    code: c.code ?? "",
    notes: c.notes ?? "",
    classKey: c.classKey ?? "",
  });
  const [f, setF] = useState(() => pick(client));
  const { data: classes = [] } = useQuery({ queryKey: ["admin", "client-classes"], queryFn: () => api.get<{ key: string; name: string }[]>("/admin/client-classes") });
  useEffect(() => setF(pick(client)), [client]);
  const dirty = JSON.stringify(f) !== JSON.stringify(pick(client));
  const save = useMutation({
    mutationFn: (p: Record<string, unknown>) => api.patch<CrmClient>(`/crm/clients/${client.id}`, p),
    onSuccess: () => {
      saved();
      toast.success(t("crm.info.saved"));
    },
    onError: (e) => toast.error(crmErrorText(t, e) ?? ticketErrorText(t, e)),
  });
  const input = (k: keyof typeof f, type = "text") => <Input type={type} value={f[k]} disabled={!editable} onChange={(e) => setF({ ...f, [k]: e.target.value })} className="h-9" />;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <Card title={t("crm.info.details")} icon={<Building2 className="size-4" />}>
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            save.mutate({ ...f, classKey: f.classKey || null });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("crm.name")} className="sm:col-span-2">
              <Input required minLength={2} value={f.name} disabled={!editable} onChange={(e) => setF({ ...f, name: e.target.value })} className="h-9" />
            </Field>
            <Field label={t("crm.info.class")} className="sm:col-span-2">
              <select
                value={f.classKey}
                disabled={!editable}
                onChange={(e) => setF({ ...f, classKey: e.target.value })}
                className="h-9 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-[color:var(--gold)]/40 disabled:opacity-60"
              >
                <option value="">{t("crm.info.classNone")}</option>
                {classes.map((k) => (
                  <option key={k.key} value={k.key}>
                    {k.name}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground">{t("crm.info.classHint")}</p>
            </Field>
            <Field label={t("crm.phone")}>{input("phone", "tel")}</Field>
            <Field label={t("crm.info.email")}>{input("email", "email")}</Field>
            <Field label={t("crm.info.address")} className="sm:col-span-2">
              {input("address")}
            </Field>
            <Field label={t("crm.info.city")}>{input("city")}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("crm.info.province")}>{input("province")}</Field>
              <Field label={t("crm.info.postalCode")}>{input("postalCode")}</Field>
            </div>
            <Field label={t("crm.info.website")}>{input("website")}</Field>
            <Field label={t("crm.info.code")}>{input("code")}</Field>
            <Field label={t("crm.info.notes")} className="sm:col-span-2">
              <AiTextarea rows={3} value={f.notes} disabled={!editable} onChange={(e) => setF({ ...f, notes: e.target.value })} />
              <p className="text-[11px] text-muted-foreground">{t("crm.info.notesHint")}</p>
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <p className="flex-1 text-[11px] text-muted-foreground">{editable ? "" : t("crm.info.readOnly")}</p>
            {editable && (
              <Button type="submit" disabled={!dirty || save.isPending} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
                {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("crm.info.save")}
              </Button>
            )}
          </div>
        </form>
      </Card>

      <Card title={t("crm.info.group")} icon={<Network className="size-4" />}>
        <Field label={t("crm.info.parent")}>
          <ParentPicker client={client} disabled={!editable || save.isPending} onChange={(parentId) => save.mutate({ parentId })} />
        </Field>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">{t("crm.info.children")}</Label>
          {client.children.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("crm.info.noChildren")}</p>
          ) : (
            <ul className="space-y-1">
              {client.children.map((c) => (
                <li key={c.id}>
                  <Link to={`/crm/${c.id}`} className={cn("flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm hover:border-[color:var(--gold)]/40 hover:bg-accent/40", !c.active && "opacity-60")}>
                    <CornerDownRight className="size-3.5 text-muted-foreground" /> {c.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}

/** The parent company: any other client, not one of its own subsidiaries. */
function ParentPicker({ client, disabled, onChange }: { client: CrmDetail; disabled: boolean; onChange: (id: string | null) => void }) {
  const { t } = useTranslation();
  const { data: all = [] } = useCrmClients();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  // its own subsidiaries (any depth) cannot become its parent
  const below = new Set<string>();
  const walk = (id: string) => all.filter((c) => c.parentId === id && !below.has(c.id)).forEach((c) => (below.add(c.id), walk(c.id)));
  walk(client.id);
  const shown = all.filter((c) => c.id !== client.id && !below.has(c.id) && c.active && c.name.toLowerCase().includes(q.toLowerCase())).slice(0, 200);
  return (
    <Popover
      modal
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ("");
      }}
    >
      <PopoverTrigger asChild disabled={disabled}>
        <button type="button" className="flex h-9 w-full items-center gap-2 rounded-md border bg-transparent px-3 text-left text-sm outline-none ring-[color:var(--gold)]/40 hover:ring-2 disabled:opacity-60 disabled:hover:ring-0 dark:bg-input/30">
          <span className={cn("min-w-0 flex-1 truncate", !client.parent && "text-muted-foreground")}>{client.parent?.name ?? t("crm.info.noParent")}</span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-1.5">
        <div className="relative mb-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("crm.info.pickParent")} className="h-8 pl-8" />
        </div>
        <div className="max-h-64 overflow-y-auto">
          {client.parent && (
            <button
              type="button"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent"
            >
              <X className="size-4" /> {t("crm.info.noParent")}
            </button>
          )}
          {shown.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                onChange(c.id);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
            >
              <Building2 className="size-4 text-muted-foreground" />
              <span className="flex-1 truncate">{c.name}</span>
              {client.parentId === c.id && <Check className="size-4 text-primary" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Tickets ──
function TicketsTab({ client }: { client: CrmDetail }) {
  const { t } = useTranslation();
  const can = useCan();
  const [withChildren, setWithChildren] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["crm", "client", client.id, "tickets", withChildren],
    queryFn: () => api.get<{ open: number; closed: number; items: CrmTicket[] }>(`/crm/clients/${client.id}/tickets${withChildren ? "?children=1" : ""}`),
    enabled: can("tickets.view"),
    refetchInterval: 60_000,
  });
  return (
    <Card
      title={data ? `${t("crm.tickets.open", { count: data.open })}` : t("crm.tabs.tickets")}
      icon={<Ticket className="size-4" />}
      aside={
        client.children.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={withChildren} onCheckedChange={setWithChildren} /> {t("crm.tickets.withChildren")}
          </label>
        )
      }
    >
      {isLoading && <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />}
      {data && data.items.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{t("crm.tickets.none")}</p>}
      {data && data.items.length > 0 && (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border">
          {data.items.map((x) => (
            <li key={x.id}>
              <Link to={`/tickets?ticket=${x.id}`} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 hover:bg-accent/40", x.statusKind === "complete" && "opacity-60")}>
                <span className={cn("size-2 shrink-0 rounded-full", PRIORITY_STYLE[x.priorityKind].dot)} title={x.priorityLabel ?? undefined} />
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{x.number}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{x.title}</span>
                {withChildren && x.company !== client.name && <span className="truncate text-xs text-muted-foreground">{x.company}</span>}
                <span className={cn("shrink-0 rounded-md border px-1.5 py-0.5 text-[11px]", STATUS_STYLE[x.statusKind])}>{x.statusLabel ?? t(`tickets.status.${x.statusKind}`)}</span>
                <span className="w-28 shrink-0 truncate text-xs text-muted-foreground">{x.assignee ?? t("crm.tickets.unassigned")}</span>
                <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">{shortDate(x.dueAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {data && data.closed > 0 && <p className="text-[11px] text-muted-foreground">{t("crm.tickets.closed", { count: data.closed })}</p>}
    </Card>
  );
}

// ── Invoices ──
type InvoiceFilter = "all" | "unpaid" | "overdue" | "paid";
const INVOICE_STYLE: Record<InvoiceStatus, string> = {
  paid: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  partial: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  due: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  overdue: "border-red-500/50 bg-red-500/15 text-red-300",
  voided: "border-slate-500/40 bg-slate-500/10 text-slate-400",
};
const INVOICE_ICON = { paid: CircleCheck, partial: CircleDashed, due: Clock, overdue: AlertTriangle, voided: FileX } as const;
const inFilter = (v: CrmInvoice, f: InvoiceFilter) => (f === "all" ? true : f === "unpaid" ? v.balanceCents > 0 : f === "overdue" ? v.late : v.status === "paid");

function InvoicesTab({ client }: { client: CrmDetail }) {
  const { t, i18n } = useTranslation();
  const [withChildren, setWithChildren] = useState(false);
  // what is unpaid first
  const [filter, setFilter] = useState<InvoiceFilter>("unpaid");
  const [statement, setStatement] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["crm", "client", client.id, "invoices", withChildren],
    queryFn: () => api.get<CrmInvoices>(`/crm/clients/${client.id}/invoices${withChildren ? "?children=1" : ""}`),
  });
  const m = (c: number) => money(c, i18n.language);
  // newest invoice number on top
  const newest = (a: CrmInvoice, b: CrmInvoice) => b.number.localeCompare(a.number, undefined, { numeric: true });
  const items = (data?.items ?? []).filter((v) => inFilter(v, filter)).sort(newest);
  return (
    <div className="space-y-4">
      {data && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat
            label={t("crm.invoices.balance")}
            value={m(data.summary.dueCents)}
            hint={data.summary.partialCount ? t("crm.invoices.partialCount", { count: data.summary.partialCount }) : undefined}
            icon={<CircleDashed className="size-4" />}
          />
          <Stat
            label={t("crm.invoices.overdue")}
            value={m(data.summary.overdueCents)}
            hint={data.summary.overdueCount ? t("crm.invoices.overdueCount", { count: data.summary.overdueCount }) : undefined}
            icon={<AlertTriangle className="size-4" />}
            alert={data.summary.overdueCount > 0}
          />
          <Stat label={t("crm.invoices.paidYear")} value={m(data.summary.paidYearCents)} icon={<CircleCheck className="size-4" />} />
        </div>
      )}
      <Card
        title={t("crm.tabs.invoices")}
        icon={<Receipt className="size-4" />}
        aside={
          <span className="flex flex-wrap items-center gap-3">
            {client.children.length > 0 && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={withChildren} onCheckedChange={setWithChildren} /> {t("crm.tickets.withChildren")}
              </label>
            )}
            <Button type="button" size="sm" variant="outline" onClick={() => setStatement(true)}>
              <FileText className="size-3.5" /> {t("statements.title")}
            </Button>
          </span>
        }
      >
        <div className="flex flex-wrap gap-1">
          {(["unpaid", "overdue", "paid", "all"] as InvoiceFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors",
                filter === f ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              {t(`crm.invoices.filter.${f}`)}
              <span className="font-mono text-[10px] text-muted-foreground">{(data?.items ?? []).filter((v) => inFilter(v, f)).length}</span>
            </button>
          ))}
        </div>
        {isLoading && <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />}
        {data && items.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{t("crm.invoices.none")}</p>}
        {items.length > 0 && (
          <div className="overflow-hidden rounded-xl border">
            <div className="hidden grid-cols-[minmax(0,1.1fr)_100px_minmax(0,1.3fr)_120px_120px_minmax(0,1.3fr)] gap-3 border-b bg-background/30 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground md:grid">
              <span>{t("crm.invoices.number")}</span>
              <span>{t("crm.invoices.issued")}</span>
              <span>{t("crm.invoices.due")}</span>
              <span className="text-right">{t("crm.invoices.amount")}</span>
              <span className="text-right">{t("crm.invoices.balanceCol")}</span>
              <span>{t("crm.invoices.status")}</span>
            </div>
            <ul className="divide-y divide-border/60">
              {items.map((v) => {
                const Icon = INVOICE_ICON[v.status];
                const expanded = open === v.id;
                return (
                  <li key={v.id} className={cn("relative", v.status === "voided" && "opacity-60")}>
                    <span className="absolute right-1 top-2 z-10">
                      <InvoicePdfButton invoice={v} compact />
                    </span>
                    <button
                      type="button"
                      onClick={() => setOpen(expanded ? null : v.id)}
                      aria-expanded={expanded}
                      className="grid w-full grid-cols-2 gap-x-3 gap-y-1 py-2.5 pl-3 pr-10 text-left text-sm transition-colors hover:bg-accent/30 md:grid-cols-[minmax(0,1.1fr)_100px_minmax(0,1.3fr)_120px_120px_minmax(0,1.3fr)] md:items-center"
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !expanded && "-rotate-90")} />
                        <span className="min-w-0">
                          <span className="block truncate font-mono text-xs">{v.number}</span>
                          {withChildren && v.company !== client.name && <span className="block truncate text-[11px] text-muted-foreground">{v.company}</span>}
                        </span>
                      </span>
                      <span className="text-xs text-muted-foreground">{shortDate(v.issuedOn)}</span>
                      <span className={cn("text-xs", v.late ? "font-medium text-red-300" : "text-muted-foreground")}>
                        {v.dueOn ? shortDate(v.dueOn) : "—"}
                        {v.late && <span className="ml-1.5">· {t("crm.invoices.late", { count: v.daysLate })}</span>}
                      </span>
                      <span className={cn("font-mono md:text-right", v.status === "voided" && "line-through")}>{m(v.totalCents)}</span>
                      <span className={cn("font-mono md:text-right", v.balanceCents > 0 ? "text-foreground" : "text-muted-foreground")}>{v.status === "voided" ? "—" : m(v.balanceCents)}</span>
                      <span>
                        <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]", INVOICE_STYLE[v.status])}>
                          <Icon className="size-3" />
                          {v.status === "paid" && v.paidOn ? t("crm.invoices.paidOn", { date: shortDate(v.paidOn) }) : t(`crm.invoices.state.${v.status}`)}
                        </span>
                      </span>
                    </button>
                    {expanded && (
                      <div className="flex flex-wrap items-center gap-2 px-3 pb-1">
                        <InvoiceMailButtons invoice={v} />
                        <FixTaxesButton invoice={v} />
                      </div>
                    )}
                    {expanded && <Payments invoice={v} clientId={client.id} />}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Card>
      {statement && <ClientStatementDialog clientId={client.id} onClose={() => setStatement(false)} />}
    </div>
  );
}

/** When an invoice's taxes are a cent out of QuickBooks: puts them on the line-by-line rounding and sends the invoice again */
function FixTaxesButton({ invoice: v }: { invoice: CrmInvoice }) {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const fix = useMutation({
    mutationFn: () => api.post<{ after: { totalCents: number }; sentToQuickBooks: boolean }>(`/crm/invoices/${v.id}/taxes`),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["crm"] });
      toast.success(t("crm.invoices.taxesFixed", { total: money(r.after.totalCents, i18n.language), qb: r.sentToQuickBooks ? t("crm.invoices.taxesFixedQb") : "" }));
    },
    onError: () => toast.error(t("common.error")),
  });
  if (!v.taxFixCents || !can("accounting.manage")) return null;
  const diff = money(Math.abs(v.taxFixCents), i18n.language);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-7 text-xs"
      disabled={fix.isPending}
      onClick={() =>
        void confirm({
          title: t("crm.invoices.taxesFixTitle", { number: v.number }),
          description: t("crm.invoices.taxesFixText", { diff: `${v.taxFixCents! > 0 ? "+" : "−"}${diff}`, total: money(v.totalCents + v.taxFixCents!, i18n.language) }),
        }).then((ok) => ok && fix.mutate())
      }
    >
      {fix.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Calculator className="size-3.5" />} {t("crm.invoices.taxesFix", { diff: `${v.taxFixCents > 0 ? "+" : "−"}${diff}` })}
    </Button>
  );
}

const METHODS = ["transfer", "cheque", "card", "cash", "stripe", "other"] as const;

/** Where the invoice is in QuickBooks; send it (or its changes) by hand. */
function QuickBooksLine({ invoice: v, clientId }: { invoice: CrmInvoice; clientId: string }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const send = useMutation({
    mutationFn: () => api.post<{ quickbooksId: string }>(`/crm/invoices/${v.id}/quickbooks`),
    onSuccess: () => toast.success(t("crm.invoices.qb.sent")),
    onError: (e) => {
      const code = e instanceof ApiError ? e.code : "";
      toast.error(t(`crm.invoices.qb.errors.${code}`, { defaultValue: t("crm.invoices.qb.failed") }));
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["crm", "client", clientId, "invoices"] }),
  });
  if (!v.quickbooks && !can("accounting.manage")) return null;
  const qb = v.quickbooks;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="font-medium">QuickBooks</span>
      {qb?.id ? (
        <span className="flex items-center gap-1 text-emerald-300">
          <CircleCheck className="size-3.5" /> {t("crm.invoices.qb.inQb", { id: qb.id })}
          {qb.syncedAt && <span className="text-muted-foreground">· {t("crm.invoices.qb.syncedAt", { when: relativeTime(qb.syncedAt) })}</span>}
        </span>
      ) : (
        <span className="text-muted-foreground">{t("crm.invoices.qb.notSent")}</span>
      )}
      {qb?.error && (
        <span className="flex items-center gap-1 text-red-300" title={qb.error}>
          <AlertTriangle className="size-3.5" /> {t(`crm.invoices.qb.errors.quickbooks_${qb.error.split(":")[0]}`, { defaultValue: qb.error })}
        </span>
      )}
      {can("accounting.manage") && v.status !== "voided" && (
        <Button size="sm" variant="outline" className="ml-auto h-7 text-xs" disabled={send.isPending} onClick={() => send.mutate()}>
          {send.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} {qb?.id ? t("crm.invoices.qb.resend") : t("crm.invoices.qb.send")}
        </Button>
      )}
    </div>
  );
}

/** The payments of one invoice; a new one (all or part of the balance). */
function Payments({ invoice: v, clientId }: { invoice: CrmInvoice; clientId: string }) {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const m = (c: number) => money(c, i18n.language);
  const today = new Date().toLocaleDateString("en-CA");
  const [f, setF] = useState({ amount: (v.balanceCents / 100).toFixed(2), paidOn: today, method: "transfer" as (typeof METHODS)[number], reference: "", note: "" });
  // what is left to pay, once a payment is in
  useEffect(() => setF((x) => ({ ...x, amount: (v.balanceCents / 100).toFixed(2), reference: "" })), [v.balanceCents]);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["crm", "client", clientId, "invoices"] });
  const add = useMutation({
    mutationFn: () => api.post(`/crm/invoices/${v.id}/payments`, { amountCents: Math.round(Number(f.amount.replace(",", ".")) * 100), paidOn: f.paidOn, method: f.method, reference: f.reference, note: f.note }),
    onSuccess: () => {
      toast.success(t("crm.invoices.payment.added"));
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError && e.code === "payment_too_much" ? t("crm.invoices.payment.tooMuch") : t("common.error")),
  });
  const remove = useMutation({ mutationFn: (pid: string) => api.del(`/crm/invoices/${v.id}/payments/${pid}`), onSuccess: refresh });
  return (
    <div className="space-y-3 border-t border-dashed bg-background/30 px-4 py-3">
      {(v.poNumber || v.notes) && (
        <p className="text-xs text-muted-foreground">
          {v.poNumber && <span className="mr-3">PO : <span className="font-mono text-foreground">{v.poNumber}</span></span>}
          {v.notes && <span className="whitespace-pre-line">{v.notes}</span>}
        </p>
      )}
      {v.lines.length > 0 && (
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="pb-1 text-left font-medium">{t("crm.invoices.lines.description")}</th>
              <th className="pb-1 text-right font-medium">{t("crm.invoices.lines.qty")}</th>
              <th className="pb-1 text-right font-medium">{t("crm.invoices.lines.rate")}</th>
              <th className="pb-1 text-right font-medium">{t("crm.invoices.lines.amount")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {v.lines.map((l) => (
              <tr key={l.id}>
                <td className="py-1 pr-2">{l.description}</td>
                <td className="py-1 text-right font-mono">{l.quantity}</td>
                <td className="py-1 text-right font-mono text-muted-foreground">{m(l.unitPriceCents)}</td>
                <td className="py-1 text-right font-mono">{m(l.amountCents)}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={3} className="pt-1.5 text-right text-muted-foreground">
                {t("crm.invoices.lines.taxes")}
              </td>
              <td className="pt-1.5 text-right font-mono text-muted-foreground">{m(v.taxCents)}</td>
            </tr>
          </tbody>
        </table>
      )}
      {v.payments.length > 0 ? (
        <ul className="space-y-1">
          {v.payments.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
              <CircleCheck className="size-3.5 text-emerald-400" />
              <span className="font-mono">{m(p.amountCents)}</span>
              <span className="text-muted-foreground">{shortDate(p.paidOn)}</span>
              <span className="text-muted-foreground">{t(`crm.invoices.payment.methods.${p.method}`)}</span>
              {p.reference && <span className="text-muted-foreground">· {p.reference}</span>}
              {p.source === "quickbooks" && <span className="rounded border border-emerald-500/30 px-1 text-[10px] text-emerald-300">QuickBooks</span>}
              {p.by && <span className="text-[11px] text-muted-foreground/70">· {p.by}</span>}
              {can("accounting.manage") && p.source === "portal" && (
                <button type="button" onClick={() => remove.mutate(p.id)} className="ml-auto rounded p-0.5 text-muted-foreground hover:text-destructive" aria-label={t("crm.invoices.payment.remove")} title={t("crm.invoices.payment.remove")}>
                  <X className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{v.paidOn ? t("crm.invoices.payment.paidInSource", { date: shortDate(v.paidOn) }) : t("crm.invoices.payment.none")}</p>
      )}
      <QuickBooksLine invoice={v} clientId={clientId} />
      {can("accounting.manage") && v.balanceCents > 0 && v.status !== "voided" && (
        <form
          className="grid gap-2 sm:grid-cols-[120px_140px_140px_minmax(0,1fr)_auto] sm:items-end"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <Field label={t("crm.invoices.payment.amount")}>
            <Input required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} className="h-8 font-mono" />
          </Field>
          <Field label={t("crm.invoices.payment.date")}>
            <Input required type="date" value={f.paidOn} onChange={(e) => setF({ ...f, paidOn: e.target.value })} className="h-8" />
          </Field>
          <Field label={t("crm.invoices.payment.method")}>
            <Select value={f.method} onValueChange={(x) => setF({ ...f, method: x as (typeof METHODS)[number] })}>
              <SelectTrigger className="h-8 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METHODS.map((x) => (
                  <SelectItem key={x} value={x}>
                    {t(`crm.invoices.payment.methods.${x}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("crm.invoices.payment.reference")}>
            <Input value={f.reference} maxLength={100} onChange={(e) => setF({ ...f, reference: e.target.value })} className="h-8" />
          </Field>
          <Button type="submit" size="sm" disabled={add.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
            {add.isPending && <Loader2 className="size-3.5 animate-spin" />} {t("crm.invoices.payment.add")}
          </Button>
        </form>
      )}
    </div>
  );
}

function Stat({ label, value, hint, icon, alert }: { label: string; value: string; hint?: string; icon: ReactNode; alert?: boolean }) {
  return (
    <div className={cn("glass rounded-2xl border p-4", alert && "border-red-500/40")}>
      <p className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", alert && "text-red-300")}>
        {icon} {label}
      </p>
      <p className="mt-1 font-mono text-xl font-semibold">{value}</p>
      {hint && <p className={cn("text-[11px]", alert ? "text-red-300" : "text-muted-foreground")}>{hint}</p>}
    </div>
  );
}

// ── Contacts ──
const emptyContact = { firstName: "", lastName: "", email: "", phone: "", mobile: "", title: "" };

function ContactsTab({ client }: { client: CrmDetail }) {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const editable = can("crm.edit");
  const key = ["crm", "client", client.id, "contacts"];
  const { data: contacts = [], isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<CrmContact[]>(`/crm/clients/${client.id}/contacts`) });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ["crm", "clients"] });
    void qc.invalidateQueries({ queryKey: ["tickets", "contacts"] });
  };
  const inactive = contacts.filter((c) => !c.active);
  const shown = contacts.filter((c) => c.active || showInactive);
  const toggle = useMutation({
    mutationFn: (c: CrmContact) => api.patch(`/crm/clients/${client.id}/contacts/${c.id}`, { active: !c.active }),
    onSuccess: () => {
      refresh();
      toast.success(t("crm.contacts.saved"));
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });

  return (
    <Card
      title={t("crm.tabs.contacts")}
      icon={<UsersRound className="size-4" />}
      aside={
        editable &&
        !adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" /> {t("crm.contacts.new")}
          </Button>
        )
      }
    >
      {adding && (
        <ContactForm
          clientId={client.id}
          onDone={() => {
            setAdding(false);
            refresh();
          }}
        />
      )}
      {isLoading && <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />}
      {!isLoading && shown.length === 0 && !adding && <p className="py-6 text-center text-sm text-muted-foreground">{t("crm.contacts.none")}</p>}
      <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((c) =>
          editing === c.id ? (
            <li key={c.id} className="md:col-span-2 xl:col-span-3">
              <ContactForm
                clientId={client.id}
                contact={c}
                onDone={() => {
                  setEditing(null);
                  refresh();
                }}
              />
            </li>
          ) : (
            <li key={c.id} className={cn("group rounded-xl border bg-background/30 p-3", !c.active && "opacity-60")}>
              <div className="flex items-start gap-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-full border bg-card">
                  <UserRound className="size-4 text-muted-foreground" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {c.firstName} {c.lastName}
                    {!c.active && <span className="ml-2 text-[10px] font-normal text-muted-foreground">{t("crm.contacts.inactive")}</span>}
                  </p>
                  {c.title && <p className="truncate text-xs text-muted-foreground">{c.title}</p>}
                  <div className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
                    {c.email && (
                      <a href={`mailto:${c.email}`} className="flex items-center gap-1.5 truncate hover:text-foreground">
                        <Mail className="size-3 shrink-0" /> {c.email}
                      </a>
                    )}
                    {c.phone && (
                      <a href={`tel:${c.phone}`} className="flex items-center gap-1.5 hover:text-foreground">
                        <Phone className="size-3 shrink-0" /> {c.phone}
                      </a>
                    )}
                    {c.mobile && (
                      <a href={`tel:${c.mobile}`} className="flex items-center gap-1.5 hover:text-foreground">
                        <Smartphone className="size-3 shrink-0" /> {c.mobile}
                      </a>
                    )}
                  </div>
                  <PortalAccess clientId={client.id} contact={c} onChange={refresh} />
                </div>
                {editable && (
                  <div className="flex shrink-0 flex-col items-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <button type="button" onClick={() => setEditing(c.id)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={t("crm.contacts.edit")} title={t("crm.contacts.edit")}>
                      <Pencil className="size-3.5" />
                    </button>
                    <button type="button" onClick={() => toggle.mutate(c)} className="rounded px-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground">
                      {c.active ? t("crm.contacts.deactivate") : t("crm.contacts.reactivate")}
                    </button>
                  </div>
                )}
              </div>
            </li>
          ),
        )}
      </ul>
      {inactive.length > 0 && !showInactive && (
        <button type="button" onClick={() => setShowInactive(true)} className="text-xs text-muted-foreground hover:text-foreground">
          {t("crm.contacts.showInactive", { count: inactive.length })}
        </button>
      )}
    </Card>
  );
}

/** Client portal access: none by default; given by an admin (account + welcome email), or removed. */
function PortalAccess({ clientId, contact: c, onChange }: { clientId: string; contact: CrmContact; onChange: () => void }) {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const confirm = useConfirm();
  const set = useMutation({
    mutationFn: (p: { enabled: boolean; role?: string }) => api.put<{ enabled: boolean; welcomeSent?: boolean }>(`/crm/clients/${clientId}/contacts/${c.id}/portal`, p),
    onSuccess: (r) => {
      onChange();
      if (!r.enabled) toast.success(t("crm.portal.removed"));
      else if (r.welcomeSent) toast.success(t("crm.portal.given", { email: c.email }));
      else toast.warning(t("crm.portal.givenNoEmail"));
    },
    onError: (e) => toast.error(e instanceof ApiError && ["portal_no_email", "email_taken", "portal_inactive"].includes(e.code) ? t(`crm.portal.errors.${e.code}`) : t("common.error")),
  });
  const manage = can("admin.clients") && c.active;
  const give = async (role: string) => {
    if (await confirm({ title: t("crm.portal.giveTitle", { name: `${c.firstName} ${c.lastName}` }), description: t("crm.portal.giveText", { email: c.email ?? "—" }), confirmLabel: t("crm.portal.give") }))
      set.mutate({ enabled: true, role });
  };
  if (!c.portal && !manage) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {c.portal ? (
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px]",
            c.portal.pending ? "border-amber-500/40 bg-amber-500/10 text-amber-300" : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
          )}
          title={c.portal.lastLoginAt ? t("crm.portal.lastLogin", { when: relativeTime(c.portal.lastLoginAt) }) : undefined}
        >
          <KeyRound className="size-3" />
          {c.portal.pending ? t("crm.portal.pending") : t("crm.portal.on")}
          {c.portal.role === "client-admin" && <span className="opacity-80">· {t("crm.portal.admin")}</span>}
        </span>
      ) : (
        <span className="text-[10px] text-muted-foreground/70">{t("crm.portal.none")}</span>
      )}
      {manage && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" disabled={set.isPending} className="rounded px-1 text-[10px] text-primary hover:bg-accent">
              {set.isPending ? <Loader2 className="size-3 animate-spin" /> : c.portal ? t("crm.portal.manage") : t("crm.portal.give")}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64" lang={i18n.language}>
            <DropdownMenuLabel className="text-xs">{t("crm.portal.title")}</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => void give("client-user")}>{c.portal ? t("crm.portal.resendUser") : t("crm.portal.asUser")}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void give("client-admin")}>{c.portal ? t("crm.portal.resendAdmin") : t("crm.portal.asAdmin")}</DropdownMenuItem>
            {c.portal && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive"
                  onSelect={async () => {
                    if (await confirm({ title: t("crm.portal.removeTitle"), description: t("crm.portal.removeText"), confirmLabel: t("crm.portal.remove"), destructive: true })) set.mutate({ enabled: false });
                  }}
                >
                  {t("crm.portal.remove")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function ContactForm({ clientId, contact, onDone }: { clientId: string; contact?: CrmContact; onDone: () => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState(() =>
    contact ? { firstName: contact.firstName, lastName: contact.lastName, email: contact.email ?? "", phone: contact.phone ?? "", mobile: contact.mobile ?? "", title: contact.title ?? "" } : emptyContact,
  );
  const save = useMutation({
    mutationFn: () => (contact ? api.patch(`/crm/clients/${clientId}/contacts/${contact.id}`, f) : api.post(`/crm/clients/${clientId}/contacts`, f)),
    onSuccess: () => {
      toast.success(t(contact ? "crm.contacts.saved" : "crm.contacts.added"));
      onDone();
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
  const box = (k: keyof typeof f, label: string, type = "text", required = false) => (
    <Field label={label}>
      <Input type={type} required={required} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} className="h-8" />
    </Field>
  );
  return (
    <form
      className="space-y-3 rounded-xl border border-[color:var(--gold)]/30 bg-[color:var(--gold)]/[0.04] p-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-2 sm:grid-cols-3">
        {box("firstName", t("crm.contacts.firstName"), "text", true)}
        {box("lastName", t("crm.contacts.lastName"), "text", true)}
        {box("title", t("crm.contacts.title"))}
        {box("email", t("crm.contacts.email"), "email")}
        {box("phone", t("crm.contacts.phone"), "tel")}
        {box("mobile", t("crm.contacts.mobile"), "tel")}
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={save.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
          {save.isPending && <Loader2 className="size-3.5 animate-spin" />} {contact ? t("crm.info.save") : t("crm.contacts.add")}
        </Button>
      </div>
    </form>
  );
}

// ── Contracts ──
/** The client's contracts: a list with what each charges; making or opening one is a window of its own (ContractDialog). */
function ContractsTab({ client }: { client: CrmDetail }) {
  const { t, i18n } = useTranslation();
  const can = useCan();
  const { data: contracts = [], isLoading } = useQuery({ queryKey: ["crm", "client", client.id, "contracts"], queryFn: () => api.get<CrmContract[]>(`/crm/clients/${client.id}/contracts`) });
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <Card
      title={t("crm.tabs.contracts")}
      icon={<FileText className="size-4" />}
      aside={
        can("crm.billing") ? (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" /> {t("crm.contracts.new")}
          </Button>
        ) : undefined
      }
    >
      {adding && <NewContractDialog client={client} onClose={() => setAdding(false)} />}
      {openId && <ContractWindow client={client} contractId={openId} onClose={() => setOpenId(null)} />}
      {isLoading && <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />}
      {!isLoading && contracts.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">{t("crm.contracts.none")}</p>}
      {contracts.length > 0 && (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border">
          {contracts.map((k) => (
            <li key={k.id}>
              <button type="button" onClick={() => setOpenId(k.id)} className={cn("flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 text-left transition-colors hover:bg-accent/40", !k.active && "opacity-60")}>
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{k.name}</span>
                {k.isSupportDefault && <span className="rounded-md border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">{t("crm.contracts.supportDefault")}</span>}
                {!k.active && <span className="text-[11px] text-muted-foreground">{k.endedOn ? t("crm.contracts.window.stoppedOn", { date: shortDate(k.endedOn) }) : t("crm.contracts.inactive")}</span>}
                <span className="w-32 truncate text-xs text-muted-foreground">{k.type ?? "—"}</span>
                <span className="w-44 text-xs text-muted-foreground">
                  {k.startDate ? shortDate(k.startDate) : "…"} → {k.endDate ? shortDate(k.endDate) : t("crm.contracts.noEnd")}
                </span>
                {k.summary && (k.serviceCount ?? 0) > 0 ? (
                  <span className="w-48 text-right text-xs">
                    <span className="block font-mono font-semibold">
                      {money(k.summary.perPeriodCents, i18n.language)} <span className="font-sans font-normal text-muted-foreground">{k.billingPeriod === "yearly" ? t("services.perYear") : t("services.perMonth")}</span>
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {t("crm.contracts.window.revenue")} {money(k.summary.revenueCents, i18n.language)}
                    </span>
                  </span>
                ) : (
                  <span className="w-48 text-right text-[11px] text-muted-foreground">{t("crm.contracts.window.noLinesShort")}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ── Invoicing ──
function InvoiceTab({ client }: { client: CrmDetail }) {
  const { t } = useTranslation();
  const saved = useSaved(client.id);
  const pick = (s: InvoiceSettings | null) => ({
    billingEmail: s?.billingEmail ?? "",
    termsDays: s?.termsDays ?? 30,
    delivery: s?.delivery ?? ("email" as const),
    taxes: s?.taxes ?? true,
    taxNumber: s?.taxNumber ?? "",
    poRequired: s?.poRequired ?? false,
    payOnline: s?.payOnline ?? null,
    hourlyRate: s?.hourlyRate ?? null,
    notes: s?.notes ?? "",
    autoApprove: s?.autoApprove ?? [],
  });
  const [f, setF] = useState(() => pick(client.invoice));
  useEffect(() => setF(pick(client.invoice)), [client.invoice]);
  const save = useMutation({
    mutationFn: () => api.put(`/crm/clients/${client.id}/invoice`, f),
    onSuccess: () => {
      saved();
      toast.success(t("crm.invoice.saved"));
    },
    onError: (e) => toast.error(ticketErrorText(t, e)),
  });
  if (client.invoice === null)
    return (
      <Card title={t("crm.invoice.title")} icon={<Receipt className="size-4" />}>
        <p className="text-sm text-muted-foreground">{t("crm.invoice.noRight")}</p>
      </Card>
    );
  return (
    <Card title={t("crm.invoice.title")} icon={<Receipt className="size-4" />}>
      <p className="-mt-2 text-xs text-muted-foreground">{t("crm.invoice.text")}</p>
      <form
        className="space-y-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t("crm.invoice.billingEmail")}>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input type="email" value={f.billingEmail} onChange={(e) => setF({ ...f, billingEmail: e.target.value })} placeholder={client.email ?? ""} className="h-9 pl-8" />
            </div>
          </Field>
          <Field label={t("crm.invoice.terms")}>
            <Select value={String(f.termsDays)} onValueChange={(v) => setF({ ...f, termsDays: Number(v) })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[0, 15, 30, 45, 60].map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {d === 0 ? t("crm.invoice.onReceipt") : t("crm.invoice.days", { days: d })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("crm.invoice.delivery")}>
            <Select value={f.delivery} onValueChange={(v) => setF({ ...f, delivery: v as "email" | "mail" })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email">{t("crm.invoice.byEmail")}</SelectItem>
                <SelectItem value="mail">{t("crm.invoice.byMail")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("crm.invoice.payOnline")}>
            <Select value={f.payOnline === null ? "default" : f.payOnline ? "yes" : "no"} onValueChange={(v) => setF({ ...f, payOnline: v === "default" ? null : v === "yes" })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">{t("crm.invoice.payOnlineDefault")}</SelectItem>
                <SelectItem value="yes">{t("crm.invoice.payOnlineYes")}</SelectItem>
                <SelectItem value="no">{t("crm.invoice.payOnlineNo")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("crm.invoice.rate")}>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={f.hourlyRate ?? ""}
              placeholder={t("crm.invoice.rateHint")}
              onChange={(e) => setF({ ...f, hourlyRate: e.target.value === "" ? null : Number(e.target.value) })}
              className="h-9"
            />
          </Field>
          <Field label={t("crm.invoice.taxNumber")}>
            <Input value={f.taxNumber} onChange={(e) => setF({ ...f, taxNumber: e.target.value })} className="h-9" />
          </Field>
          <div className="flex flex-col justify-end gap-2.5 pb-1">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={f.taxes} onCheckedChange={(v) => setF({ ...f, taxes: v })} /> {f.taxes ? t("crm.invoice.taxes") : t("crm.invoice.taxesOff")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={f.poRequired} onCheckedChange={(v) => setF({ ...f, poRequired: v })} /> {t("crm.invoice.po")}
            </label>
          </div>
          <Field label={t("crm.invoice.autoApprove")} className="sm:col-span-2 lg:col-span-3">
            <div className="flex flex-wrap gap-2">
              {(["labour", "charge", "contract", "milestone", "project"] as const).map((k) => (
                <label key={k} className={cn("flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs", f.autoApprove.includes(k) && "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10")}>
                  <Checkbox checked={f.autoApprove.includes(k)} onCheckedChange={(v) => setF({ ...f, autoApprove: v ? [...f.autoApprove, k] : f.autoApprove.filter((x) => x !== k) })} />
                  {t(`approvals.tabs.${k}`)}
                </label>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">{t("crm.invoice.autoApproveHint")}</p>
          </Field>
          <Field label={t("crm.invoice.notes")} className="sm:col-span-2 lg:col-span-3">
            <AiTextarea rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </Field>
        </div>
        <div className="flex justify-end">
          <Button type="submit" disabled={save.isPending} className="bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
            {save.isPending && <Loader2 className="size-4 animate-spin" />} {t("crm.invoice.save")}
          </Button>
        </div>
      </form>
    </Card>
  );
}

