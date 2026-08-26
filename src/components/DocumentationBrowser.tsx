import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  ExternalLink,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  Home,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  browseSharePoint,
  fileIconKind,
  formatFileSize,
  type GraphAuthOverride,
} from "@/lib/sharepoint";
import type { SharePointItem } from "@/lib/types";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useLocale } from "@/hooks/use-locale";
import { formatDate } from "@/lib/format";

export type DocumentationBrowserProps = {
  companyName: string;
  /** Used server-side to open sealed Graph secrets — never send secrets from the browser. */
  companyId?: number | null;
  siteUrl: string;
  folderPath?: string | null;
  /** @deprecated prefer auth.tenantId */
  tenantId?: string | null;
  /** Per-client Graph auth (tenant and/or client id + secret). */
  auth?: GraphAuthOverride | null;
  title?: string | null;
  description?: string;
  /** Show company name badge (admin multi-client view) */
  showCompanyBadge?: boolean;
  className?: string;
};

function ItemIcon({ item }: { item: SharePointItem }) {
  const kind = fileIconKind(item);
  const cls = "size-5 shrink-0";
  switch (kind) {
    case "folder":
      return <Folder className={cn(cls, "text-primary")} />;
    case "pdf":
      return <FileText className={cn(cls, "text-destructive")} />;
    case "image":
      return <FileImage className={cn(cls, "text-sky-500")} />;
    case "sheet":
      return <FileSpreadsheet className={cn(cls, "text-emerald-600")} />;
    case "doc":
      return <FileText className={cn(cls, "text-blue-600")} />;
    default:
      return <File className={cn(cls, "text-muted-foreground")} />;
  }
}

export function DocumentationBrowser({
  companyName,
  companyId,
  siteUrl,
  folderPath,
  tenantId,
  auth,
  title,
  description,
  showCompanyBadge,
  className,
}: DocumentationBrowserProps) {
  const { t } = useLocale();
  const [relPath, setRelPath] = useState("");
  const [items, setItems] = useState<SharePointItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  const [siteName, setSiteName] = useState<string | null>(null);
  const [siteWebUrl, setSiteWebUrl] = useState<string | null>(null);
  const [authSource, setAuthSource] = useState<string | null>(null);

  const resolvedAuth: GraphAuthOverride = useMemo(
    () => ({
      tenantId: auth?.tenantId ?? tenantId ?? null,
      clientId: auth?.clientId ?? null,
      clientSecret: auth?.clientSecret ?? null,
    }),
    [auth?.tenantId, auth?.clientId, auth?.clientSecret, tenantId],
  );

  const authKey = useMemo(
    () =>
      [
        String(companyId ?? ""),
        resolvedAuth.tenantId || "",
        resolvedAuth.clientId || "",
        resolvedAuth.clientSecret ? "sec" : "",
      ].join("|"),
    [companyId, resolvedAuth.tenantId, resolvedAuth.clientId, resolvedAuth.clientSecret],
  );

  const crumbs = useMemo(
    () => (relPath ? relPath.split("/").filter(Boolean) : []),
    [relPath],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await browseSharePoint({
        siteUrl,
        basePath: folderPath || undefined,
        path: relPath || undefined,
        companyId: companyId ?? undefined,
        auth: resolvedAuth,
      });
      setConfigured(data.configured !== false);
      setItems(data.items ?? []);
      setSiteName(data.site?.name ?? null);
      setSiteWebUrl(data.site?.webUrl ?? siteUrl);
      setAuthSource(data.auth?.source ?? null);
      if (data.error) setError(data.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("docs.loadError"));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [siteUrl, folderPath, resolvedAuth, relPath, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reset path when company/site/auth changes
  useEffect(() => {
    setRelPath("");
  }, [siteUrl, folderPath, authKey]);

  const openFolder = (name: string) => {
    setRelPath((prev) => (prev ? `${prev}/${name}` : name));
  };

  const goCrumb = (index: number) => {
    // -1 = root
    if (index < 0) {
      setRelPath("");
      return;
    }
    setRelPath(crumbs.slice(0, index + 1).join("/"));
  };

  const heading = title?.trim() || t("docs.title");

  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xl">
            <FileText className="size-5 text-primary" />
            {heading}
            {showCompanyBadge && (
              <Badge
                variant="outline"
                className="border-primary/40 bg-primary/10 font-normal text-primary"
              >
                {companyName}
              </Badge>
            )}
            {authSource === "client_app" && (
              <Badge
                variant="outline"
                className="border-emerald-500/40 bg-emerald-500/10 font-normal text-emerald-700 dark:text-emerald-300"
              >
                {t("docs.authClientApp")}
              </Badge>
            )}
            {authSource === "portal_app" && (
              <Badge variant="outline" className="font-normal">
                {t("docs.authPortalApp")}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            {description || t("docs.privateDesc", { company: companyName })}
          </CardDescription>
          {(siteName || siteWebUrl) && (
            <p className="pt-1 text-xs text-muted-foreground">
              {siteName ? (
                <span className="font-medium text-foreground/80">
                  {siteName}
                </span>
              ) : null}
              {siteName && siteWebUrl ? " · " : null}
              {siteWebUrl ? (
                <a
                  href={siteWebUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  {t("docs.openInSharePoint")}
                  <ExternalLink className="size-3" />
                </a>
              ) : null}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 gap-2"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          {t("docs.refresh")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Breadcrumbs */}
        <nav
          aria-label={t("docs.breadcrumb")}
          className="flex flex-wrap items-center gap-1 text-sm"
        >
          <button
            type="button"
            onClick={() => goCrumb(-1)}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors hover:bg-muted",
              crumbs.length === 0
                ? "font-semibold text-foreground"
                : "text-muted-foreground",
            )}
          >
            <Home className="size-3.5" />
            {t("docs.root")}
          </button>
          {crumbs.map((c, i) => (
            <span key={`${c}-${i}`} className="inline-flex items-center gap-1">
              <ChevronRight className="size-3.5 text-muted-foreground" />
              <button
                type="button"
                onClick={() => goCrumb(i)}
                className={cn(
                  "rounded-md px-2 py-1 transition-colors hover:bg-muted",
                  i === crumbs.length - 1
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {c}
              </button>
            </span>
          ))}
        </nav>

        {!configured && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
            {t("docs.graphNotConfigured")}
          </div>
        )}

        {error && configured && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="h-14 animate-pulse rounded-lg bg-muted"
              />
            ))}
          </div>
        ) : items.length === 0 && !error ? (
          <EmptyState
            icon={<Folder className="size-5" />}
            title={t("docs.empty")}
            description={t("docs.emptyDesc")}
          />
        ) : items.length === 0 ? null : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {items.map((item) => {
              const content = (
                <div className="flex items-center gap-3 px-3 py-3 sm:px-4">
                  <ItemIcon item={item} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {item.isFolder
                        ? item.childCount != null
                          ? t("docs.folderItems", { n: item.childCount })
                          : t("docs.folder")
                        : formatFileSize(item.size)}
                      {item.lastModified
                        ? ` · ${formatDate(item.lastModified)}`
                        : ""}
                    </p>
                  </div>
                  {item.isFolder ? (
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ExternalLink className="size-4 shrink-0 text-muted-foreground" />
                  )}
                </div>
              );

              if (item.isFolder) {
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="w-full text-left transition-colors hover:bg-muted/50"
                      onClick={() => openFolder(item.name)}
                    >
                      {content}
                    </button>
                  </li>
                );
              }

              if (item.webUrl) {
                return (
                  <li key={item.id}>
                    <a
                      href={item.webUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block transition-colors hover:bg-muted/50"
                    >
                      {content}
                    </a>
                  </li>
                );
              }

              return <li key={item.id}>{content}</li>;
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
