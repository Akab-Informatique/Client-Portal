import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BarChart3, CalendarClock, CheckCircle2, History, Loader2, Pencil, Play, Plus, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { RunDialog } from "./RunDialog";
import { CustomReportDialog, ScheduleDialog } from "./ReportDialogs";
import { type Report, type ReportsResponse, type RunRow, type Schedule, type ScheduleRow } from "./types";

type Tab = "reports" | "scheduled" | "history";

/**
 * Rapports: the reports (built in or custom), what is scheduled (Québec time, with where it goes) and the history of
 * their runs. A run shows its text as tables; the email, text and Teams copies are recorded with each run.
 */
export function ReportsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("reports");
  const can = useCan();
  const canManage = can("reports.manage");
  return (
    <div className="relative">
      <GlassBackdrop />
      <div className="relative space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold">
              <BarChart3 className="size-6" /> {t("reports.title")}
            </h1>
            <p className="text-sm text-muted-foreground">{t("reports.subtitle")}</p>
          </div>
          <div className="flex gap-1 rounded-xl border bg-card/60 p-1">
            {(["reports", "scheduled", "history"] as const).map((k) => (
              <button key={k} type="button" onClick={() => setTab(k)} className={cn("rounded-lg px-3 py-1.5 text-sm", tab === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
                {t(`reports.tab.${k}`)}
              </button>
            ))}
          </div>
        </header>
        {tab === "reports" && <ReportsTab canManage={canManage} />}
        {tab === "scheduled" && <ScheduledTab canManage={canManage} />}
        {tab === "history" && <HistoryTab />}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: RunRow["status"] | null | undefined }) {
  const { t } = useTranslation();
  if (!status) return <span className="text-muted-foreground">{t("reports.never")}</span>;
  const ok = status === "ok";
  return (
    <span className={cn("inline-flex items-center gap-1 text-sm", ok ? "text-emerald-600" : status === "failed" ? "text-red-500" : "text-muted-foreground")}>
      {ok ? <CheckCircle2 className="size-4" /> : status === "failed" ? <XCircle className="size-4" /> : <Loader2 className="size-4 animate-spin" />}
      {t(`reports.status.${status}`)}
    </span>
  );
}

function ReportsTab({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const list = useQuery({ queryKey: ["reports", "list"], queryFn: () => api.get<ReportsResponse>("/reports") });
  const [runFor, setRunFor] = useState<Report | null>(null);
  const [editing, setEditing] = useState<Report | "new" | null>(null);
  const [scheduling, setScheduling] = useState<Report | null>(null);
  const refresh = () => void list.refetch();
  if (list.isLoading) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  const data = list.data;
  if (!data) return null;
  const name = (r: Report) => (r.kind === "builtin" ? t("reports.builtin.name") : r.name);
  const description = (r: Report) => (r.kind === "builtin" ? t("reports.builtin.description") : r.description);
  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setEditing("new")}>
            <Plus className="mr-2 size-4" /> {t("reports.newReport")}
          </Button>
        </div>
      )}
      {data.reports.length === 0 && <p className="text-sm text-muted-foreground">{t("reports.noReports")}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        {data.reports.map((r) => (
          <div key={r.id} className="glass space-y-3 rounded-2xl border p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">{name(r)}</h2>
                <p className="text-sm text-muted-foreground">{description(r)}</p>
              </div>
              <Badge variant="outline">{t(`reports.kind.${r.kind}`)}</Badge>
            </div>
            <div className="grid gap-1 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{t("reports.lastRun")}</span>
                <span className="flex items-center gap-2">
                  <StatusBadge status={r.lastRun?.status} />
                  {r.lastRun && <span className="text-muted-foreground">{dateTime(r.lastRun.startedAt)}</span>}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{t("reports.schedules.cadence")}</span>
                <span>{r.schedules[0]?.label ?? t("reports.field.none")}</span>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setRunFor(r)}>
                <Play className="mr-2 size-4" /> {t("reports.runNow")}
              </Button>
              {canManage && (
                <Button size="sm" variant="outline" onClick={() => setScheduling(r)}>
                  <CalendarClock className="mr-2 size-4" /> {t("reports.schedule")}
                </Button>
              )}
              {canManage && r.kind === "custom" && (
                <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                  <Pencil className="mr-2 size-4" /> {t("reports.edit")}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
      <RunDialog report={runFor} open={Boolean(runFor)} onOpenChange={(v) => !v && setRunFor(null)} onDone={refresh} />
      <CustomReportDialog
        open={editing !== null}
        onOpenChange={(v) => !v && setEditing(null)}
        report={editing && editing !== "new" ? editing : null}
        sources={data.sources}
        onSaved={refresh}
      />
      <ScheduleDialog open={Boolean(scheduling)} onOpenChange={(v) => !v && setScheduling(null)} report={scheduling} schedule={null} onSaved={refresh} />
    </div>
  );
}

function ScheduledTab({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const schedules = useQuery({ queryKey: ["reports", "schedules"], queryFn: () => api.get<ScheduleRow[]>("/reports/schedules") });
  const reports = useQuery({ queryKey: ["reports", "list"], queryFn: () => api.get<ReportsResponse>("/reports") });
  const [editing, setEditing] = useState<{ report: Report; schedule: Schedule } | null>(null);
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch(`/reports/schedules/${id}`, { enabled }),
    onSuccess: () => {
      toast.success(t("reports.schedules.toggled"));
      void qc.invalidateQueries({ queryKey: ["reports"] });
    },
    onError: () => toast.error(t("reports.toast.runError")),
  });
  if (schedules.isLoading) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  const rows = schedules.data ?? [];
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{t("reports.noSchedules")}</p>;
  return (
    <div className="glass overflow-x-auto rounded-2xl border">
      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="p-3 font-medium">{t("reports.schedules.report")}</th>
            <th className="p-3 font-medium">{t("reports.schedules.cadence")}</th>
            <th className="p-3 font-medium">{t("reports.schedules.next")}</th>
            <th className="p-3 font-medium">{t("reports.schedules.channels")}</th>
            <th className="p-3 font-medium">{t("reports.schedules.enabled")}</th>
            <th className="p-3 font-medium">{t("reports.schedules.last")}</th>
            <th className="p-3" />
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const channels = [s.channels.email.length ? `${t("reports.runDialog.email")} ${s.channels.email.length}` : "", s.channels.sms.length ? `${t("reports.runDialog.sms")} ${s.channels.sms.length}` : "", s.channels.teams ? t("reports.runDialog.teams") : ""].filter(Boolean);
            return (
              <tr key={s.id} className="border-t">
                <td className="p-3 font-medium">{s.reportKind === "builtin" && s.reportKey === "portal-usage" ? t("reports.builtin.name") : s.reportName}</td>
                <td className="p-3">{s.label}</td>
                <td className="p-3">{s.enabled && s.nextRunAt ? dateTime(s.nextRunAt) : "-"}</td>
                <td className="p-3">{channels.length ? channels.join(", ") : t("reports.schedules.none")}</td>
                <td className="p-3">
                  <Switch checked={s.enabled} disabled={!canManage || toggle.isPending} onCheckedChange={(v) => toggle.mutate({ id: s.id, enabled: v })} />
                </td>
                <td className="p-3">
                  {s.lastRunAt ? (
                    <span className="flex items-center gap-2">
                      <StatusBadge status={s.lastStatus} /> <span className="text-muted-foreground">{dateTime(s.lastRunAt)}</span>
                    </span>
                  ) : (
                    t("reports.never")
                  )}
                </td>
                <td className="p-3 text-right">
                  {canManage && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        const report = reports.data?.reports.find((r) => r.id === s.reportId);
                        if (report) setEditing({ report, schedule: s });
                      }}
                    >
                      <Pencil className="size-4" />
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ScheduleDialog
        open={Boolean(editing)}
        onOpenChange={(v) => !v && setEditing(null)}
        report={editing?.report ?? null}
        schedule={editing?.schedule ?? null}
        onSaved={() => void qc.invalidateQueries({ queryKey: ["reports"] })}
      />
    </div>
  );
}

function HistoryTab() {
  const { t } = useTranslation();
  const [reportId, setReportId] = useState("");
  const [more, setMore] = useState<RunRow[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const reports = useQuery({ queryKey: ["reports", "list"], queryFn: () => api.get<ReportsResponse>("/reports") });
  const qs = (before?: string | null) => `/reports/runs?limit=50${reportId ? `&reportId=${reportId}` : ""}${before ? `&before=${encodeURIComponent(before)}` : ""}`;
  const first = useQuery({ queryKey: ["reports", "runs", reportId], queryFn: () => api.get<{ runs: (RunRow & { reportName: string })[]; nextBefore: string | null }>(qs()) });
  const page = first.data;
  const rows = [...(page?.runs ?? []), ...more];
  const next = cursor === undefined ? (page?.nextBefore ?? null) : cursor;
  const loadMore = async () => {
    if (!next) return;
    const r = await api.get<{ runs: (RunRow & { reportName: string })[]; nextBefore: string | null }>(qs(next));
    setMore((m) => [...m, ...r.runs]);
    setCursor(r.nextBefore);
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        <History className="size-4 text-muted-foreground" />
        <span className="text-muted-foreground">{t("reports.filter.report")}</span>
        <select
          className="rounded-md border bg-background px-2 py-1"
          value={reportId}
          onChange={(e) => {
            setReportId(e.target.value);
            setMore([]);
            setCursor(undefined);
          }}
        >
          <option value="">{t("reports.filter.all")}</option>
          {reports.data?.reports.map((r) => (
            <option key={r.id} value={r.id}>
              {r.kind === "builtin" ? t("reports.builtin.name") : r.name}
            </option>
          ))}
        </select>
      </div>
      {first.isLoading && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
      {!first.isLoading && rows.length === 0 && <p className="text-sm text-muted-foreground">{t("reports.noRuns")}</p>}
      {rows.length > 0 && (
        <div className="glass overflow-x-auto rounded-2xl border">
          <table className="w-full text-sm">
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="cursor-pointer border-t first:border-t-0 hover:bg-muted/40" onClick={() => setOpenRun(r.id)}>
                  <td className="p-3 whitespace-nowrap">{dateTime(r.startedAt)}</td>
                  <td className="p-3 font-medium">{r.reportName}</td>
                  <td className="p-3 text-muted-foreground">{t(`reports.trigger.${r.trigger}`)}</td>
                  <td className="p-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="p-3 text-muted-foreground">{r.summary || r.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={loadMore}>
            {t("reports.loadMore")}
          </Button>
        </div>
      )}
      <RunDialog
        report={null}
        runId={openRun}
        open={Boolean(openRun)}
        onOpenChange={(v) => !v && setOpenRun(null)}
      />
    </div>
  );
}
