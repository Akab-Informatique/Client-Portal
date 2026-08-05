import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { Link } from "react-router-dom";
import type { Company } from "@/lib/types";
import { DocumentationBrowser } from "@/components/DocumentationBrowser";
import { EmptyState } from "@/components/EmptyState";
import { BlurFade } from "@/components/ui/blur-fade";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useLocale } from "@/hooks/use-locale";
import { fetchSharePointStatus } from "@/lib/sharepoint";
import { useSelectedClient } from "@/context/SelectedClientContext";

function isDocsLinked(c: Company): boolean {
  return (
    c.documentation_enabled !== false &&
    !!(c.sharepoint_site_url || "").trim()
  );
}

export function AdminDocumentationPage() {
  const { t } = useLocale();
  const {
    selectedClient,
    clients,
    loading: clientsLoading,
  } = useSelectedClient();
  const [graphOk, setGraphOk] = useState<"unknown" | "ok" | "fail" | "off">(
    "unknown",
  );

  useEffect(() => {
    fetchSharePointStatus(false)
      .then((s) => {
        if (!s.configured) setGraphOk("off");
        else setGraphOk(s.ok ? "ok" : "fail");
      })
      .catch(() => setGraphOk("fail"));
  }, []);

  const selected = selectedClient;
  const linked = selected ? isDocsLinked(selected) : false;

  return (
    <div className="space-y-6">
      <BlurFade delay={0.05}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-bold tracking-tight">
                {t("docs.adminTitle")}
              </h2>
              {selected && (
                <Badge
                  variant="outline"
                  className="border-primary/40 bg-primary/10 text-primary"
                >
                  {selected.name}
                </Badge>
              )}
            </div>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {t("docs.adminDesc")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("docs.usesSidebarClient")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className={cn(
                graphOk === "ok" &&
                  "border-primary/40 bg-primary/10 text-primary",
                graphOk === "off" && "text-muted-foreground",
                graphOk === "fail" &&
                  "border-destructive/40 bg-destructive/10 text-destructive",
              )}
            >
              {graphOk === "ok"
                ? t("docs.graphConnected")
                : graphOk === "off"
                  ? t("docs.graphOff")
                  : graphOk === "fail"
                    ? t("docs.graphFail")
                    : t("common.loading")}
            </Badge>
            <Button asChild variant="outline" size="sm">
              <Link to="/admin/clients">{t("docs.goToClients")}</Link>
            </Button>
          </div>
        </div>
      </BlurFade>

      <BlurFade delay={0.1}>
        {clientsLoading ? (
          <div className="h-64 animate-pulse rounded-2xl bg-muted" />
        ) : clients.length === 0 ? (
          <EmptyState
            icon={<FileText className="size-5" />}
            title={t("nav.noClients")}
            description={t("billing.noClientsDesc")}
            actionLabel={t("nav.clients")}
            onAction={() => {
              window.location.href = "/admin/clients";
            }}
          />
        ) : !selected ? (
          <EmptyState
            icon={<FileText className="size-5" />}
            title={t("docs.pickClient")}
            description={t("docs.pickClientSidebar")}
          />
        ) : !linked ? (
          <Card>
            <CardContent className="py-12">
              <EmptyState
                icon={<FileText className="size-5" />}
                title={t("docs.notConfigured")}
                description={t("docs.notConfiguredAdminDesc", {
                  company: selected.name,
                })}
                actionLabel={t("docs.goToClients")}
                onAction={() => {
                  window.location.href = "/admin/clients";
                }}
              />
            </CardContent>
          </Card>
        ) : (
          <DocumentationBrowser
            companyName={selected.name}
            siteUrl={selected.sharepoint_site_url!.trim()}
            folderPath={selected.sharepoint_folder_path}
            auth={{
              tenantId: selected.sharepoint_tenant_id,
              clientId: selected.sharepoint_client_id,
              clientSecret: selected.sharepoint_client_secret,
            }}
            title={selected.documentation_title}
            showCompanyBadge
            description={t("docs.adminBrowseDesc")}
          />
        )}
      </BlurFade>
    </div>
  );
}
