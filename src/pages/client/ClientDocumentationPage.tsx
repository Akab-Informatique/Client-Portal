import { useEffect, useState } from "react";
import { eq } from "drizzle-orm";
import { FileText, Lock } from "lucide-react";
import { db, dbReady, schema } from "@/db";
import { useAuth } from "@/lib/auth";
import type { Company } from "@/lib/types";
import { DocumentationBrowser } from "@/components/DocumentationBrowser";
import { EmptyState } from "@/components/EmptyState";
import { BlurFade } from "@/components/ui/blur-fade";
import { useLocale } from "@/hooks/use-locale";

export function ClientDocumentationPage() {
  const { user } = useAuth();
  const { t } = useLocale();
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user?.company_id) {
        setLoading(false);
        return;
      }
      await dbReady;
      const rows = await db
        .select()
        .from(schema.companies)
        .where(eq(schema.companies.id, user.company_id))
        .limit(1);
      if (!cancelled) {
        setCompany((rows[0] as Company) ?? null);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.company_id]);

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="h-10 w-64 animate-pulse rounded-lg bg-muted" />
        <div className="h-72 animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }

  const enabled =
    company?.documentation_enabled !== false &&
    !!(company?.sharepoint_site_url || "").trim();

  if (!company || !enabled) {
    return (
      <BlurFade delay={0.05}>
        <EmptyState
          icon={<Lock className="size-5" />}
          title={t("docs.notConfigured")}
          description={t("docs.notConfiguredClientDesc")}
        />
      </BlurFade>
    );
  }

  return (
    <BlurFade delay={0.05}>
      <DocumentationBrowser
        companyName={company.name}
        companyId={company.id}
        siteUrl={company.sharepoint_site_url!.trim()}
        folderPath={company.sharepoint_folder_path}
        auth={{
          tenantId: company.sharepoint_tenant_id,
          clientId: company.sharepoint_client_id,
        }}
        title={company.documentation_title}
        description={t("docs.clientIntro")}
      />
    </BlurFade>
  );
}

/** Tiny helper export so tree-shaking keeps the icon import path stable if needed */
export const ClientDocumentationIcon = FileText;
