import { useCallback, useEffect, useState } from "react";
import {
  ExternalLink,
  FileStack,
  Loader2,
  Receipt,
  RefreshCw,
} from "lucide-react";
import { eq } from "drizzle-orm";
import { Link } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useLocale } from "@/hooks/use-locale";
import { db, dbReady, schema } from "@/db";
import type { Company } from "@/lib/types";
import {
  fetchConnectBoosterInvoices,
  formatMoney,
  type ConnectBoosterInvoice,
} from "@/lib/connectbooster";
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
 * Client-facing billing workspace (Invoices + Contracts).
 * Invoices → ConnectBooster (portal pay + optional API list)
 * Contracts → Autotask client-safe projection (no cost/profit)
 */
export function ClientBillingPage() {
  const { t } = useLocale();
  const { user } = useAuth();
  const [company, setCompany] = useState<Company | null>(null);
  const [loadingCo, setLoadingCo] = useState(true);

  const [invLoading, setInvLoading] = useState(false);
  const [invoices, setInvoices] = useState<ConnectBoosterInvoice[]>([]);
  const [invError, setInvError] = useState<string | null>(null);
  const [portalUrl, setPortalUrl] = useState<string | null>(null);
  const [payUrl, setPayUrl] = useState<string | null>(null);
  const [invSource, setInvSource] = useState<string | null>(null);

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
    const customerId = (company.connectbooster_customer_id || "").trim();
    const overridePortal = (company.connectbooster_portal_url || "").trim();

    setInvLoading(true);
    setInvError(null);
    try {
      if (!customerId && !overridePortal) {
        setInvoices([]);
        setPortalUrl(null);
        setPayUrl(null);
        setInvSource(null);
        setInvError(t("billing.noConnectBoosterId"));
        return;
      }
      if (customerId) {
        const res = await fetchConnectBoosterInvoices(customerId);
        setInvoices(res.invoices);
        setPortalUrl(overridePortal || res.portalUrl);
        setPayUrl(res.payUrl || overridePortal || res.portalUrl);
        setInvSource(res.source ?? null);
        if (res.error && res.invoices.length === 0) {
          setInvError(res.error);
        }
      } else {
        setInvoices([]);
        setPortalUrl(overridePortal);
        setPayUrl(overridePortal);
        setInvSource("portal_only");
      }
    } catch (e) {
      setInvError(e instanceof Error ? e.message : t("billing.invoicesLoadFailed"));
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
      setCtError(e instanceof Error ? e.message : t("billing.contractsLoadFailed"));
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

  const openExternal = (url: string | null | undefined) => {
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
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
          <div className="flex flex-wrap gap-2">
            {portalUrl && (
              <Button
                type="button"
                variant="default"
                size="sm"
                className="gap-1.5"
                onClick={() => openExternal(portalUrl)}
              >
                <ExternalLink className="size-3.5" />
                {t("billing.openCbPortal")}
              </Button>
            )}
            {payUrl && payUrl !== portalUrl && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => openExternal(payUrl)}
              >
                <Receipt className="size-3.5" />
                {t("billing.payInCb")}
              </Button>
            )}
          </div>
        </div>
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
              <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Receipt className="size-5 text-primary" />
                    {t("billing.invoicesTitle")}
                  </CardTitle>
                  <CardDescription>{t("billing.invoicesDescCb")}</CardDescription>
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
              <CardContent className="space-y-4">
                {invError && (
                  <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
                    {invError}
                  </p>
                )}

                {!company?.connectbooster_customer_id && !portalUrl ? (
                  <EmptyState
                    icon={<Receipt className="size-5" />}
                    title={t("billing.noConnectBoosterTitle")}
                    description={t("billing.noConnectBoosterId")}
                  />
                ) : invLoading && invoices.length === 0 ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    {t("common.loading")}
                  </div>
                ) : invoices.length === 0 ? (
                  <div className="space-y-3 rounded-lg border border-dashed border-border p-6 text-center">
                    <p className="text-sm text-muted-foreground">
                      {invSource === "portal_only" || !invSource
                        ? t("billing.invoicesPortalOnly")
                        : t("billing.invoicesEmpty")}
                    </p>
                    {portalUrl && (
                      <Button
                        type="button"
                        className="gap-1.5"
                        onClick={() => openExternal(portalUrl)}
                      >
                        <ExternalLink className="size-3.5" />
                        {t("billing.openCbPortal")}
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("billing.colInvoice")}</TableHead>
                          <TableHead>{t("billing.colStatus")}</TableHead>
                          <TableHead>{t("billing.colIssued")}</TableHead>
                          <TableHead>{t("billing.colDue")}</TableHead>
                          <TableHead className="text-right">
                            {t("billing.colBalance")}
                          </TableHead>
                          <TableHead className="text-right">
                            {t("common.actions")}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {invoices.map((inv) => (
                          <TableRow key={inv.id}>
                            <TableCell className="font-medium">
                              {inv.number || inv.id}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={
                                  inv.statusKind === "open" ||
                                  inv.statusKind === "partial"
                                    ? "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200"
                                    : inv.statusKind === "paid"
                                      ? "border-primary/40 bg-primary/10 text-primary"
                                      : ""
                                }
                              >
                                {inv.status || inv.statusKind}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {formatContractDate(inv.issueDate)}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {formatContractDate(inv.dueDate)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums font-medium">
                              {formatMoney(inv.balance, inv.currency || "USD")}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-1">
                                {(inv.statusKind === "open" ||
                                  inv.statusKind === "partial" ||
                                  (inv.balance != null && inv.balance > 0)) &&
                                  (inv.payUrl || payUrl) && (
                                    <Button
                                      type="button"
                                      size="sm"
                                      className="gap-1"
                                      onClick={() =>
                                        openExternal(inv.payUrl || payUrl)
                                      }
                                    >
                                      {t("billing.pay")}
                                      <ExternalLink className="size-3" />
                                    </Button>
                                  )}
                                {(inv.viewUrl || portalUrl) && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      openExternal(inv.viewUrl || portalUrl)
                                    }
                                  >
                                    {t("billing.view")}
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

                <p className="text-xs text-muted-foreground">
                  {t("billing.invoicesFootnote")}
                </p>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="contracts" className="space-y-4">
            <Card>
              <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <FileStack className="size-5 text-primary" />
                    {t("billing.contractsTitle")}
                  </CardTitle>
                  <CardDescription>{t("billing.contractsDescSafe")}</CardDescription>
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
              <CardContent className="space-y-4">
                <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  {t("billing.contractsPrivacyNote")}
                </p>

                {ctError && (
                  <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
                    {ctError}
                  </p>
                )}

                {ctLoading && contracts.length === 0 ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    {t("common.loading")}
                  </div>
                ) : contracts.length === 0 && !ctError ? (
                  <EmptyState
                    icon={<FileStack className="size-5" />}
                    title={t("billing.contractsEmptyTitle")}
                    description={t("billing.contractsEmptyDesc")}
                  />
                ) : contracts.length > 0 ? (
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("billing.colContract")}</TableHead>
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
                                {c.number && (
                                  <p className="text-xs text-muted-foreground">
                                    #{c.number}
                                  </p>
                                )}
                                {c.description && (
                                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                                    {c.description}
                                  </p>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {c.typeLabel || "—"}
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline">
                                {c.statusLabel || "—"}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {formatContractDate(c.startDate)}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {formatContractDate(c.endDate)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </BlurFade>

      <p className="text-center text-xs text-muted-foreground">
        <Link
          to="/client"
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          {t("nav.dashboard")}
        </Link>
      </p>
    </div>
  );
}
