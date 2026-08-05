import { FileStack, Receipt } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useSelectedClient } from "@/context/SelectedClientContext";
import { useLocale } from "@/hooks/use-locale";
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

type BillingKind = "invoices" | "contracts";

export function BillingPlaceholderPage({ kind }: { kind: BillingKind }) {
  const { t } = useLocale();
  const navigate = useNavigate();
  const { selectedClient, clients, loading } = useSelectedClient();

  const title =
    kind === "invoices" ? t("billing.invoicesTitle") : t("billing.contractsTitle");
  const desc =
    kind === "invoices" ? t("billing.invoicesDesc") : t("billing.contractsDesc");
  const Icon = kind === "invoices" ? Receipt : FileStack;

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
          <Button asChild variant="outline" size="sm">
            <Link to="/admin/clients">{t("billing.manageClients")}</Link>
          </Button>
        </div>
      </BlurFade>

      <BlurFade delay={0.08}>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Icon className="size-5 text-primary" />
              {t("billing.comingSoonTitle")}
            </CardTitle>
            <CardDescription>{t("billing.comingSoonDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              {kind === "invoices"
                ? t("billing.invoicesSoonDetail")
                : t("billing.contractsSoonDetail")}
            </p>
            {selectedClient?.autotask_company_id ? (
              <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-foreground">
                Autotask company ID: {selectedClient.autotask_company_id}
              </p>
            ) : (
              <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs">
                {t("billing.noAutotaskId")}
              </p>
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
