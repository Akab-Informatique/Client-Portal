import { useEffect, useMemo, useState } from "react";
import { FileText, Search } from "lucide-react";
import { db, dbReady, schema } from "@/db";
import type { Company } from "@/lib/types";
import { DocumentationBrowser } from "@/components/DocumentationBrowser";
import { EmptyState } from "@/components/EmptyState";
import { BlurFade } from "@/components/ui/blur-fade";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useLocale } from "@/hooks/use-locale";
import { fetchSharePointStatus } from "@/lib/sharepoint";

function isDocsLinked(c: Company): boolean {
  return (
    c.documentation_enabled !== false &&
    !!(c.sharepoint_site_url || "").trim()
  );
}

export function AdminDocumentationPage() {
  const { t } = useLocale();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [graphOk, setGraphOk] = useState<"unknown" | "ok" | "fail" | "off">(
    "unknown",
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await dbReady;
      const rows = await db.select().from(schema.companies);
      if (cancelled) return;
      const clients = (rows as Company[])
        .filter((c) => c.type === "client")
        .sort((a, b) => a.name.localeCompare(b.name));
      setCompanies(clients);
      const firstLinked = clients.find(isDocsLinked);
      setSelectedId(firstLinked?.id ?? clients[0]?.id ?? null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    fetchSharePointStatus(false)
      .then((s) => {
        if (!s.configured) setGraphOk("off");
        else setGraphOk(s.ok ? "ok" : "fail");
      })
      .catch(() => setGraphOk("fail"));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return companies;
    return companies.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.sharepoint_site_url ?? "").toLowerCase().includes(q),
    );
  }, [companies, query]);

  const selected = companies.find((c) => c.id === selectedId) ?? null;
  const linked = selected && isDocsLinked(selected);

  return (
    <div className="space-y-6">
      <BlurFade delay={0.05}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-xl font-bold tracking-tight">
              {t("docs.adminTitle")}
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {t("docs.adminDesc")}
            </p>
          </div>
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
        </div>
      </BlurFade>

      <div className="grid gap-6 lg:grid-cols-5">
        <BlurFade delay={0.08} className="lg:col-span-2">
          <Card className="h-full">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                {t("docs.clientList")}
              </CardTitle>
              <CardDescription>{t("docs.clientListDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-9"
                  placeholder={t("docs.searchClients")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>

              {loading ? (
                <div className="space-y-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-12 animate-pulse rounded-lg bg-muted"
                    />
                  ))}
                </div>
              ) : filtered.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {t("common.noResults")}
                </p>
              ) : (
                <ul className="max-h-[28rem] space-y-1 overflow-y-auto pr-1">
                  {filtered.map((c) => {
                    const on = isDocsLinked(c);
                    const active = c.id === selectedId;
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(c.id)}
                          className={cn(
                            "flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors",
                            active
                              ? "border-primary/40 bg-primary/10"
                              : "border-transparent hover:border-border hover:bg-muted/50",
                          )}
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium">
                              {c.name}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {on
                                ? c.documentation_title ||
                                  t("docs.linked")
                                : t("docs.notLinked")}
                            </span>
                          </span>
                          <Badge
                            variant="outline"
                            className={cn(
                              "shrink-0 text-[10px]",
                              on &&
                                "border-primary/40 bg-primary/10 text-primary",
                            )}
                          >
                            {on ? t("docs.linked") : t("docs.notLinked")}
                          </Badge>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </BlurFade>

        <BlurFade delay={0.12} className="lg:col-span-3">
          {!selected ? (
            <EmptyState
              icon={<FileText className="size-5" />}
              title={t("docs.pickClient")}
              description={t("docs.pickClientDesc")}
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
    </div>
  );
}
