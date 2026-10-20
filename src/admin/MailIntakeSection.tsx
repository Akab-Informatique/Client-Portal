import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CircleAlert, CircleCheck, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api, ApiError } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SectionHeader } from "./sections";

type Intake = {
  enabled: boolean;
  mailbox: string;
  enabledAt: string | null;
  markRead: boolean;
  replies: boolean;
  o365Ready: boolean;
  lastRun: { at: string; ok: boolean; tickets: number; replies: number; pending: number; error?: string } | null;
  counts: Record<string, number>;
  recent: { id: string; from: string | null; subject: string | null; status: string; ticketId: number | null; ticketNumber: string | null; note: string | null; at: string }[];
};
const KEY = ["admin", "mail-intake"];
const STATUS_STYLE: Record<string, string> = {
  ticket: "border-emerald-400/40 bg-emerald-500/10 text-emerald-300",
  reply: "border-sky-400/40 bg-sky-500/10 text-sky-300",
  pending: "border-amber-400/40 bg-amber-500/10 text-amber-300",
  error: "border-red-400/40 bg-red-500/10 text-red-300",
};

/** Admin › Courriel entrant: tickets from the support mailbox. Starts OFF. */
export function MailIntakeSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: KEY, queryFn: () => api.get<Intake>("/admin/mail-intake"), refetchInterval: 30_000 });
  const [mailbox, setMailbox] = useState("");
  useEffect(() => data && setMailbox(data.mailbox), [data?.mailbox]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: KEY });
    void qc.invalidateQueries({ queryKey: ["tickets"] });
    void qc.invalidateQueries({ queryKey: ["mail-intake"] });
  };
  const fail = (e: unknown) => {
    const detail = e instanceof ApiError ? (e.fields?.[0]?.message ?? "") : "";
    toast.error(e instanceof ApiError ? `${t(`mailIntake.errors.${e.code}`, { defaultValue: t("common.error") })}${detail ? ` (${detail})` : ""}` : t("common.error"));
  };
  const save = useMutation({
    mutationFn: (p: { enabled?: boolean; mailbox?: string; markRead?: boolean; replies?: boolean }) => api.put("/admin/mail-intake", p),
    onSuccess: () => {
      refresh();
      toast.success(t("common.saved"));
    },
    onError: fail,
  });
  const run = useMutation({
    mutationFn: () => api.post<{ ok: boolean; tickets?: number; replies?: number; pending?: number }>("/admin/mail-intake/run", {}),
    onSuccess: (r) => {
      refresh();
      if (r.ok) toast.success(t("mailIntake.runDone", { tickets: r.tickets ?? 0, replies: r.replies ?? 0, pending: r.pending ?? 0 }));
      else toast.error(t("mailIntake.runFailed"));
    },
    onError: fail,
  });
  if (isLoading || !data) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  const mailboxChanged = mailbox.trim().toLowerCase() !== data.mailbox.toLowerCase();
  return (
    <div>
      <SectionHeader title={t("mailIntake.title")} subtitle={t("mailIntake.subtitle")} />
      <p className="mb-5 flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {t("mailIntake.warning")}
      </p>
      {!data.o365Ready && <p className="mb-5 rounded-xl border bg-card/60 p-3 text-xs text-muted-foreground">{t("mailIntake.needO365")}</p>}

      <section className="mb-6 rounded-2xl border bg-card/80 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block flex-1 space-y-1 text-xs text-muted-foreground sm:max-w-sm">
            {t("mailIntake.mailbox")}
            <Input type="email" value={mailbox} placeholder="support@akab.ca" onChange={(e) => setMailbox(e.target.value)} className="text-foreground" />
          </label>
          <Button type="button" variant="outline" disabled={!mailbox.trim() || !mailboxChanged || save.isPending} onClick={() => save.mutate({ mailbox: mailbox.trim() })}>
            {save.isPending ? <Loader2 className="size-4 animate-spin" /> : null} {t("mailIntake.saveMailbox")}
          </Button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Switch checked={data.enabled} disabled={save.isPending || (!data.enabled && !mailbox.trim())} onCheckedChange={(enabled) => save.mutate({ enabled, mailbox: mailbox.trim() || undefined })} />
            {t("mailIntake.enabled")}
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={data.replies} disabled={save.isPending} onCheckedChange={(replies) => save.mutate({ replies })} /> {t("mailIntake.replies")}
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={data.markRead} disabled={save.isPending} onCheckedChange={(markRead) => save.mutate({ markRead })} /> {t("mailIntake.markRead")}
          </label>
          <Button type="button" onClick={() => run.mutate()} disabled={!data.enabled || run.isPending}>
            {run.isPending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} {t("mailIntake.runNow")}
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{data.enabled ? t("mailIntake.onNote", { since: data.enabledAt ? dateTime(data.enabledAt) : "—" }) : t("mailIntake.offNote")}</p>
        {data.lastRun && (
          <p className={cn("mt-2 flex items-start gap-2 text-xs", data.lastRun.ok ? "text-emerald-300" : "text-destructive")}>
            {data.lastRun.ok ? <CircleCheck className="mt-0.5 size-3.5 shrink-0" /> : <CircleAlert className="mt-0.5 size-3.5 shrink-0" />}
            {data.lastRun.ok
              ? t("mailIntake.lastOk", { at: dateTime(data.lastRun.at), tickets: data.lastRun.tickets, replies: data.lastRun.replies, pending: data.lastRun.pending })
              : t("mailIntake.lastFailed", { at: dateTime(data.lastRun.at), error: data.lastRun.error ?? "" })}
          </p>
        )}
      </section>

      <section className="rounded-2xl border bg-card/80 p-4">
        <h3 className="font-display text-base font-semibold">{t("mailIntake.recent")}</h3>
        <p className="mb-3 mt-1 text-xs text-muted-foreground">
          {t("mailIntake.counts", { tickets: data.counts.ticket ?? 0, replies: data.counts.reply ?? 0, pending: data.counts.pending ?? 0 })}
        </p>
        {data.recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("mailIntake.none")}</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {data.recent.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <span className={cn("rounded-full border px-2 py-px text-[10px] font-medium", STATUS_STYLE[r.status] ?? "border-border text-muted-foreground")}>{t(`mailIntake.status.${r.status}`, { defaultValue: r.status })}</span>
                <span className="min-w-0 flex-1 truncate">{r.subject || "—"}</span>
                <span className="truncate text-xs text-muted-foreground">{r.from}</span>
                {r.ticketNumber && <span className="font-mono text-[11px] text-primary">{r.ticketNumber}</span>}
                <span className="text-[11px] text-muted-foreground">{dateTime(r.at)}</span>
                {r.note && <span className="w-full text-[11px] text-destructive">{r.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
