import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Loader2, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { lines, type Channels, type Report, type Schedule, type Source } from "./types";

const field = "w-full rounded-md border bg-background px-2 py-1.5 text-sm";

/** A custom report: its name, the sources it takes, the period, and the AI reading switch. */
export function CustomReportDialog({ open, onOpenChange, report, sources, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; report: Report | null; sources: Source[]; onSaved: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(report?.name ?? "");
  const [description, setDescription] = useState(report?.description ?? "");
  const [picked, setPicked] = useState<string[]>(report?.config.sources ?? []);
  const [period, setPeriod] = useState<7 | 30 | 90>(report?.config.period ?? 30);
  const [aiSummary, setAiSummary] = useState(report?.config.aiSummary ?? false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!picked.length) {
      toast.error(t("reports.customDialog.needSource"));
      return;
    }
    setBusy(true);
    try {
      const payload = { name, description, sources: picked, period, aiSummary };
      if (report) await api.patch(`/reports/${report.id}`, payload);
      else await api.post("/reports", payload);
      toast.success(t("reports.toast.saved"));
      onSaved();
      onOpenChange(false);
    } catch {
      toast.error(t("reports.toast.runError"));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!report || !window.confirm(t("reports.customDialog.deleteConfirm"))) return;
    try {
      await api.del(`/reports/${report.id}`);
      toast.success(t("reports.toast.deleted"));
      onSaved();
      onOpenChange(false);
    } catch {
      toast.error(t("reports.toast.runError"));
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{report ? t("reports.customDialog.titleEdit") : t("reports.customDialog.titleNew")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">{t("reports.customDialog.name")}</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">{t("reports.customDialog.description")}</span>
            <textarea className={field} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          </label>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">{t("reports.customDialog.sources")}</span>
            <div className="grid gap-1.5 md:grid-cols-2">
              {sources.map((s) => (
                <label key={s.key} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
                  <input
                    type="checkbox"
                    checked={picked.includes(s.key)}
                    onChange={(e) => setPicked((p) => (e.target.checked ? [...p, s.key] : p.filter((k) => k !== s.key)))}
                  />
                  {s.title}
                </label>
              ))}
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t("reports.customDialog.period")}</span>
              <select className={field} value={period} onChange={(e) => setPeriod(Number(e.target.value) as 7 | 30 | 90)}>
                <option value={7}>7</option>
                <option value={30}>30</option>
                <option value={90}>90</option>
              </select>
            </label>
            <label className="flex items-end gap-2 pb-1.5">
              <input type="checkbox" checked={aiSummary} onChange={(e) => setAiSummary(e.target.checked)} />
              {t("reports.customDialog.aiSummary")}
            </label>
          </div>
          <div className="flex items-center justify-between pt-2">
            {report ? (
              <Button variant="ghost" className="text-red-500" onClick={remove}>
                <Trash2 className="mr-2 size-4" /> {t("reports.remove")}
              </Button>
            ) : (
              <span />
            )}
            <Button onClick={save} disabled={busy || !name.trim()}>
              {busy && <Loader2 className="mr-2 size-4 animate-spin" />} {t("reports.customDialog.save")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A schedule of a report: how often, when (Québec time), and where the result goes. */
export function ScheduleDialog({ open, onOpenChange, report, schedule, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; report: Report | null; schedule: Schedule | null; onSaved: () => void }) {
  const { t } = useTranslation();
  const [frequency, setFrequency] = useState<Schedule["frequency"]>(schedule?.frequency ?? "monthly");
  const [time, setTime] = useState(schedule?.time ?? "06:00");
  const [weekday, setWeekday] = useState(schedule?.weekday ?? 1);
  const [dayOfMonth, setDayOfMonth] = useState(schedule?.dayOfMonth ?? 1);
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [emails, setEmails] = useState((schedule?.channels.email ?? []).join("\n"));
  const [phones, setPhones] = useState((schedule?.channels.sms ?? []).join("\n"));
  const [teams, setTeams] = useState(schedule?.channels.teams ?? false);
  const [busy, setBusy] = useState(false);
  const days = [0, 1, 2, 3, 4, 5, 6];
  const save = async () => {
    if (!report) return;
    const channels: Channels = { email: lines(emails), sms: lines(phones), teams };
    const payload = { frequency, time, weekday: frequency === "weekly" ? weekday : null, dayOfMonth: frequency === "monthly" ? dayOfMonth : null, enabled, channels };
    setBusy(true);
    try {
      if (schedule) await api.patch(`/reports/schedules/${schedule.id}`, payload);
      else await api.post(`/reports/${report.id}/schedules`, payload);
      toast.success(t("reports.schedules.toggled"));
      onSaved();
      onOpenChange(false);
    } catch {
      toast.error(t("reports.toast.runError"));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!schedule || !window.confirm(t("reports.schedDialog.deleteConfirm"))) return;
    try {
      await api.del(`/reports/schedules/${schedule.id}`);
      onSaved();
      onOpenChange(false);
    } catch {
      toast.error(t("reports.toast.runError"));
    }
  };
  const noChannels = !emails.trim() && !phones.trim() && !teams;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t("reports.schedDialog.title")} {report ? `· ${report.key === "portal-usage" ? t("reports.builtin.name") : report.name}` : ""}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="grid gap-3 md:grid-cols-3">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t("reports.schedDialog.frequency")}</span>
              <select className={field} value={frequency} onChange={(e) => setFrequency(e.target.value as Schedule["frequency"])}>
                <option value="daily">{t("reports.schedDialog.daily")}</option>
                <option value="weekly">{t("reports.schedDialog.weekly")}</option>
                <option value="monthly">{t("reports.schedDialog.monthly")}</option>
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t("reports.schedDialog.time")}</span>
              <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </label>
            {frequency === "weekly" && (
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">{t("reports.schedDialog.weekday")}</span>
                <select className={field} value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                  {days.map((d) => (
                    <option key={d} value={d}>
                      {new Intl.DateTimeFormat(undefined, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 7 + d)))}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {frequency === "monthly" && (
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">{t("reports.schedDialog.dayOfMonth")}</span>
                <Input type="number" min={1} max={28} value={dayOfMonth} onChange={(e) => setDayOfMonth(Math.min(28, Math.max(1, Number(e.target.value) || 1)))} />
              </label>
            )}
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {t("reports.schedDialog.enabled")}
          </label>
          <div className="space-y-3 rounded-xl border p-3">
            <p className="font-medium">{t("reports.schedDialog.channels")}</p>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t("reports.schedDialog.emails")}</span>
              <textarea className={field} rows={2} value={emails} onChange={(e) => setEmails(e.target.value)} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t("reports.schedDialog.phones")}</span>
              <textarea className={field} rows={2} value={phones} onChange={(e) => setPhones(e.target.value)} />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={teams} onChange={(e) => setTeams(e.target.checked)} />
              {t("reports.schedDialog.teams")}
            </label>
            {noChannels && <p className="text-xs text-muted-foreground">{t("reports.schedDialog.noChannels")}</p>}
          </div>
          <div className="flex items-center justify-between pt-2">
            {schedule ? (
              <Button variant="ghost" className="text-red-500" onClick={remove}>
                <Trash2 className="mr-2 size-4" /> {t("reports.schedDialog.delete")}
              </Button>
            ) : (
              <span />
            )}
            <Button onClick={save} disabled={busy || !report}>
              {busy && <Loader2 className="mr-2 size-4 animate-spin" />} {t("reports.schedDialog.save")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
