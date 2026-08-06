import { useCallback, useEffect, useState } from "react";
import {
  ExternalLink,
  FileStack,
  Loader2,
  Receipt,
  RefreshCw,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useSelectedClient } from "@/context/SelectedClientContext";
import { useLocale } from "@/hooks/use-locale";
import {
  PAYMENT_PORTAL_URL,
  fetchClientInvoices,
  formatInvoiceDate,
  formatMoney,
  type ClientInvoice,
} from "@/lib/invoices";
import {
  fetchClientContracts,
  formatContractDate,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type BillingKind = "invoices" | "contracts";

export function BillingPlaceholderPage({ kind }: { kind: BillingKind }) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const { selectedClient, clients, loading } = useSelectedClient();

  const [invLoading, setInvLoading] = useState(false);
  const [invoices, setInvoices] = useState<ClientInvoice[]>([]);
  const [invError, setInvError] = useState<string | null>(null);

  const [ctLoading, setCtLoading] = useState(false);
  const [contracts, setContracts] = useState<ClientSafeContract[]>([]);
  const [ctError, setCtError] = useState<string | null>(null);

  const title =
    kind === "invoices" ? t("billing.invoicesTitle") : t("billing.contractsTitle");
  const desc =
    kind === "invoices"
      ? t("billing.invoicesDescAt")
      : t("billing.contractsDescSafe");
  const Icon = kind === "invoices" ? Receipt : FileStack;

  const loadInvoices = useCallback(async () => {
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
      const res = await fetchClientInvoices(atId);
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
  }, [selectedClient, t]);

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
      const res = await fetchClientContracts(atId);
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

  useEffect(() => {
    if (!selectedClient) return;
    if (kind === "invoices") void loadInvoices();
    else void loadContracts();
  }, [selectedClient, kind, loadInvoices, loadContracts]);

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
    if (status === "voided") {
      return (
        <Badge variant="outline" className="text-muted-foreground">
          {t("billing.statusVoided")}
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
                  {t("billing.openPaymentPortal")}
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
            <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
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
                className="gap-1.5"
                disabled={invLoading}
                onClick={() => void loadInvoices()}
              >
                {invLoading ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                {t("common.refresh")}
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {invError && (
                <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {invError}
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
                  title={t("billing.invoicesEmptyTitle")}
                  description={t("billing.invoicesEmptyDesc")}
                />
              ) : (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("billing.colNumber")}</TableHead>
                        <TableHead>{t("billing.colDate")}</TableHead>
                        <TableHead>{t("billing.colDue")}</TableHead>
                        <TableHead className="text-right">
                          {t("billing.colAmount")}
                        </TableHead>
                        <TableHead>{t("billing.colStatus")}</TableHead>
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
                          <TableCell className="text-right font-medium tabular-nums">
                            {formatMoney(inv.total)}
                          </TableCell>
                          <TableCell>{statusBadge(inv.status)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
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
                  {t("billing.contractsDescSafe")}
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
                {t("billing.contractsPrivacyNote")}
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
                        <TableHead>{t("billing.colStart")}</TableHead>
                        <TableHead>{t("billing.colEnd")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {contracts.map((c) => (
                        <TableRow key={c.id}>
                          <TableCell className="font-medium">{c.name}</TableCell>
                          <TableCell className="tabular-nums text-muted-foreground">
                            {c.number || "—"}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {c.typeLabel || "—"}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">
                              {c.statusLabel || "—"}
                            </Badge>
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
    </div>
  );
}

export function InvoicesPage() {
  return <BillingPlaceholderPage kind="invoices" />;
}

export function ContractsPage() {
  return <BillingPlaceholderPage kind="contracts" />;
}
