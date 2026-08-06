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
  const [invoices, setInvoices] = useState<ConnectBoosterInvoice[]>([]);
  const [invError, setInvError] = useState<string | null>(null);
  const [portalUrl, setPortalUrl] = useState<string | null>(null);
  const [payUrl, setPayUrl] = useState<string | null>(null);

  const [ctLoading, setCtLoading] = useState(false);
  const [contracts, setContracts] = useState<ClientSafeContract[]>([]);
  const [ctError, setCtError] = useState<string | null>(null);

  const title =
    kind === "invoices" ? t("billing.invoicesTitle") : t("billing.contractsTitle");
  const desc =
    kind === "invoices" ? t("billing.invoicesDescCb") : t("billing.contractsDescSafe");
  const Icon = kind === "invoices" ? Receipt : FileStack;

  const loadInvoices = useCallback(async () => {
    if (!selectedClient) return;
    const customerId = (selectedClient.connectbooster_customer_id || "").trim();
    const override = (selectedClient.connectbooster_portal_url || "").trim();
    setInvLoading(true);
    setInvError(null);
    try {
      if (!customerId) {
        setInvoices([]);
        setPortalUrl(override || null);
        setPayUrl(override || null);
        setInvError(t("billing.noConnectBoosterId"));
        return;
      }
      const res = await fetchConnectBoosterInvoices(customerId);
      setInvoices(res.invoices);
      setPortalUrl(override || res.portalUrl);
      setPayUrl(res.payUrl || override || res.portalUrl);
      if (res.error && res.invoices.length === 0) setInvError(res.error);
    } catch (e) {
      setInvError(e instanceof Error ? e.message : t("billing.invoicesLoadFailed"));
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
      setCtError(e instanceof Error ? e.message : t("billing.contractsLoadFailed"));
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

  const openExternal = (url: string | null | undefined) => {
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
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
            {kind === "invoices" && portalUrl && (
              <Button
                type="button"
                size="sm"
                className="gap-1.5"
                onClick={() => openExternal(portalUrl)}
              >
                <ExternalLink className="size-3.5" />
                {t("billing.openCbPortal")}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={kind === "invoices" ? invLoading : ctLoading}
              onClick={() =>
                void (kind === "invoices" ? loadInvoices() : loadContracts())
              }
            >
              {(kind === "invoices" ? invLoading : ctLoading) ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {t("common.refresh")}
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/admin/clients">{t("billing.manageClients")}</Link>
            </Button>
          </div>
        </div>
      </BlurFade>

      <BlurFade delay={0.08}>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Icon className="size-5 text-primary" />
              {title}
            </CardTitle>
            <CardDescription>
              {kind === "contracts"
                ? t("billing.contractsPrivacyNote")
                : t("billing.invoicesFootnote")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {kind === "invoices" && (
              <>
                {invError && (
                  <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
                    {invError}
                  </p>
                )}
                {selectedClient && (
                  <p className="font-mono text-xs text-muted-foreground">
                    CB customer:{" "}
                    {selectedClient.connectbooster_customer_id || "—"} · AT company:{" "}
                    {selectedClient.autotask_company_id || "—"}
                  </p>
                )}
                {invLoading && invoices.length === 0 ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    {t("common.loading")}
                  </div>
                ) : invoices.length === 0 ? (
                  <div className="space-y-3 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                    <p>{t("billing.invoicesPortalOnly")}</p>
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
                  <div className="overflow-x-auto rounded-lg border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("billing.colInvoice")}</TableHead>
                          <TableHead>{t("billing.colStatus")}</TableHead>
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
                              <Badge variant="outline">
                                {inv.status || inv.statusKind}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              {formatContractDate(inv.dueDate)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatMoney(inv.balance, inv.currency || "USD")}
                            </TableCell>
                            <TableCell className="text-right">
                              {(inv.payUrl || payUrl) && (
                                <Button
                                  type="button"
                                  size="sm"
                                  onClick={() =>
                                    openExternal(inv.payUrl || payUrl)
                                  }
                                >
                                  {t("billing.pay")}
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            )}

            {kind === "contracts" && (
              <>
                {ctError && (
                  <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
                    {ctError}
                  </p>
                )}
                {ctLoading && contracts.length === 0 ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    {t("common.loading")}
                  </div>
                ) : contracts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("billing.contractsEmptyDesc")}
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-lg border">
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
                            <TableCell className="font-medium">
                              {c.name}
                              {c.number ? (
                                <span className="ml-1 text-xs text-muted-foreground">
                                  #{c.number}
                                </span>
                              ) : null}
                            </TableCell>
                            <TableCell>{c.typeLabel || "—"}</TableCell>
                            <TableCell>
                              <Badge variant="outline">
                                {c.statusLabel || "—"}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              {formatContractDate(c.startDate)}
                            </TableCell>
                            <TableCell>
                              {formatContractDate(c.endDate)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </BlurFade>
    </div>
  );
}

export function InvoicesPage() {
  return <BillingPlaceholderPage kind="invoices" />;
}

export function ContractsPage() {
  return <BillingPlaceholderPage kind="contracts" />;
}
