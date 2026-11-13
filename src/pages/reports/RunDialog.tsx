import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { markdownToHtml } from "@shared/reportMarkdown";
import { lines, type Delivered, type Report, type RunFull } from "./types";

/** Shows one run (its text and what each channel answered), or runs a report now and shows the result. */
export function RunDialog({ report, runId, open, onOpenChange, onDone }: { report: Report | null; runId?: string | null; open: boolean; onOpenChange: (v: boolean) => void; onDone?: () => void }) {
  const { t } = useTranslation();
  const [deliver, setDeliver] = useState(false);
  const [emails, setEmails] = useState("");
  const [phones, setPhones] = useState("");
  const [teams, setTeams] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunFull | null>(null);
  const view = useQuery({
    queryKey: ["reports", "run", runId],
    queryFn: () => api.get<RunFull>(`/reports/runs/${runId}`),
    enabled: open && Boolean(runId),
  });
  useEffect(() => {
    if (!open) {
      setResult(null);
      setDeliver(false);
    }
  }, [open]);

  const shown: RunFull | null = runId ? (view.data ?? null) : result;
  const run = async () => {
    if (!report) return;
    setBusy(true);
    try {
      const channels = deliver ? { email: lines(emails), sms: lines(phones), teams } : undefined;
      const r = await api.post<{ run: RunFull; delivered: Delivered | null }>(`/reports/${report.id}/run`, { deliver, ...(channels ? { channels } : {}) });
      setResult({ ...r.run, delivered: r.delivered ?? r.run.delivered });
      if (r.run.status === "ok") toast.success(t("reports.toast.ran"));
      else toast.error(t("reports.toast.failed"));
      onDone?.();
    } catch {
      toast.error(t("reports.toast.runError"));
    } finally {
      setBusy(false);
    }
  };

  const title = report ? (report.key === "portal-usage" ? t("reports.builtin.name") : report.name) : t("reports.runDialog.title");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{shown ? `${t("reports.runDialog.generated")} ${dateTime(shown.startedAt)} · ${t(`reports.trigger.${shown.trigger}`)}` : t("reports.runDialog.channelsHint")}</DialogDescription>
        </DialogHeader>

        {!runId && !result && (
          <div className="space-y-3 rounded-xl border bg-card/60 p-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={deliver} onChange={(e) => setDeliver(e.target.checked)} />
              {t("reports.runDialog.deliver")}
            </label>
            {deliver && (
              <div className="grid gap-3 md:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">{t("reports.schedDialog.emails")}</span>
                  <textarea className="w-full rounded-md border bg-background p-2" rows={2} value={emails} onChange={(e) => setEmails(e.target.value)} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">{t("reports.schedDialog.phones")}</span>
                  <textarea className="w-full rounded-md border bg-background p-2" rows={2} value={phones} onChange={(e) => setPhones(e.target.value)} />
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={teams} onChange={(e) => setTeams(e.target.checked)} />
                  {t("reports.schedDialog.teams")}
                </label>
              </div>
            )}
            <div className="flex justify-end">
              <Button onClick={run} disabled={busy || !report}>
                {busy && <Loader2 className="mr-2 size-4 animate-spin" />} {t("reports.runDialog.run")}
              </Button>
            </div>
          </div>
        )}

        {view.isLoading && runId && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
        {shown && (
          <div className="space-y-4">
            {shown.status === "failed" && (
              <p className="flex items-center gap-2 text-sm text-red-500">
                <XCircle className="size-4" /> {t("reports.runDialog.error")} : {shown.error}
              </p>
            )}
            {shown.body && <div className="reports-md space-y-3 text-sm [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold [&_table]:w-full [&_table]:border-collapse [&_td]:border-b [&_td]:py-1.5 [&_td]:pr-3 [&_th]:border-b [&_th]:py-1.5 [&_th]:pr-3 [&_th]:text-left [&_th]:font-medium [&_ul]:list-disc [&_ul]:pl-5" dangerouslySetInnerHTML={{ __html: markdownToHtml(shown.body) }} />}
            <DeliveredView delivered={shown.delivered} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DeliveredView({ delivered }: { delivered: Delivered | null }) {
  const { t } = useTranslation();
  if (!delivered) return null;
  const rows: { label: string; ok: boolean; error?: string }[] = [
    ...delivered.email.map((e) => ({ label: `${t("reports.runDialog.email")} · ${e.to}`, ok: e.ok, error: e.error })),
    ...delivered.sms.map((s) => ({ label: `${t("reports.runDialog.sms")} · ${s.to}`, ok: s.ok, error: s.error })),
    ...(delivered.teams ? [{ label: t("reports.runDialog.teams"), ok: delivered.teams.ok, error: delivered.teams.error }] : []),
  ];
  return (
    <div className="rounded-xl border bg-card/60 p-3 text-sm">
      <p className="mb-2 font-medium">{t("reports.runDialog.delivered")}</p>
      {rows.length === 0 ? (
        <p className="text-muted-foreground">{t("reports.runDialog.noneSent")}</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li key={r.label} className="flex items-center gap-2">
              {r.ok ? <CheckCircle2 className="size-4 text-emerald-500" /> : <XCircle className="size-4 text-red-500" />}
              <span>{r.label}</span>
              {!r.ok && r.error && <span className="text-xs text-muted-foreground">({r.error})</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
