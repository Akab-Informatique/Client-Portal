import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowLeft, ArrowUp, Check, ChevronsUpDown, ClipboardList, Copy, Eye, FileSignature, FileText, FolderKanban, Loader2, Lock, PackagePlus, Save, Send, Trash2, Undo2, X } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";
import { longDateTime } from "@/pages/tickets/shared";
import { lineAmount, lineGross, QUOTE_RECURRENCES, quoteTotals, recurrenceOf, type QuoteKind, type QuoteRecurrence } from "@shared/quotes";
import { SurveyPanel } from "./SurveyPanel";
import { QuoteDocument, type DocData } from "./QuoteDocument";
import { useToProject } from "./useToProject";
import { LineAdder } from "./LineAdder";
import { MarginsPanel } from "./Margins";
import { fromCents, fromPct, fromQty, parseNum, STATUS_STYLE, toCents, toPct, toQtyX100, useQuoteClients, useQuoteStaff, type Quote, type QuoteProduct, type QuoteService } from "./shared";

/** A line as it is typed: numbers stay text until saved, so "12," and "1 299" can be written. */
type Row = { key: string; id?: string; productId: string | null; serviceId: string | null; discount: string; sku: string; description: string; details: string; recurrence: QuoteRecurrence; qty: string; unit: string; cost: string; taxable: boolean; optional: boolean };

type Form = {
  preparedById: string | null;
  kind: QuoteKind;
  survey: Record<string, string>;
  clientId: string | null;
  prospectName: string;
  contactName: string;
  contactEmail: string;
  title: string;
  issuedOn: string;
  validUntil: string;
  taxes: boolean;
  notes: string;
  internalNotes: string;
  rows: Row[];
};

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
let seq = 0;
const key = () => `r${++seq}`;

const blank = (kind: QuoteKind = "standard", preparedById: string | null = null): Form => ({ preparedById, kind, survey: {}, clientId: null, prospectName: "", contactName: "", contactEmail: "", title: "", issuedOn: today(), validUntil: inDays(30), taxes: true, notes: "", internalNotes: "", rows: [] });

const fromQuote = (q: Quote): Form => ({
  preparedById: q.preparedById,
  kind: q.kind,
  survey: q.survey ?? {},
  clientId: q.clientId,
  prospectName: q.prospectName ?? "",
  contactName: q.contactName ?? "",
  contactEmail: q.contactEmail ?? "",
  title: q.title,
  issuedOn: q.issuedOn,
  validUntil: q.validUntil ?? "",
  taxes: q.taxes,
  notes: q.notes ?? "",
  internalNotes: q.internalNotes ?? "",
  rows: q.lines.map((l) => ({ key: key(), id: l.id, productId: l.productId, serviceId: l.serviceId, discount: fromPct(l.discountX100), sku: l.sku ?? "", description: l.description, details: l.details ?? "", recurrence: recurrenceOf(l), qty: fromQty(l.quantityX100), unit: fromCents(l.unitPriceCents), cost: fromCents(l.unitCostCents), taxable: l.taxable, optional: l.optional })),
});

const payload = (f: Form) => ({
  preparedById: f.preparedById,
  kind: f.kind,
  survey: Object.fromEntries(Object.entries(f.survey).filter(([, v]) => v !== "")),
  clientId: f.clientId,
  prospectName: f.clientId ? null : f.prospectName.trim() || null,
  contactName: f.contactName.trim() || null,
  contactEmail: f.contactEmail.trim() || null,
  title: f.title.trim(),
  issuedOn: f.issuedOn || undefined,
  validUntil: f.validUntil || null,
  taxes: f.taxes,
  notes: f.notes.trim() || null,
  internalNotes: f.internalNotes.trim() || null,
  lines: f.rows.map((r) => ({ productId: r.productId, serviceId: r.serviceId, discountX100: toPct(r.discount), sku: r.sku.trim() || null, description: r.description.trim() || "-", details: r.details.trim() || null, recurrence: r.recurrence, quantityX100: toQtyX100(r.qty), unitPriceCents: toCents(r.unit), unitCostCents: toCents(r.cost), taxable: r.taxable, optional: r.optional })),
});

const rowMoney = (r: Row) => ({ quantityX100: toQtyX100(r.qty), unitPriceCents: toCents(r.unit), unitCostCents: toCents(r.cost), discountX100: toPct(r.discount), taxable: r.taxable, optional: r.optional, recurrence: r.recurrence });

function errorText(t: (k: string, o?: Record<string, unknown>) => string, e: unknown) {
  if (e instanceof ApiError) return t(`quotes.errors.${e.code}`, { defaultValue: t("common.error") });
  return t("common.error");
}

/** Accounting › Soumissions › one quote (or a new one). */
export function QuoteEditor() {
  const { t, i18n } = useTranslation();
  const { id } = useParams();
  const isNew = !id || id === "new";
  const nav = useNavigate();
  const qc = useQueryClient();
  const can = useCan();
  const confirm = useConfirm();
  const manage = can("quotes.manage");
  const [params] = useSearchParams();
  const startKind: QuoteKind = params.get("type") === "site_visit" ? "site_visit" : "standard";
  const me = useMe();
  const staff = useQuoteStaff();
  const [form, setForm] = useState<Form>(() => blank(startKind, me.id));
  const [saved, setSaved] = useState<string>(() => JSON.stringify(payload(blank(startKind, me.id))));
  const [tab, setTab] = useState<"survey" | "quote" | "margins">("quote");
  // "Face au client": no cost, margin or internal note on screen; "Interne": costs, margins and the Marges tab (remembered on this browser)
  const [mode, setModeState] = useState<"client" | "internal">(() => {
    try {
      return localStorage.getItem("akab.quotes.mode") === "internal" ? "internal" : "client";
    } catch {
      return "client";
    }
  });
  const setMode = (m: "client" | "internal") => {
    setModeState(m);
    if (m === "client" && tab === "margins") setTab("quote");
    try {
      localStorage.setItem("akab.quotes.mode", m);
    } catch {
      /* the choice just is not remembered */
    }
  };
  const internal = mode === "internal";
  const tabs = [...(form.kind === "site_visit" ? (["survey", "quote"] as const) : []), ...(internal ? (form.kind === "site_visit" ? (["margins"] as const) : (["quote", "margins"] as const)) : [])];
  const shownTab = tab === "margins" && !internal ? "quote" : tab;
  const [toInventory, setToInventory] = useState<Row | null>(null);
  const [preview, setPreview] = useState(false);
  const project = useToProject();

  const query = useQuery({ queryKey: ["quotes", "one", id], queryFn: () => api.get<Quote>(`/quotes/${id}`), enabled: !isNew });
  const quote = query.data;
  const clients = useQuoteClients();
  const rates = quote?.rates ?? { gstRate: 5, qstRate: 9.975 };

  // the quote fills the form once when it is opened; later changes (a save, a status) come through apply()
  const loaded = useRef<string | null>(null);
  const apply = (q: Quote) => {
    const f = fromQuote(q);
    setForm(f);
    setSaved(JSON.stringify(payload(f)));
    qc.setQueryData(["quotes", "one", q.id], q);
  };
  useEffect(() => {
    if (!quote || loaded.current === quote.id) return;
    loaded.current = quote.id;
    apply(quote);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote]);

  const status = quote?.status ?? "draft";
  const locked = !manage || (!isNew && status !== "draft" && status !== "sent");
  const dirty = JSON.stringify(payload(form)) !== saved;
  useEffect(() => {
    if (!dirty || locked) return;
    const stop = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", stop);
    return () => window.removeEventListener("beforeunload", stop);
  }, [dirty, locked]);

  const totals = useMemo(() => quoteTotals(form.rows.map(rowMoney), form.taxes, rates), [form.rows, form.taxes, rates]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setRow = (k: string, patch: Partial<Row>) => setForm((f) => ({ ...f, rows: f.rows.map((r) => (r.key === k ? { ...r, ...patch } : r)) }));

  const addProduct = (p: QuoteProduct) =>
    setForm((f) => {
      // the same product again adds one to its line
      const same = f.rows.find((r) => r.productId === p.id && !r.optional && r.recurrence === "once");
      if (same) return { ...f, rows: f.rows.map((r) => (r === same ? { ...r, qty: String(parseNum(r.qty) + 1).replace(".", ",") } : r)) };
      return { ...f, rows: [...f.rows, { key: key(), productId: p.id, serviceId: null, discount: "0", sku: p.sku ?? "", description: p.name, details: p.description?.trim() ?? "", recurrence: "once", qty: "1", unit: fromCents(p.priceCents), cost: fromCents(p.costCents), taxable: true, optional: false }] };
    });
  const addFree = (text: string) => setForm((f) => ({ ...f, rows: [...f.rows, { key: key(), productId: null, serviceId: null, discount: "0", sku: "", description: text, details: "", recurrence: "once", qty: "1", unit: "0,00", cost: "0,00", taxable: true, optional: false }] }));
  // a service of Inventory › Services: monthly / yearly as the service is, its price, cost, taxes and description
  const addService = (s: QuoteService) =>
    setForm((f) => {
      const same = f.rows.find((r) => r.serviceId === s.id && !r.optional);
      if (same) return { ...f, rows: f.rows.map((r) => (r === same ? { ...r, qty: String(parseNum(r.qty) + 1).replace(".", ",") } : r)) };
      return { ...f, rows: [...f.rows, { key: key(), productId: null, serviceId: s.id, discount: "0", sku: s.sku ?? "", description: s.name, details: s.description?.trim() ?? "", recurrence: s.recurrence, qty: "1", unit: fromCents(s.priceCents), cost: fromCents(s.costCents), taxable: s.taxable, optional: false }] };
    });
  const move = (k: string, d: -1 | 1) =>
    setForm((f) => {
      const i = f.rows.findIndex((r) => r.key === k);
      const j = i + d;
      if (i < 0 || j < 0 || j >= f.rows.length) return f;
      const rows = [...f.rows];
      [rows[i], rows[j]] = [rows[j], rows[i]];
      return { ...f, rows };
    });

  // the company named in the checklist is who the quote is for, until a client is picked
  const setAnswer = (k: string, v: string) =>
    setForm((f) => {
      const survey = { ...f.survey, [k]: v };
      const follows = k === "general.company" && !f.clientId && (!f.prospectName || f.prospectName === (f.survey[k] ?? ""));
      return { ...f, survey, ...(follows ? { prospectName: v } : {}) };
    });

  const pickClient = (cid: string | null) => {
    const c = clients.data?.find((x) => x.id === cid);
    setForm((f) => ({ ...f, clientId: cid, taxes: c ? c.taxes : f.taxes, contactEmail: f.contactEmail || c?.email || "" }));
  };

  const save = useMutation({
    mutationFn: () => (isNew ? api.post<Quote>("/quotes", payload(form)) : api.put<Quote>(`/quotes/${id}`, payload(form))),
    onSuccess: (q) => {
      void qc.invalidateQueries({ queryKey: ["quotes"] });
      loaded.current = q.id;
      apply(q);
      toast.success(t("quotes.editor.saved"));
      if (isNew) nav(`/accounting/quotes/${q.id}`, { replace: true });
    },
    onError: (e) => toast.error(errorText(t, e)),
  });

  const changeStatus = useMutation({
    mutationFn: async (to: string) => {
      if (dirty && !locked) await api.put<Quote>(`/quotes/${id}`, payload(form));
      return api.post<Quote>(`/quotes/${id}/status`, { status: to });
    },
    onSuccess: (q) => {
      apply(q);
      void qc.invalidateQueries({ queryKey: ["quotes"] });
    },
    onError: (e) => toast.error(errorText(t, e)),
  });

  const copy = useMutation({
    mutationFn: () => api.post<Quote>(`/quotes/${id}/duplicate`, {}),
    onSuccess: (q) => {
      void qc.invalidateQueries({ queryKey: ["quotes"] });
      toast.success(t("quotes.editor.duplicated"));
      nav(`/accounting/quotes/${q.id}`);
    },
    onError: (e) => toast.error(errorText(t, e)),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/quotes/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["quotes"] });
      nav("/accounting/quotes");
    },
    onError: (e) => toast.error(errorText(t, e)),
  });

  const back = async () => {
    if (dirty && !locked && !(await confirm({ title: t("quotes.editor.leaveConfirm"), destructive: true }))) return;
    nav("/accounting/quotes");
  };

  if (!isNew && query.isLoading) return <Skeleton className="h-96 rounded-2xl" />;
  if (!isNew && query.isError) return <p className="p-10 text-center text-muted-foreground">{t("common.error")}</p>;

  const clientName = clients.data?.find((c) => c.id === form.clientId)?.name;
  // the sheet the client reads, from what is on screen (saved or not)
  const doc: DocData | null = quote
    ? {
        number: quote.number,
        title: form.title.trim(),
        issuedOn: form.issuedOn,
        validUntil: form.validUntil,
        forName: clientName ?? form.prospectName.trim(),
        contactName: form.contactName.trim(),
        contactEmail: form.contactEmail.trim(),
        rows: form.rows.map((r) => ({ sku: r.sku.trim(), description: r.description.trim(), details: r.details.trim(), ...rowMoney(r) })),
        taxes: form.taxes,
        rates,
        notes: form.notes.trim(),
        company: quote.company,
        taxNumbers: quote.taxNumbers,
        footer: quote.footer,
        preparedBy: staff.data?.find((s) => s.id === form.preparedById)?.name ?? quote.preparedBy ?? "",
        preparedByTitle: staff.data?.find((s) => s.id === form.preparedById)?.title ?? "",
      }
    : null;
  const recurring = totals.monthly.subtotalCents > 0 || totals.yearly.subtotalCents > 0;
  const marginPct = totals.subtotalCents > 0 ? Math.round((totals.marginCents / totals.subtotalCents) * 100) : 0;
  const busy = save.isPending || changeStatus.isPending;
  const shownStatus = quote?.expired ? "expired" : status;

  return (
    <div className="relative isolate space-y-6">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <button type="button" onClick={() => void back()} className="mb-1 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" /> {t("quotes.editor.back")}
          </button>
          <h1 className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xl font-bold">
            {form.kind === "site_visit" ? <ClipboardList className="size-6 text-primary" /> : <FileSignature className="size-6 text-primary" />}
            {isNew ? t("quotes.editor.newTitle") : <span className="font-mono">{quote?.number}</span>}
            {!isNew && <span className={cn("rounded-full border px-2.5 py-0.5 text-xs font-medium", STATUS_STYLE[shownStatus])}>{t(`quotes.status.${shownStatus}`)}</span>}
          </h1>
          {quote && (
            <p className="text-sm text-muted-foreground">
              {[quote.createdBy ? t("quotes.editor.by", { name: quote.createdBy }) : null, quote.sentAt ? t("quotes.editor.sentOn", { date: longDateTime(quote.sentAt) }) : null, quote.decidedAt ? t("quotes.editor.decidedOn", { date: longDateTime(quote.decidedAt) }) : null].filter(Boolean).join("  ·  ")}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {dirty && !locked && <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs text-amber-300">{t("quotes.editor.unsaved")}</span>}
          <div role="radiogroup" aria-label={t("quotes.mode.label")} className="glass inline-flex rounded-xl border p-1">
            {(["client", "internal"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                title={t(`quotes.mode.${m}Help`)}
                onClick={() => setMode(m)}
                className={cn("inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors", mode === m ? "bg-[color:var(--gold)]/15 text-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {m === "client" ? <Eye className="size-4" /> : <Lock className="size-4" />}
                {t(`quotes.mode.${m}`)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {!isNew && locked && manage && <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">{t("quotes.editor.locked", { status: t(`quotes.status.${status}`).toLowerCase() })}</p>}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-4">
        {tabs.length > 1 && (
          <div role="tablist" className="glass inline-flex rounded-xl border p-1">
            {tabs.map((k) => (
              <button key={k} type="button" role="tab" aria-selected={shownTab === k} onClick={() => setTab(k)} className={cn("rounded-lg px-4 py-1.5 text-sm font-medium transition-colors", shownTab === k ? "bg-[color:var(--gold)]/15 text-foreground" : "text-muted-foreground hover:text-foreground")}>
                {k === "margins" ? t("quotes.margins.tab") : t(`quotes.survey.tab.${k}`)}
              </button>
            ))}
          </div>
        )}
        {form.kind === "site_visit" && (
          <div className={cn(shownTab !== "survey" && "hidden")}>
            <SurveyPanel answers={form.survey} onChange={setAnswer} disabled={locked} />
          </div>
        )}
        {internal && shownTab === "margins" && <MarginsPanel rows={form.rows.map((r) => ({ key: r.key, name: r.description, ...rowMoney(r) }))} totals={totals} />}
        <fieldset disabled={locked} className={cn("min-w-0 space-y-6", shownTab !== "quote" && "hidden")}>
          <section className="glass space-y-4 rounded-2xl border p-5">
            <h2 className="text-lg font-semibold">{t("quotes.editor.who")}</h2>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t("quotes.editor.client")}</Label>
                <ClientPicker value={form.clientId} name={clientName} onPick={pickClient} disabled={locked} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="q-prospect">{t("quotes.editor.orProspect")}</Label>
                <Input id="q-prospect" disabled={Boolean(form.clientId) || locked} value={form.prospectName} onChange={(e) => set("prospectName", e.target.value)} placeholder={t("quotes.editor.prospectName")} className="bg-background/40" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="q-contact">{t("quotes.editor.contactName")}</Label>
                <Input id="q-contact" value={form.contactName} onChange={(e) => set("contactName", e.target.value)} className="bg-background/40" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="q-email">{t("quotes.editor.contactEmail")}</Label>
                <Input id="q-email" type="email" value={form.contactEmail} onChange={(e) => set("contactEmail", e.target.value)} className="bg-background/40" />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label>{t("quotes.editor.preparedBy")}</Label>
                <Select value={form.preparedById ?? ""} onValueChange={(v) => set("preparedById", v)} disabled={locked}>
                  <SelectTrigger className="h-9 w-full bg-background/40">
                    <SelectValue placeholder={t("quotes.editor.preparedByPick")} />
                  </SelectTrigger>
                  <SelectContent>
                    {(staff.data ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                        {s.title ? ` (${s.title})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t("quotes.editor.preparedByHelp")}</p>
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="q-title">{t("quotes.editor.subject")}</Label>
                <Input id="q-title" value={form.title} onChange={(e) => set("title", e.target.value)} placeholder={t("quotes.editor.subjectPlaceholder")} className="bg-background/40" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="q-issued">{t("quotes.editor.issuedOn")}</Label>
                <Input id="q-issued" type="date" value={form.issuedOn} onChange={(e) => set("issuedOn", e.target.value)} className="bg-background/40" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="q-valid">{t("quotes.editor.validUntil")}</Label>
                <Input id="q-valid" type="date" value={form.validUntil} onChange={(e) => set("validUntil", e.target.value)} className="bg-background/40" />
              </div>
            </div>
          </section>

          {/* above the cards that follow (notes…): the glass makes its own layer, so the add list would slip under them */}
          <section className="glass relative z-20 space-y-4 rounded-2xl border p-5">
            <h2 className="text-lg font-semibold">{t("quotes.editor.linesTitle")}</h2>

            {!locked && <LineAdder onProduct={addProduct} onService={addService} onFree={addFree} />}

            {form.rows.length === 0 ? (
              <div className="rounded-xl border border-dashed px-6 py-10 text-center">
                <p className="font-semibold">{t("quotes.editor.noLines")}</p>
                <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{t("quotes.editor.noLinesText")}</p>
              </div>
            ) : (
              <ul className="divide-y">
                {form.rows.map((r, i) => {
                  const m = rowMoney(r);
                  const amount = lineAmount(m);
                  const gross = lineGross(m);
                  return (
                    <li key={r.key} className="space-y-2.5 py-4">
                      <div className="min-w-0 space-y-1.5">
                        <Input aria-label={t("quotes.editor.item")} value={r.description} onChange={(e) => setRow(r.key, { description: e.target.value })} className="h-9 bg-background/40 font-medium" />
                        <Textarea
                          aria-label={t("quotes.editor.details")}
                          rows={1}
                          maxLength={2000}
                          value={r.details}
                          onChange={(e) => setRow(r.key, { details: e.target.value })}
                          placeholder={t("quotes.editor.detailsPlaceholder")}
                          className="min-h-9 resize-none bg-background/40 py-1.5 text-sm"
                        />
                        <div className="flex flex-wrap items-center gap-1.5 text-xs">
                          {r.serviceId ? (
                            <span className="rounded-md border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-sky-300">
                              {t("quotes.editor.service")}
                              {r.sku && <span className="ml-1 font-mono">{r.sku}</span>}
                            </span>
                          ) : r.productId ? (
                            <span className="rounded-md border px-1.5 py-0.5 font-mono text-muted-foreground">{r.sku || t("quotes.editor.fromInventory")}</span>
                          ) : (
                            <span className="rounded-md border border-dashed px-1.5 py-0.5 text-muted-foreground">{t("quotes.editor.freeLine")}</span>
                          )}
                          <div role="radiogroup" aria-label={t("quotes.editor.recurrence")} className="inline-flex rounded-md border p-px">
                            {QUOTE_RECURRENCES.map((k) => (
                              <button
                                key={k}
                                type="button"
                                role="radio"
                                aria-checked={r.recurrence === k}
                                onClick={() => setRow(r.key, { recurrence: k })}
                                className={cn("rounded-[5px] px-1.5 py-0.5 transition-colors", r.recurrence === k ? "bg-[color:var(--gold)]/15 text-foreground" : "text-muted-foreground hover:text-foreground")}
                              >
                                {t(`quotes.recurrence.${k}`)}
                              </button>
                            ))}
                          </div>
                          <Chip on={r.taxable} onClick={() => setRow(r.key, { taxable: !r.taxable })} label={t("quotes.editor.taxable")} />
                          <Chip on={r.optional} onClick={() => setRow(r.key, { optional: !r.optional })} label={t("quotes.editor.optional")} title={t("quotes.editor.optionalHelp")} />
                          {!r.productId && !r.serviceId && manage && can("store.manage") && (
                            <button type="button" className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-primary hover:bg-primary/10" onClick={() => (r.id ? setToInventory(r) : toast.info(t("quotes.editor.saveFirst")))}>
                              <PackagePlus className="size-3.5" /> {t("quotes.editor.toInventory")}
                            </button>
                          )}
                          {!locked && (
                            <div className="ml-auto flex">
                              <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={t("quotes.editor.moveUp")} disabled={i === 0} onClick={() => move(r.key, -1)}>
                                <ArrowUp className="size-3.5" />
                              </Button>
                              <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={t("quotes.editor.moveDown")} disabled={i === form.rows.length - 1} onClick={() => move(r.key, 1)}>
                                <ArrowDown className="size-3.5" />
                              </Button>
                              <Button type="button" variant="ghost" size="icon" className="size-7 hover:text-red-400" aria-label={t("quotes.editor.remove")} onClick={() => set("rows", form.rows.filter((x) => x.key !== r.key))}>
                                <X className="size-4" />
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                      {/* the figures on their own row, under the name and description (which keep the full width) */}
                      <div className={cn("grid grid-cols-2 items-end gap-2 sm:grid-cols-[5rem_8rem_6rem_minmax(0,1fr)]", internal && "sm:grid-cols-[5rem_8rem_6rem_8rem_minmax(0,1fr)]")}>
                        <NumField label={t("quotes.editor.qty")} value={r.qty} onChange={(v) => setRow(r.key, { qty: v })} />
                        <NumField label={t("quotes.editor.unit")} value={r.unit} onChange={(v) => setRow(r.key, { unit: v })} money />
                        <NumField label={t("quotes.editor.discount")} value={r.discount} onChange={(v) => setRow(r.key, { discount: v })} suffix="%" />
                        {internal && <NumField label={t("quotes.editor.cost")} value={r.cost} onChange={(v) => setRow(r.key, { cost: v })} money />}
                        <div className="text-right">
                          <p className="text-xs text-muted-foreground">{t("quotes.editor.amount")}</p>
                          <p className="flex h-9 items-center justify-end gap-2 whitespace-nowrap tabular-nums">
                            {gross !== amount && <span className="text-xs text-muted-foreground line-through decoration-1">{money(gross, i18n.language)}</span>}
                            <span className={cn("text-sm font-semibold", r.optional && "text-muted-foreground line-through decoration-1")}>{money(amount, i18n.language)}</span>
                            {r.recurrence !== "once" && <span className="text-xs text-muted-foreground">{t(`quotes.recurrence.per.${r.recurrence}`)}</span>}
                          </p>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className={cn("glass grid gap-4 rounded-2xl border p-5", internal && "md:grid-cols-2")}>
            <div className="space-y-1.5">
              <Label htmlFor="q-notes">{t("quotes.editor.notes")}</Label>
              <Textarea id="q-notes" rows={5} value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder={t("quotes.editor.notesPlaceholder")} className="bg-background/40" />
            </div>
            {internal && (
              <div className="space-y-1.5">
                <Label htmlFor="q-internal">{t("quotes.editor.internalNotes")}</Label>
                <Textarea id="q-internal" rows={5} value={form.internalNotes} onChange={(e) => set("internalNotes", e.target.value)} className="bg-background/40" />
                <p className="text-xs text-muted-foreground">{t("quotes.editor.internalHelp")}</p>
              </div>
            )}
          </section>
        </fieldset>
        </div>

        {/* below the top bar, and scrolls on its own when taller than the screen (the buttons stay reachable, clear of the dock at the bottom right) */}
        <aside className="space-y-4 xl:sticky xl:top-20 xl:-mr-2 xl:max-h-[calc(100dvh-6rem)] xl:overflow-y-auto xl:overscroll-contain xl:pb-24 xl:pr-2">

          <section className="glass space-y-3 rounded-2xl border p-5">
            <h2 className="text-lg font-semibold">{t("quotes.editor.totals")}</h2>
            <dl className="space-y-1.5 text-sm">
              <Total label={t("quotes.editor.subtotal")} value={money(totals.subtotalCents, i18n.language)} />
              <Total label={`${t("quotes.editor.gst")} (${rates.gstRate} %)`} value={money(totals.gstCents, i18n.language)} muted={!form.taxes} />
              <Total label={`${t("quotes.editor.qst")} (${rates.qstRate} %)`} value={money(totals.qstCents, i18n.language)} muted={!form.taxes} />
              <div className="flex items-baseline justify-between border-t pt-2.5">
                <dt className="font-semibold">{recurring ? t("quotes.recurrence.totalOnce") : t("quotes.editor.total")}</dt>
                <dd className="text-2xl font-bold tabular-nums">{money(totals.totalCents, i18n.language)}</dd>
              </div>
              {(["monthly", "yearly"] as const).map((k) =>
                totals[k].subtotalCents > 0 ? (
                  <div key={k} className="flex items-baseline justify-between border-t pt-2.5">
                    <dt className="font-semibold">{t(`quotes.recurrence.total.${k}`)}</dt>
                    <dd className="text-right">
                      <span className="text-lg font-bold tabular-nums">{money(totals[k].totalCents, i18n.language)}</span>
                      <span className="text-xs text-muted-foreground"> {t(`quotes.recurrence.per.${k}`)}</span>
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        {form.taxes ? t("quotes.recurrence.beforeTaxes", { amount: money(totals[k].subtotalCents, i18n.language) }) : null}
                        {internal ? `${form.taxes ? "  ·  " : ""}${t("quotes.editor.margin")} ${money(totals[k].marginCents, i18n.language)}` : null}
                      </span>
                    </dd>
                  </div>
                ) : null,
              )}
              {totals.optionalCents > 0 && <Total label={t("quotes.editor.optionalTotal")} value={money(totals.optionalCents, i18n.language)} muted />}
              {internal && (
                <div className="flex items-baseline justify-between border-t pt-2.5">
                  <dt className="text-muted-foreground">{t("quotes.editor.margin")}</dt>
                  <dd className="text-right tabular-nums">
                    {money(totals.marginCents, i18n.language)}
                    <span className="block text-xs text-muted-foreground">{t("quotes.editor.marginPct", { pct: marginPct })}</span>
                  </dd>
                </div>
              )}
            </dl>
            <label className="flex cursor-pointer items-center justify-between gap-3 border-t pt-3 text-sm">
              <span>{form.taxes ? t("quotes.editor.taxes") : t("quotes.editor.taxesOff")}</span>
              <Switch checked={form.taxes} disabled={locked} onCheckedChange={(v) => set("taxes", v)} />
            </label>
          </section>

          {manage && (
            <section className="glass space-y-2 rounded-2xl border p-4">
              {!locked && (
                <Button className="w-full" disabled={busy || (!dirty && !isNew)} onClick={() => save.mutate()}>
                  {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} {t("quotes.editor.save")}
                </Button>
              )}
              {quote && project.allowed(quote) && (
                <Button variant="outline" className="w-full" disabled={dirty || project.pending} title={dirty ? t("quotes.editor.unsaved") : undefined} onClick={() => void project.start(quote)}>
                  {project.pending ? <Loader2 className="size-4 animate-spin" /> : <FolderKanban className="size-4" />} {t("quotes.project.action")}
                </Button>
              )}
              {quote?.projectTicketNumber && (
                <p className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
                  <FolderKanban className="size-4 shrink-0" /> {t("quotes.project.badge", { number: quote.projectTicketNumber })}
                </p>
              )}
              {doc && (
                <Button variant="outline" className="w-full" disabled={form.rows.length === 0} onClick={() => setPreview(true)}>
                  <FileText className="size-4" /> {t("quotes.doc.open")}
                </Button>
              )}
              {!isNew && status === "draft" && (
                <Button variant="outline" className="w-full" disabled={busy} onClick={() => changeStatus.mutate("sent")}>
                  <Send className="size-4" /> {t("quotes.editor.send")}
                </Button>
              )}
              {!isNew && status === "sent" && (
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="outline" disabled={busy} onClick={() => changeStatus.mutate("accepted")}>
                    <Check className="size-4 text-emerald-400" /> {t("quotes.editor.accept")}
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => changeStatus.mutate("declined")}>
                    <X className="size-4 text-red-400" /> {t("quotes.editor.decline")}
                  </Button>
                </div>
              )}
              {!isNew && status !== "draft" && (
                <Button variant="ghost" className="w-full" disabled={busy} onClick={() => changeStatus.mutate("draft")}>
                  <Undo2 className="size-4" /> {t("quotes.editor.reopen")}
                </Button>
              )}
              {!isNew && (
                <div className="grid grid-cols-2 gap-2 border-t pt-2">
                  <Button variant="ghost" size="sm" disabled={copy.isPending} onClick={() => copy.mutate()}>
                    <Copy className="size-4" /> {t("quotes.editor.duplicate")}
                  </Button>
                  <Button variant="ghost" size="sm" className="hover:text-red-400" disabled={status === "accepted"} onClick={() => void confirm({ title: t("quotes.editor.deleteConfirm"), destructive: true }).then((ok) => ok && remove.mutate())}>
                    <Trash2 className="size-4" /> {t("quotes.editor.delete")}
                  </Button>
                </div>
              )}
            </section>
          )}
        </aside>
      </div>

      {preview && doc && <QuoteDocument data={doc} onClose={() => setPreview(false)} />}
      {toInventory && quote && <ToInventoryDialog quoteId={quote.id} row={toInventory} onClose={() => setToInventory(null)} onDone={(pid, sku) => setRow(toInventory.key, { productId: pid, sku: sku ?? "" })} />}
    </div>
  );
}

function Chip({ on, onClick, label, title }: { on: boolean; onClick: () => void; label: string; title?: string }) {
  return (
    <button type="button" aria-pressed={on} title={title} onClick={onClick} className={cn("rounded-md border px-1.5 py-0.5 transition-colors", on ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 text-foreground" : "border-transparent text-muted-foreground line-through decoration-1 hover:bg-accent")}>
      {label}
    </button>
  );
}

function NumField({ label, value, onChange, money: isMoney, suffix }: { label: string; value: string; onChange: (v: string) => void; money?: boolean; suffix?: string }) {
  const unit = isMoney ? "$" : suffix;
  return (
    <div>
      <Label className="mb-1 block text-xs text-muted-foreground">{label}</Label>
      <div className="relative">
        <Input inputMode="decimal" aria-label={label} title={label} value={value} onChange={(e) => onChange(e.target.value)} onFocus={(e) => e.currentTarget.select()} className={cn("h-9 bg-background/40 text-right tabular-nums", unit && "pr-6")} />
        {unit && <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{unit}</span>}
      </div>
    </div>
  );
}

function Total({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={cn("flex items-baseline justify-between", muted && "text-muted-foreground")}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

function ClientPicker({ value, name, onPick, disabled }: { value: string | null; name?: string; onPick: (id: string | null) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const { data = [] } = useQuoteClients();
  const shown = data.filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase())).slice(0, 50);
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ(""); }}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" disabled={disabled} className="h-9 w-full justify-between bg-background/40 font-normal">
          <span className={cn("truncate", !value && "text-muted-foreground")}>{value ? name ?? "…" : t("quotes.editor.pickClient")}</span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-64 p-2">
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("quotes.editor.searchClient")} className="mb-1 h-8" />
        <ul className="max-h-64 overflow-y-auto">
          {value && (
            <li>
              <button type="button" className="w-full rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent" onClick={() => { onPick(null); setOpen(false); }}>
                {t("quotes.editor.noClient")}
              </button>
            </li>
          )}
          {shown.map((c) => (
            <li key={c.id}>
              <button type="button" className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent" onClick={() => { onPick(c.id); setOpen(false); }}>
                <span className="truncate">{c.name}</span>
                {c.id === value && <Check className="size-4 shrink-0 text-primary" />}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** Keep a line typed on the spot: it becomes an inventory product, found by search next time. */
function ToInventoryDialog({ quoteId, row, onClose, onDone }: { quoteId: string; row: Row; onClose: () => void; onDone: (productId: string, sku: string | null) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [sku, setSku] = useState(row.sku);
  const add = useMutation({
    mutationFn: () => api.post<{ productId: string; sku: string | null }>(`/quotes/${quoteId}/lines/${row.id}/to-inventory`, { sku: sku.trim() || null }),
    onSuccess: (r) => {
      onDone(r.productId, r.sku);
      void qc.invalidateQueries({ queryKey: ["quotes", "products"] });
      void qc.invalidateQueries({ queryKey: ["store"] });
      toast.success(t("quotes.editor.toInventoryDone"));
      onClose();
    },
    onError: (e) => toast.error(errorText(t, e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("quotes.editor.toInventoryTitle")}</DialogTitle>
          <DialogDescription>{t("quotes.editor.toInventoryText")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!add.isPending) add.mutate();
          }}
        >
          <p className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">{row.description}</p>
          <div className="space-y-1.5">
            <Label htmlFor="ti-sku">{t("quotes.editor.sku")}</Label>
            <Input id="ti-sku" autoFocus value={sku} onChange={(e) => setSku(e.target.value)} className="font-mono" />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={add.isPending}>
              {add.isPending ? <Loader2 className="size-4 animate-spin" /> : <PackagePlus className="size-4" />} {t("quotes.editor.toInventorySave")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
