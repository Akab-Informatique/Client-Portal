import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, Mail, Send, ShieldCheck, TicketCheck, XCircle, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { dateTime, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SectionHeader } from "./sections";

type Workflow = { key: string; template: string; enabled: boolean; enabledAt: string | null; counts: Partial<Record<"sent" | "failed" | "skipped" | "pending", number>> };
type Run = { id: string; ticketId: number; ticketNumber: string; ticketTitle: string; toEmail: string | null; status: "pending" | "sent" | "failed" | "skipped"; reason: string | null; createdAt: string };
const KEY = ["admin", "workflows"];

/** What each workflow is called here: its icon (the texts are under `workflows.<key>`). */
const ICONS: Record<string, LucideIcon> = { "new-ticket-reply": TicketCheck };

/**
 * Admin › Flux de travail: the automatic workflows, each switched on or off
 * here. They all start off; a workflow only acts on what happens after it is
 * switched on.
 */
export function WorkflowsSection() {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({ queryKey: KEY, queryFn: () => api.get<{ mailReady: boolean; workflows: Workflow[] }>("/admin/workflows") });
  return (
    <div>
      <SectionHeader title={t("workflows.title")} subtitle={t("workflows.subtitle")} />
      {isLoading && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
      {data && !data.mailReady && (
        <p className="mb-4 flex items-start gap-2 rounded-xl border border-orange-500/40 bg-orange-500/10 p-3 text-sm text-orange-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {t("workflows.noMail")}
        </p>
      )}
      <div className="space-y-4">
        {data?.workflows.map((w) => (
          <WorkflowCard key={w.key} w={w} mailReady={data.mailReady} />
        ))}
      </div>
      <p className="mt-6 text-xs text-muted-foreground">{t("workflows.more")}</p>
    </div>
  );
}

function WorkflowCard({ w, mailReady }: { w: Workflow; mailReady: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [, setParams] = useSearchParams();
  const [runsOpen, setRunsOpen] = useState(false);
  const Icon = ICONS[w.key] ?? Mail;
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.put(`/admin/workflows/${w.key}`, { enabled }),
    onSuccess: (_r, enabled) => {
      void qc.invalidateQueries({ queryKey: KEY });
      toast.success(t(enabled ? "workflows.turnedOn" : "workflows.turnedOff"));
    },
    onError: (e) => toast.error(e instanceof ApiError && e.code === "mail_not_configured" ? t("workflows.noMail") : t("common.error")),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ to: string }>(`/admin/workflows/${w.key}/test`),
    onSuccess: (r) => toast.success(t("workflows.testSent", { to: r.to })),
    onError: () => toast.error(t("workflows.testFailed")),
  });
  // switching on talks to clients: asked first
  const change = (on: boolean) => {
    if (!on) return toggle.mutate(false);
    void confirm({ title: t(`workflows.${w.key}.confirmTitle`), description: t(`workflows.${w.key}.confirmText`) }).then((ok) => ok && toggle.mutate(true));
  };
  const total = (w.counts.sent ?? 0) + (w.counts.failed ?? 0) + (w.counts.skipped ?? 0);

  return (
    <section className={cn("rounded-2xl border bg-card/80 p-5 transition-colors", w.enabled && "border-emerald-500/30")}>
      <div className="flex items-start gap-4">
        <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl", w.enabled ? "bg-emerald-500/15 text-emerald-300" : "bg-muted text-muted-foreground")}>
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-lg font-semibold">{t(`workflows.${w.key}.name`)}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t(`workflows.${w.key}.description`)}</p>
          <p className={cn("mt-2 flex items-center gap-1.5 text-xs font-medium", w.enabled ? "text-emerald-400" : "text-muted-foreground")}>
            <span className={cn("size-1.5 rounded-full", w.enabled ? "bg-emerald-400" : "bg-muted-foreground/60")} />
            {w.enabled && w.enabledAt ? t("workflows.activeSince", { date: dateTime(w.enabledAt) }) : t("workflows.inactive")}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Switch checked={w.enabled} disabled={toggle.isPending || (!w.enabled && !mailReady)} onCheckedChange={change} aria-label={t(`workflows.${w.key}.name`)} />
          <span className="text-[11px] text-muted-foreground">{w.enabled ? t("workflows.on") : t("workflows.off")}</span>
        </div>
      </div>

      <ul className="mt-4 space-y-1.5 rounded-xl border bg-background/40 p-3 text-xs text-muted-foreground">
        {(t(`workflows.${w.key}.rules`, { returnObjects: true }) as string[]).map((rule) => (
          <li key={rule} className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-primary" /> {rule}
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            setParams((p) => {
              p.set("admin", "email");
              p.set("template", w.template);
              p.delete("integration");
              return p;
            })
          }
        >
          <Mail className="size-4" /> {t("workflows.editEmail")}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={test.isPending} onClick={() => test.mutate()}>
          {test.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} {t("workflows.sendTest")}
        </Button>
        <button type="button" onClick={() => setRunsOpen((v) => !v)} aria-expanded={runsOpen} className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          {t("workflows.runs", { count: total })}
          <ChevronDown className={cn("size-4 transition-transform", runsOpen && "rotate-180")} />
        </button>
      </div>
      {runsOpen && <Runs wkey={w.key} counts={w.counts} />}
    </section>
  );
}

function Runs({ wkey, counts }: { wkey: string; counts: Workflow["counts"] }) {
  const { t } = useTranslation();
  const { data = [], isLoading } = useQuery({ queryKey: [...KEY, wkey, "runs"], queryFn: () => api.get<Run[]>(`/admin/workflows/${wkey}/runs`) });
  const STATUS: Record<Run["status"], { icon: LucideIcon; className: string }> = {
    sent: { icon: CheckCircle2, className: "text-emerald-400" },
    failed: { icon: XCircle, className: "text-destructive" },
    skipped: { icon: AlertTriangle, className: "text-amber-400" },
    pending: { icon: Loader2, className: "text-muted-foreground" },
  };
  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs text-muted-foreground">
        {t("workflows.counts", { sent: counts.sent ?? 0, skipped: counts.skipped ?? 0, failed: counts.failed ?? 0 })}
      </p>
      {isLoading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      {!isLoading && data.length === 0 && <p className="rounded-xl border border-dashed p-4 text-center text-xs text-muted-foreground">{t("workflows.noRuns")}</p>}
      {data.length > 0 && (
        <ul className="divide-y overflow-hidden rounded-xl border text-sm">
          {data.map((r) => {
            const s = STATUS[r.status];
            return (
              <li key={r.id} className="flex items-center gap-3 px-3 py-2">
                <s.icon className={cn("size-4 shrink-0", s.className, r.status === "pending" && "animate-spin")} aria-label={t(`workflows.status.${r.status}`)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    <span className="font-mono text-xs text-muted-foreground">{r.ticketNumber}</span> {r.ticketTitle}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {r.toEmail ?? "—"}
                    {r.reason && ` · ${t(`workflows.reason.${r.reason}`, { defaultValue: r.reason })}`}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground" title={dateTime(r.createdAt)}>
                  {relativeTime(r.createdAt)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
