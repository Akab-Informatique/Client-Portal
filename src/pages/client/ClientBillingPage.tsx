import { useCallback, useEffect, useState } from "react";
import {
  ExternalLink,
  FileStack,
  Loader2,
  Receipt,
  RefreshCw,
} from "lucide-react";
import { eq } from "drizzle-orm";
import { useAuth } from "@/lib/auth";
import { useLocale } from "@/hooks/use-locale";
import { db, dbReady, schema } from "@/db";
import type { Company } from "@/lib/types";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Client billing: Autotask invoices + restricted contracts.
 * Payment portal is a fixed top button (ConnectBooster login).
 */
export function ClientBillingPage() {
  const { t } = useLocale();
  const { user } = useAuth();
  const [company, setCompany] = useState<Company | null>(null);
  const [loadingCo, setLoadingCo] = useState(true);

  const [invLoading, setInvLoading] = useState(false);
  const [invoices, setInvoices] = useState<ClientInvoice[]>([]);
  const [invError, setInvError] = useState<string | null>(null);

  const [ctLoading, setCtLoading] = useState(false);
  const [contracts, setContracts] = useState<ClientSafeContract[]>([]);
  const [ctError, setCtError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user?.company_id) {
        setCompany(null);
        setLoadingCo(false);
        return;
      }
      setLoadingCo(true);
      try {
        await dbReady;
        const rows = (await db
          .select()
          .from(schema.companies)
          .where(eq(schema.companies.id, user.company_id))
          .limit(1)) as Company[];
        if (!cancelled) setCompany(rows[0] ?? null);
      } catch {
        if (!cancelled) setCompany(null);
      } finally {
        if (!cancelled) setLoadingCo(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.company_id]);

  const loadInvoices = useCallback(async () => {
    if (!company) return;
    const atId = (company.autotask_company_id || "").trim();
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
      if (res.error && res.invoices.length === 0) {
        setInvError(res.error);
      }
    } catch (e) {
      setInvError(
        e instanceof Error ? e.message : t("billing.invoicesLoadFailed"),
      );
      setInvoices([]);
    } finally {
      setInvLoading(false);
    }
  }, [company, t]);

  const loadContracts = useCallback(async () => {
    if (!company) return;
    const atId = (company.autotask_company_id || "").trim();
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
  }, [company, t]);

  useEffect(() => {
    if (!company || !user?.billing_enabled) return;
    void loadInvoices();
    void loadContracts();
  }, [company, user?.billing_enabled, loadInvoices, loadContracts]);

  if (!user?.billing_enabled) {
    return (
      <EmptyState
        icon={<Receipt className="size-5" />}
        title={t("billing.clientDeniedTitle")}
        description={t("billing.clientDeniedDesc")}
      />
    );
  }

  if (loadingCo) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t("common.loading")}
      </div>
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
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-bold tracking-tight">
                {t("billing.clientTitle")}
              </h2>
              {(user.client_role_names?.length
                ? user.client_role_names
                : user.client_role_name
                  ? [user.client_role_name]
                  : []
              ).map((name) => (
                <Badge
                  key={name}
                  variant="outline"
                  className="border-primary/40 bg-primary/10 text-primary"
                >
                  {name}
                </Badge>
              ))}
            </div>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {t("billing.clientDesc")}
            </p>
          </div>
          <Button asChild className="gap-1.5 shrink-0">
            <a
              href={PAYMENT_PORTAL_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="size-4" />
              {t("billing.openPaymentPortal")}
            </a>
          </Button>
        </div>
      </BlurFade>

      <BlurFade delay={0.06}>
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 text-sm">
              <p className="font-medium">{t("billing.paymentPortalTitle")}</p>
              <p className="text-xs text-muted-foreground">
                {t("billing.paymentPortalHint")}
              </p>
            </div>
            <Button asChild variant="outline" size="sm" className="gap-1.5 shrink-0">
              <a
                href={PAYMENT_PORTAL_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="size-3.5" />
                {t("billing.openPaymentPortal")}
              </a>
            </Button>
          </CardContent>
        </Card>
      </BlurFade>

      <BlurFade delay={0.08}>
        <Tabs defaultValue="invoices" className="space-y-4">
          <TabsList>
            <TabsTrigger value="invoices" className="gap-1.5">
              <Receipt className="size-3.5" />
              {t("nav.invoices")}
            </TabsTrigger>
            <TabsTrigger value="contracts" className="gap-1.5">
              <FileStack className="size-3.5" />
              {t("nav.contracts")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="invoices" className="space-y-4">
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
          </TabsContent>

          <TabsContent value="contracts" className="space-y-4">
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
                            <TableCell>
                              <div className="min-w-0">
                                <p className="font-medium">{c.name}</p>
                                {c.description && (
                                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                                    {c.description}
                                  </p>
                                )}
                              </div>
                            </TableCell>
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
          </TabsContent>
        </Tabs>
      </BlurFade>
    </div>
  );
}
