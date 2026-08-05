import { FileStack, Receipt } from "lucide-react";
import { Link } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { useLocale } from "@/hooks/use-locale";
import { BlurFade } from "@/components/ui/blur-fade";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * Client-facing billing workspace (Invoices + Contracts).
 * Only reachable when session.billing_enabled is true.
 * Autotask data wiring comes later — placeholders for now.
 */
export function ClientBillingPage() {
  const { t } = useLocale();
  const { user } = useAuth();

  if (!user?.billing_enabled) {
    return (
      <EmptyState
        icon={<Receipt className="size-5" />}
        title={t("billing.clientDeniedTitle")}
        description={t("billing.clientDeniedDesc")}
      />
    );
  }

  return (
    <div className="space-y-6">
      <BlurFade delay={0.04}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
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

          <TabsContent value="invoices">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Receipt className="size-5 text-primary" />
                  {t("billing.invoicesTitle")}
                </CardTitle>
                <CardDescription>{t("billing.invoicesDesc")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
                <p>{t("billing.comingSoonTitle")}</p>
                <p>{t("billing.invoicesSoonDetail")}</p>
                <p>
                  <Link
                    to="/client"
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {t("nav.dashboard")}
                  </Link>
                </p>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="contracts">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileStack className="size-5 text-primary" />
                  {t("billing.contractsTitle")}
                </CardTitle>
                <CardDescription>{t("billing.contractsDesc")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
                <p>{t("billing.comingSoonTitle")}</p>
                <p>{t("billing.contractsSoonDetail")}</p>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </BlurFade>
    </div>
  );
}
