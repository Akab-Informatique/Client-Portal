import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ExternalLink,
  Eye,
  FileStack,
  Loader2,
  Printer,
  Receipt,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useSelectedClient } from "@/context/SelectedClientContext";
import { useLocale } from "@/hooks/use-locale";
import {
  PAYMENT_PORTAL_URL,
  fetchClientInvoices,
  formatInvoiceDate,
  formatMoney,
  invoicePdfUrl,
  printInvoicePdf,
  type ClientInvoice,
} from "@/lib/invoices";
import {
  fetchClientContracts,
  fetchContractServices,
  formatContractDate,
  type ClientContractService,
  type ClientSafeContract,
} from "@/lib/contracts";
import { BlurFade } from "@/components/ui/blur-fade";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type BillingKind = "invoices" | "contracts";

export function BillingPlaceholderPage({ kind }: { kind: BillingKind }) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const { selectedClient, clients, loading } = useSelectedClient();

  const [invLoading, setInvLoading] = useState(false);
  const [invoices, setInvoices] = useState<ClientInvoice[]>([]);
  const [invError, setInvError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [pdfInvoice, setPdfInvoice] = useState<ClientInvoice | null>(null);
  const [pdfBusyId, setPdfBusyId] = useState<number | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);

  const [ctLoading, setCtLoading] = useState(false);
  const [contracts, setContracts] = useState<ClientSafeContract[]>([]);
  const [ctError, setCtError] = useState<string | null>(null);
  const [svcContract, setSvcContract] = useState<ClientSafeContract | null>(
    null,
  );
  const [svcLoading, setSvcLoading] = useState(false);
  const [svcError, setSvcError] = useState<string | null>(null);
  const [services, setServices] = useState<ClientContractService[]>([]);

  const title =
    kind === "invoices" ? t("billing.invoicesTitle") : t("billing.contractsTitle");
  const desc =
    kind === "invoices"
      ? t("billing.invoicesDescAt")
      : t("billing.contractsDescActive");
  const Icon = kind === "invoices" ? Receipt : FileStack;

  const loadInvoices = useCallback(
    async (search?: string) => {
      if (!selectedClient) return;
      const atId = (selectedClient.autotask_company_id || "").trim();
      setInvLoading(true);
      setInvError(null);
      try {
        if (!atId) {
          setInvoices([]);
          setInvError(t("billing.noAutotaskId"));
          return;
        }
        const res = await fetchClientInvoices(atId, {
          search: search?.trim() || null,
        });
        setInvoices(res.invoices);
        if (res.error && res.invoices.length === 0) setInvError(res.error);
      } catch (e) {
        setInvError(
          e instanceof Error ? e.message : t("billing.invoicesLoadFailed"),
        );
        setInvoices([]);
      } finally {
        setInvLoading(false);
      }
    },
    [selectedClient, t],
  );

  const loadContracts = useCallback(async () => {
    if (!selectedClient) return;
    const atId = (selectedClient.autotask_company_id || "").trim();
    setCtLoading(true);
    setCtError(null);
    try {
      if (!atId) {
        setContracts([]);
        setCtError(t("billing.noAutotaskId"));
        return;
      }
      const res = await fetchClientContracts(atId, { includeInactive: false });
      setContracts(res.contracts);
      if (res.error) setCtError(res.error);
    } catch (e) {
      setCtError(
        e instanceof Error ? e.message : t("billing.contractsLoadFailed"),
      );
      setContracts([]);
    } finally {
      setCtLoading(false);
    }
  }, [selectedClient, t]);

  const openContractServices = useCallback(
    async (c: ClientSafeContract) => {
      setSvcContract(c);
      setSvcLoading(true);
      setSvcError(null);
      setServices([]);
      try {
        const res = await fetchContractServices(c.id);
        setServices(res.services);
        if (res.error) setSvcError(res.error);
      } catch (e) {
        setSvcError(
          e instanceof Error ? e.message : t("billing.servicesLoadFailed"),
        );
        setServices([]);
      } finally {
        setSvcLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    if (!selectedClient) return;
    if (kind === "invoices") void loadInvoices(activeSearch);
    else void loadContracts();
  }, [selectedClient, kind, activeSearch, loadInvoices, loadContracts]);

  const onSearch = (e?: React.FormEvent) => {
    e?.preventDefault();
    setActiveSearch(searchInput.trim());
  };

  const onClearSearch = () => {
    setSearchInput("");
    setActiveSearch("");
  };

  const onPrint = async (inv: ClientInvoice) => {
    setPdfBusyId(inv.id);
    setPdfError(null);
    try {
      await printInvoicePdf(inv.id);
    } catch (e) {
      setPdfError(e instanceof Error ? e.message : t("billing.pdfFailed"));
    } finally {
      setPdfBusyId(null);
    }
  };

  const filteredCountLabel = useMemo(() => {
    if (!activeSearch) return null;
    return t("billing.searchResults", { count: String(invoices.length) });
  }, [activeSearch, invoices.length, t]);

  if (!loading && clients.length === 0) {
    return (
      <EmptyState
        icon={<Icon className="size-5" />}
        title={t("nav.noClients")}
        description={t("billing.noClientsDesc")}
        actionLabel={t("nav.clients")}
        onAction={() => navigate("/admin/clients")}
      />
    );
  }

  if (!loading && !selectedClient) {
    return (
      <EmptyState
        icon={<Icon className="size-5" />}
        title={t("nav.selectClient")}
        description={t("billing.pickClientDesc")}
      />
    );
  }

  const statusBadge = (status: ClientInvoice["status"]) => {
    if (status === "paid") {
      return (
        <Badge
          variant="outline"
          className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
        >
          {t("billing.statusPaid")}
        </Badge>
      );
    }
    return (
      <Badge
        variant="outline"
        className="border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-400"
      >
        {t("billing.statusOpen")}
      </Badge>
    );
  };

  return (
    <div className="space-y-6">
      <BlurFade delay={0.04}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-bold tracking-tight">{title}</h2>
              {selectedClient && (
                <Badge
                  variant="outline"
                  className="border-primary/40 bg-primary/10 text-primary"
                >
                  {selectedClient.name}
                </Badge>
              )}
            </div>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{desc}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {kind === "invoices" && (
              <Button asChild size="sm" className="gap-1.5">
                <a
                  href={PAYMENT_PORTAL_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="size-3.5" />
                  {t("billing.openPaymentLink")}
                </a>
              </Button>
            )}
            <Button asChild variant="outline" size="sm">
              <Link to="/admin/clients">{t("billing.manageClients")}</Link>
            </Button>
          </div>
        </div>
      </BlurFade>

      {kind === "invoices" ? (
        <BlurFade delay={0.08}>
          <Card>
            <CardHeader className="space-y-3">
              <div className="flex flex-row items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Receipt className="size-5 text-primary" />
                    {t("billing.invoicesTitle")}
                  </CardTitle>
                  <CardDescription>{t("billing.invoicesDescAt")}</CardDescription>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5 shrink-0"
                  disabled={invLoading}
                  onClick={() => void loadInvoices(activeSearch)}
                >
                  {invLoading ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}
                  {t("common.refresh")}
                </Button>
              </div>
              <form
                onSubmit={onSearch}
                className="flex flex-col gap-2 sm:flex-row sm:items-center"
              >
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    placeholder={t("billing.searchInvoicesPh")}
                    className="pl-9"
                    aria-label={t("billing.searchInvoices")}
                  />
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button type="submit" size="sm" className="gap-1.5" disabled={invLoading}>
                    <Search className="size-3.5" />
                    {t("billing.searchInvoices")}
                  </Button>
                  {activeSearch ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="gap-1.5"
                      onClick={onClearSearch}
                    >
                      <X className="size-3.5" />
                      {t("common.clear")}
                    </Button>
                  ) : null}
                </div>
              </form>
              {filteredCountLabel && (
                <p className="text-xs text-muted-foreground">
                  {filteredCountLabel}
                  {activeSearch ? (
                    <span className="ml-1 font-medium text-foreground">
                      “{activeSearch}”
                    </span>
                  ) : null}
                </p>
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              {invError && (
                <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {invError}
                </p>
              )}
              {pdfError && (
                <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {pdfError}
                </p>
              )}
              {invLoading && invoices.length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {t("common.loading")}
                </div>
              ) : invoices.length === 0 ? (
                <EmptyState
                  icon={<Receipt className="size-5" />}
                  title={
                    activeSearch
                      ? t("billing.invoicesSearchEmptyTitle")
                      : t("billing.invoicesEmptyTitle")
                  }
                  description={
                    activeSearch
                      ? t("billing.invoicesSearchEmptyDesc")
                      : t("billing.invoicesEmptyDesc")
                  }
                />
              ) : (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("billing.colNumber")}</TableHead>
                        <TableHead>{t("billing.colDate")}</TableHead>
                        <TableHead>{t("billing.colDue")}</TableHead>
                        <TableHead>{t("billing.colPaymentTerms")}</TableHead>
                        <TableHead className="text-right">
                          {t("billing.colAmount")}
                        </TableHead>
                        <TableHead>{t("billing.colStatus")}</TableHead>
                        <TableHead className="text-right">
                          {t("billing.colActions")}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {invoices.map((inv) => (
                        <TableRow key={inv.id}>
                          <TableCell className="font-medium tabular-nums">
                            {inv.number || `#${inv.id}`}
                          </TableCell>
                          <TableCell className="tabular-nums text-muted-foreground">
                            {formatInvoiceDate(inv.invoiceDate)}
                          </TableCell>
                          <TableCell className="tabular-nums text-muted-foreground">
                            {formatInvoiceDate(inv.dueDate)}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {inv.paymentTerms || "—"}
                          </TableCell>
                          <TableCell className="text-right font-medium tabular-nums">
                            {formatMoney(inv.total)}
                          </TableCell>
                          <TableCell>{statusBadge(inv.status)}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-8 gap-1 px-2"
                                onClick={() => {
                                  setPdfError(null);
                                  setPdfInvoice(inv);
                                }}
                                title={t("billing.previewInvoice")}
                              >
                                <Eye className="size-3.5" />
                                <span className="hidden sm:inline">
                                  {t("billing.preview")}
                                </span>
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-8 gap-1 px-2"
                                disabled={pdfBusyId === inv.id}
                                onClick={() => void onPrint(inv)}
                                title={t("billing.printInvoice")}
                              >
                                {pdfBusyId === inv.id ? (
                                  <Loader2 className="size-3.5 animate-spin" />
                                ) : (
                                  <Printer className="size-3.5" />
                                )}
                                <span className="hidden sm:inline">
                                  {t("billing.print")}
                                </span>
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {invoices.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("billing.invoicesCount", {
                    count: String(invoices.length),
                  })}
                </p>
              )}
            </CardContent>
          </Card>
        </BlurFade>
      ) : (
        <BlurFade delay={0.08}>
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileStack className="size-5 text-primary" />
                  {t("billing.contractsTitle")}
                </CardTitle>
                <CardDescription>
                  {t("billing.contractsDescActive")}
                </CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={ctLoading}
                onClick={() => void loadContracts()}
              >
                {ctLoading ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                {t("common.refresh")}
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {t("billing.contractsClickHint")}
              </p>
              {ctError && (
                <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {ctError}
                </p>
              )}
              {ctLoading && contracts.length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {t("common.loading")}
                </div>
              ) : contracts.length === 0 ? (
                <EmptyState
                  icon={<FileStack className="size-5" />}
                  title={t("billing.contractsEmptyTitle")}
                  description={t("billing.contractsEmptyDesc")}
                />
              ) : (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("billing.colName")}</TableHead>
                        <TableHead>{t("billing.colNumber")}</TableHead>
                        <TableHead>{t("billing.colType")}</TableHead>
                        <TableHead>{t("billing.colStatus")}</TableHead>
                        <TableHead className="text-right">
                          {t("billing.colMonthly")}
                        </TableHead>
                        <TableHead>{t("billing.colNextInvoice")}</TableHead>
                        <TableHead>{t("billing.colStart")}</TableHead>
                        <TableHead>{t("billing.colEnd")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {contracts.map((c) => (
                        <TableRow
                          key={c.id}
                          className="cursor-pointer hover:bg-muted/50"
                          tabIndex={0}
                          onClick={() => void openContractServices(c)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              void openContractServices(c);
                            }
                          }}
                        >
                          <TableCell className="font-medium text-primary">
                            {c.name}
                          </TableCell>
                          <TableCell className="tabular-nums text-muted-foreground">
                            {c.number || "—"}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {c.typeLabel || "—"}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                            >
                              {c.statusLabel || t("billing.statusActive")}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right tabular-nums font-medium">
                            {formatMoney(c.monthlyAmount)}
                            {c.monthlyAmount != null && (
                              <span className="ml-1 text-xs font-normal text-muted-foreground">
                                /{t("billing.mo")}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="tabular-nums text-muted-foreground">
                            {formatContractDate(c.nextInvoiceDate)}
                          </TableCell>
                          <TableCell className="tabular-nums text-muted-foreground">
                            {formatContractDate(c.startDate)}
                          </TableCell>
                          <TableCell className="tabular-nums text-muted-foreground">
                            {formatContractDate(c.endDate)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </BlurFade>
      )}

      <Dialog
        open={!!svcContract}
        onOpenChange={(open) => {
          if (!open) {
            setSvcContract(null);
            setServices([]);
            setSvcError(null);
          }
        }}
      >
        <DialogContent className="flex max-h-[90vh] w-[min(96vw,48rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
          <DialogHeader className="shrink-0 space-y-1 border-b border-border px-4 py-3 text-left sm:px-6">
            <DialogTitle className="flex flex-wrap items-center gap-2">
              {t("billing.contractServicesTitle")}
              {svcContract && (
                <span className="text-sm font-normal text-muted-foreground">
                  {svcContract.name}
                </span>
              )}
            </DialogTitle>
            <DialogDescription>
              {t("billing.contractServicesHint")}
              {svcContract?.monthlyAmount != null && (
                <span className="mt-1 block font-medium text-foreground">
                  {t("billing.colMonthly")}:{" "}
                  {formatMoney(svcContract.monthlyAmount)}
                  {svcContract.periodTypeLabel
                    ? ` (${svcContract.periodTypeLabel})`
                    : ""}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-6">
            {svcError && (
              <p className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {svcError}
              </p>
            )}
            {svcLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {t("common.loading")}
              </div>
            ) : services.length === 0 ? (
              <EmptyState
                icon={<FileStack className="size-5" />}
                title={t("billing.servicesEmptyTitle")}
                description={t("billing.servicesEmptyDesc")}
              />
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("billing.colService")}</TableHead>
                      <TableHead className="text-right">
                        {t("billing.colUnits")}
                      </TableHead>
                      <TableHead className="text-right">
                        {t("billing.colUnitPrice")}
                      </TableHead>
                      <TableHead className="text-right">
                        {t("billing.colLineTotal")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {services.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell>
                          <div className="min-w-0">
                            <p className="font-medium">{s.name}</p>
                            {s.description && (
                              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                                {s.description}
                              </p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {s.units != null ? s.units : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatMoney(s.unitPrice)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          {formatMoney(s.lineTotal)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!pdfInvoice}
        onOpenChange={(open) => {
          if (!open) {
            setPdfInvoice(null);
            setPdfError(null);
          }
        }}
      >
        <DialogContent className="flex h-[90vh] max-h-[90vh] w-[min(96vw,56rem)] max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
          <DialogHeader className="shrink-0 space-y-1 border-b border-border px-4 py-3 text-left sm:px-6">
            <DialogTitle className="flex flex-wrap items-center gap-2">
              {t("billing.previewInvoice")}
              {pdfInvoice && (
                <span className="font-mono text-sm font-normal text-muted-foreground">
                  {pdfInvoice.number || `#${pdfInvoice.id}`}
                </span>
              )}
            </DialogTitle>
            <DialogDescription>{t("billing.previewHint")}</DialogDescription>
          </DialogHeader>
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2 sm:px-6">
            {pdfInvoice && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={pdfBusyId === pdfInvoice.id}
                  onClick={() => void onPrint(pdfInvoice)}
                >
                  {pdfBusyId === pdfInvoice.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Printer className="size-3.5" />
                  )}
                  {t("billing.print")}
                </Button>
                <Button asChild size="sm" variant="outline" className="gap-1.5">
                  <a
                    href={invoicePdfUrl(pdfInvoice.id, "inline")}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="size-3.5" />
                    {t("billing.openInNewTab")}
                  </a>
                </Button>
              </>
            )}
          </div>
          <div className="min-h-0 flex-1 bg-muted/30">
            {pdfInvoice ? (
              <iframe
                title={t("billing.previewInvoice")}
                src={invoicePdfUrl(pdfInvoice.id, "inline")}
                className="h-full w-full border-0"
              />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function InvoicesPage() {
  return <BillingPlaceholderPage kind="invoices" />;
}

export function ContractsPage() {
  return <BillingPlaceholderPage kind="contracts" />;
}
