import { Link } from "react-router-dom";
import {
  Building2,
  Cable,
  Cloud,
  Database,
  FileText,
  KeyRound,
  Loader2,
  Mail,
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
import { db, dbMode, dbReady, schema } from "@/db";
import type { Company } from "@/lib/types";
import {
  fetchSharePointStatus,
  isCompanySharePointLinked,
} from "@/lib/sharepoint";
import { fetchItGlueStatus } from "@/lib/itglue";
import { fetchSmtpStatus, type SmtpStatusResponse } from "@/lib/smtp";

type ConnState = "unknown" | "ok" | "fail" | "off";

type DbStatusResponse = {
  mode?: string;
  configured?: boolean;
  ok?: boolean;
  host?: string | null;
  database?: string | null;
  error?: string | null;
  hint?: string | null;
};

export function SettingsPage() {
  const { t } = useLocale();
  const { can } = useAuth();
  const [atStatus, setAtStatus] = useState<ConnState>("unknown");
  const [atDetail, setAtDetail] = useState<{
    message?: string;
    contactsAuthOk?: boolean;
    authOk?: boolean;
    configured?: boolean;
    warnings?: string[];
    fix?: string[];
    usernameHint?: string;
    httpStatus?: number;
  } | null>(null);
  const [atChecking, setAtChecking] = useState(false);
  const [spStatus, setSpStatus] = useState<ConnState>("unknown");
  const [igStatus, setIgStatus] = useState<ConnState>("unknown");
  const [smtpStatus, setSmtpStatus] = useState<ConnState>("unknown");
  const [smtpDetail, setSmtpDetail] = useState<SmtpStatusResponse | null>(null);
  const [smtpVerifying, setSmtpVerifying] = useState(false);
  const [smtpVerifyMsg, setSmtpVerifyMsg] = useState<string | null>(null);
  const [dbStatus, setDbStatus] = useState<ConnState>("unknown");
  const [dbDetail, setDbDetail] = useState<DbStatusResponse | null>(null);
  const [linkedClients, setLinkedClients] = useState<number | null>(null);
  const [totalClients, setTotalClients] = useState<number | null>(null);
  const [igLinked, setIgLinked] = useState<number | null>(null);

  const loadAutotaskStatus = async (refresh: boolean) => {
    setAtChecking(true);
    try {
      const url = refresh
        ? "/api/autotask/status?refresh=1"
        : "/api/autotask/status";
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      const d = (await r.json()) as {
        ok?: boolean;
        configured?: boolean;
        authOk?: boolean;
        contactsAuthOk?: boolean;
        message?: string;
        warnings?: string[];
        fix?: string[];
        usernameHint?: string;
        httpStatus?: number;
        error?: string;
      };
      setAtDetail({
        message: d.message || d.error,
        contactsAuthOk: d.contactsAuthOk,
        authOk: d.authOk,
        configured: d.configured,
        warnings: d.warnings,
        fix: d.fix,
        usernameHint: d.usernameHint,
        httpStatus: d.httpStatus,
      });
      if (!d.configured) setAtStatus("off");
      else if (d.ok && d.authOk !== false) setAtStatus("ok");
      else setAtStatus("fail");
    } catch {
      setAtStatus("fail");
      setAtDetail({
        message: "Could not reach /api/autotask/status",
        configured: false,
      });
    } finally {
      setAtChecking(false);
    }
  };

  useEffect(() => {
    void loadAutotaskStatus(false);
    fetchSharePointStatus(false)
      .then((s) => {
        if (!s.configured) setSpStatus("off");
        else setSpStatus(s.ok ? "ok" : "fail");
      })
      .catch(() => setSpStatus("fail"));
    fetchItGlueStatus()
      .then((s) => {
        if (!s.configured) setIgStatus("off");
        else setIgStatus(s.ok ? "ok" : "fail");
      })
      .catch(() => setIgStatus("fail"));
    fetchSmtpStatus(false)
      .then((s) => {
        setSmtpDetail(s);
        if (!s.configured) setSmtpStatus("off");
        else setSmtpStatus(s.ok ? "ok" : "fail");
      })
      .catch(() => setSmtpStatus("fail"));
    fetch("/api/db/status?migrate=1")
      .then((r) => r.json())
      .then((d: DbStatusResponse) => {
        setDbDetail(d);
        if (!d.configured) setDbStatus("off");
        else setDbStatus(d.ok ? "ok" : "fail");
      })
      .catch(() => {
        setDbStatus("fail");
        setDbDetail({
          configured: false,
          ok: false,
          error: "Could not reach /api/db/status",
        });
      });
    let cancelled = false;
    (async () => {
      await dbReady;
      const rows = (await db.select().from(schema.companies)) as Company[];
      if (cancelled) return;
      const clients = rows.filter((c) => c.type === "client");
      setTotalClients(clients.length);
      setLinkedClients(clients.filter(isCompanySharePointLinked).length);
      setIgLinked(
        clients.filter((c) => !!(c.itglue_organization_id || "").trim())
          .length,
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const verifySmtp = async () => {
    setSmtpVerifying(true);
    setSmtpVerifyMsg(null);
    try {
      const s = await fetchSmtpStatus(true);
      setSmtpDetail(s);
      if (!s.configured) {
        setSmtpStatus("off");
        setSmtpVerifyMsg(s.error || t("settings.smtpNotConfigured"));
      } else if (s.ok) {
        setSmtpStatus("ok");
        setSmtpVerifyMsg(t("settings.smtpVerifyOk"));
      } else {
        setSmtpStatus("fail");
        setSmtpVerifyMsg(s.error || t("settings.statusIssue"));
      }
    } catch (e) {
      setSmtpStatus("fail");
      setSmtpVerifyMsg(e instanceof Error ? e.message : t("common.tryAgain"));
    } finally {
      setSmtpVerifying(false);
    }
  };

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
            {can("clients") && (
              <Link
                to="/admin/client-roles"
                className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-primary/5"
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Shield className="size-5" />
                </div>
                <div className="min-w-0">
                  <p className="font-semibold">{t("nav.clientRoles")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("settings.linkClientRoles")}
                  </p>
                  {/* Roles are unique per client company */}
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
            <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <Database className="size-5 text-foreground" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold">{t("settings.dbTitle")}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("settings.dbHint")}
                    </p>
                    <p className="mt-1.5 text-xs font-medium text-foreground/80">
                      {dbStatus === "ok"
                        ? t("settings.dbPostgresLive")
                        : dbStatus === "off"
                          ? t("settings.dbPgliteMode")
                          : dbDetail?.error || t("settings.dbChecking")}
                    </p>
                    {dbDetail?.configured && dbDetail.ok && (
                      <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                        {dbDetail.database || "db"}
                        {dbDetail.host ? ` @ ${dbDetail.host}` : ""}
                        {` · client: ${dbMode}`}
                      </p>
                    )}
                    {dbDetail?.hint && (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {dbDetail.hint}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {statusBadge(
                    dbStatus,
                    t("settings.dbReady"),
                    t("settings.dbLocalOnly"),
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <Cloud className="size-5 text-foreground" />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <p className="font-semibold">Autotask PSA</p>
                    <p className="text-xs text-muted-foreground">
                      {t("settings.autotaskHint")}
                    </p>
                    {atDetail?.message && atStatus !== "unknown" && (
                      <p
                        className={
                          atStatus === "ok" && atDetail.contactsAuthOk !== false
                            ? "text-xs text-muted-foreground"
                            : "text-xs text-destructive"
                        }
                      >
                        {atDetail.message}
                      </p>
                    )}
                    {atStatus === "ok" && atDetail?.contactsAuthOk === false && (
                      <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                        {t("settings.autotaskContactsWarn")}
                      </p>
                    )}
                    {atDetail?.warnings && atDetail.warnings.length > 0 && (
                      <ul className="list-disc space-y-0.5 pl-4 text-xs text-amber-700 dark:text-amber-400">
                        {atDetail.warnings.map((w) => (
                          <li key={w}>{w}</li>
                        ))}
                      </ul>
                    )}
                    {atDetail?.fix && atDetail.fix.length > 0 && atStatus === "fail" && (
                      <ol className="list-decimal space-y-0.5 pl-4 text-xs text-muted-foreground">
                        {atDetail.fix.map((step) => (
                          <li key={step} className="break-all font-mono text-[11px]">
                            {step}
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {statusBadge(
                    atStatus,
                    atDetail?.contactsAuthOk === false
                      ? t("settings.autotaskPartial")
                      : t("settings.statusConnected"),
                    t("settings.statusNotConfigured"),
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={atChecking}
                    onClick={() => void loadAutotaskStatus(true)}
                  >
                    {atChecking ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      t("settings.retest")
                    )}
                  </Button>
                </div>
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

            <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <KeyRound className="size-5 text-foreground" />
                  </div>
                  <div>
                    <p className="font-semibold">IT Glue / MyGlue</p>
                    <p className="text-xs text-muted-foreground">
                      {t("settings.itglueHint")}
                    </p>
                    <p className="mt-1.5 text-xs font-medium text-foreground/80">
                      Each portal user only sees passwords their linked MyGlue
                      user can access.
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {statusBadge(
                    igStatus,
                    t("settings.itglueReady"),
                    t("settings.statusNotConfigured"),
                  )}
                  {igLinked != null && totalClients != null && (
                    <Badge variant="outline" className="tabular-nums">
                      {igLinked}/{totalClients} orgs linked
                    </Badge>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2 pl-0 sm:pl-[3.25rem]">
                {can("passwords") && (
                  <Button variant="outline" size="sm" asChild>
                    <Link to="/admin/passwords">
                      {t("settings.itglueLinkPasswords")}
                    </Link>
                  </Button>
                )}
                {can("clients") && (
                  <Button variant="outline" size="sm" asChild>
                    <Link to="/admin/clients">{t("nav.clients")}</Link>
                  </Button>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <Mail className="size-5 text-foreground" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold">{t("settings.smtpTitle")}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("settings.smtpHint")}
                    </p>
                    <p className="mt-1.5 text-xs font-medium text-foreground/80">
                      {t("settings.smtpPrivacy")}
                    </p>
                    {smtpDetail?.configured && (
                      <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                        {smtpDetail.host}:{smtpDetail.port}
                        {smtpDetail.secure ? " (TLS)" : ""}
                        {smtpDetail.fromEmail
                          ? ` · from ${smtpDetail.fromEmail}`
                          : ""}
                      </p>
                    )}
                    {smtpVerifyMsg && (
                      <p
                        className={`mt-2 text-xs ${
                          smtpStatus === "ok"
                            ? "text-primary"
                            : "text-destructive"
                        }`}
                      >
                        {smtpVerifyMsg}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {statusBadge(
                    smtpStatus,
                    t("settings.smtpReady"),
                    t("settings.statusNotConfigured"),
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2 pl-0 sm:pl-[3.25rem]">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void verifySmtp()}
                  disabled={smtpVerifying || smtpStatus === "off"}
                  className="gap-1.5"
                >
                  {smtpVerifying ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Mail className="size-3.5" />
                  )}
                  {t("settings.smtpTest")}
                </Button>
                {can("messages") && (
                  <Button variant="outline" size="sm" asChild>
                    <Link to="/admin/messages">{t("nav.messages")}</Link>
                  </Button>
                )}
              </div>
              {smtpStatus === "off" && (
                <div className="rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground sm:ml-[3.25rem]">
                  <p className="font-medium text-foreground/80">
                    {t("settings.smtpSecretsTitle")}
                  </p>
                  <ul className="mt-1 list-inside list-disc space-y-0.5 font-mono">
                    <li>SMTP_HOST</li>
                    <li>SMTP_PORT (default 587)</li>
                    <li>SMTP_SECURE (true for 465)</li>
                    <li>SMTP_USER</li>
                    <li>SMTP_PASS</li>
                    <li>SMTP_FROM_EMAIL</li>
                    <li>SMTP_FROM_NAME (optional)</li>
                    <li>SMTP_REPLY_TO (optional)</li>
                  </ul>
                  <p className="mt-1.5">{t("settings.smtpSecretsHint")}</p>
                </div>
              )}
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
