import { Link } from "react-router-dom";
import {
  Building2,
  Cable,
  Cloud,
  FileText,
  Settings2,
  Shield,
  Wrench,
} from "lucide-react";
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
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/lib/auth";
import { useLocale } from "@/hooks/use-locale";
import { useEffect, useState } from "react";
import { db, dbReady, schema } from "@/db";
import type { Company } from "@/lib/types";
import {
  fetchSharePointStatus,
  isCompanySharePointLinked,
} from "@/lib/sharepoint";

type ConnState = "unknown" | "ok" | "fail" | "off";

export function SettingsPage() {
  const { t } = useLocale();
  const { can } = useAuth();
  const [atStatus, setAtStatus] = useState<ConnState>("unknown");
  const [spStatus, setSpStatus] = useState<ConnState>("unknown");
  const [linkedClients, setLinkedClients] = useState<number | null>(null);
  const [totalClients, setTotalClients] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/autotask/status")
      .then((r) => r.json())
      .then((d: { ok?: boolean }) => setAtStatus(d.ok ? "ok" : "fail"))
      .catch(() => setAtStatus("fail"));
    fetchSharePointStatus(false)
      .then((s) => {
        if (!s.configured) setSpStatus("off");
        else setSpStatus(s.ok ? "ok" : "fail");
      })
      .catch(() => setSpStatus("fail"));
    let cancelled = false;
    (async () => {
      await dbReady;
      const rows = (await db.select().from(schema.companies)) as Company[];
      if (cancelled) return;
      const clients = rows.filter((c) => c.type === "client");
      setTotalClients(clients.length);
      setLinkedClients(clients.filter(isCompanySharePointLinked).length);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const statusBadge = (state: ConnState, okLabel: string, offLabel: string) => {
    if (state === "ok") {
      return (
        <Badge
          variant="outline"
          className="border-primary/40 bg-primary/10 text-primary"
        >
          {okLabel}
        </Badge>
      );
    }
    if (state === "off") {
      return <Badge variant="outline">{offLabel}</Badge>;
    }
    if (state === "fail") {
      return (
        <Badge
          variant="outline"
          className="border-destructive/40 text-destructive"
        >
          {t("settings.statusIssue")}
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {t("common.loading")}
      </Badge>
    );
  };

  return (
    <div className="space-y-6">
      <BlurFade delay={0.04}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">
              {t("settings.title")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("settings.subtitle")}
            </p>
          </div>
          <Badge variant="outline" className="w-fit gap-1">
            <Settings2 className="size-3.5" />
            {t("settings.badge")}
          </Badge>
        </div>
      </BlurFade>

      <BlurFade delay={0.08}>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("settings.managementTitle")}
            </CardTitle>
            <CardDescription>{t("settings.managementDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {can("clients") && (
              <Link
                to="/admin/clients"
                className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-primary/5"
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Building2 className="size-5" />
                </div>
                <div className="min-w-0">
                  <p className="font-semibold">{t("nav.clients")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("settings.linkClients")}
                  </p>
                </div>
              </Link>
            )}
            {(can("technicians") || can("roles")) && (
              <Link
                to="/admin/technicians"
                className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-primary/5"
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Wrench className="size-5" />
                </div>
                <div className="min-w-0">
                  <p className="font-semibold">{t("nav.technicians")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("settings.linkStaff")}
                  </p>
                </div>
              </Link>
            )}
          </CardContent>
        </Card>
      </BlurFade>

      <BlurFade delay={0.12}>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Cable className="size-4 text-primary" />
              {t("settings.integrationsTitle")}
            </CardTitle>
            <CardDescription>{t("settings.integrationsDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Cloud className="size-5 text-foreground" />
                </div>
                <div>
                  <p className="font-semibold">Autotask PSA</p>
                  <p className="text-xs text-muted-foreground">
                    {t("settings.autotaskHint")}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {statusBadge(
                  atStatus,
                  t("settings.statusConnected"),
                  t("settings.statusNotConfigured"),
                )}
              </div>
            </div>

            <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <FileText className="size-5 text-foreground" />
                  </div>
                  <div>
                    <p className="font-semibold">
                      Microsoft Graph / SharePoint
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("settings.graphHint")}
                    </p>
                    <p className="mt-1.5 text-xs font-medium text-foreground/80">
                      {t("settings.graphPerClient")}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {statusBadge(
                    spStatus,
                    t("settings.graphAppReady"),
                    t("settings.statusNotConfigured"),
                  )}
                  {linkedClients != null && totalClients != null && (
                    <Badge variant="outline" className="tabular-nums">
                      {t("settings.graphLinkedCount", {
                        linked: linkedClients,
                        total: totalClients,
                      })}
                    </Badge>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2 pl-0 sm:pl-[3.25rem]">
                {can("clients") && (
                  <Button variant="outline" size="sm" asChild>
                    <Link to="/admin/clients">
                      {t("settings.connectPerClient")}
                    </Link>
                  </Button>
                )}
                {can("documentation") && (
                  <Button variant="outline" size="sm" asChild>
                    <Link to="/admin/documentation">
                      {t("settings.openDocs")}
                    </Link>
                  </Button>
                )}
              </div>
            </div>

            <Separator />

            <div className="rounded-xl border border-dashed border-border bg-muted/20 p-4">
              <div className="flex items-start gap-3">
                <Shield className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">
                    {t("settings.futureTitle")}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("settings.futureDesc")}
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </BlurFade>
    </div>
  );
}
