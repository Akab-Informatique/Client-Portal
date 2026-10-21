import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Lightbulb, ListChecks, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";

type Brief = { weekStart: string; bullets: string[]; suggestions: string[]; source: "ai" | "rules"; generatedAt: string };

const KEY = ["meetings", "brief"];

/**
 * The week ahead, at the top of the weekly meeting: what the week will look like in a few bullets and what management
 * could do about it. Written by the AI from this page's data (absences, events, projects, tickets) and each
 * technician's days (My day: what is due and pinned, their Outlook calendar); the portal's own rules when the AI is off.
 */
export function WeekBrief() {
  const { t } = useTranslation();
  const can = useCan();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: KEY, queryFn: () => api.get<Brief>("/meetings/brief"), refetchInterval: 5 * 60_000 });
  const regen = useMutation({
    mutationFn: () => api.post<{ brief: Brief; aiError: string | null }>("/meetings/brief", {}),
    onSuccess: (r) => {
      qc.setQueryData(KEY, r.brief);
      if (r.aiError) toast.message(t("meetings.brief.rulesOnly"), { description: t(`meetings.brief.aiError.${["not_configured", "disabled"].includes(r.aiError) ? r.aiError : "other"}`) });
      else toast.success(t("meetings.brief.done"));
    },
    onError: () => toast.error(t("common.error")),
  });
  const week = data ? new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long" }).format(new Date(`${data.weekStart}T12:00:00`)) : "";
  return (
    <section className="glass relative overflow-hidden rounded-2xl border border-[color:var(--gold)]/25 p-5">
      <div className="pointer-events-none absolute -right-20 -top-24 size-72 rounded-full bg-[color:var(--gold)]/10 blur-3xl" />
      <div className="relative space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Sparkles className="size-5 text-primary" /> {t("meetings.brief.title")}
          </h2>
          {data && <span className="text-sm text-muted-foreground">{t("meetings.brief.weekOf", { date: week })}</span>}
          {data && (
            <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", data.source === "ai" ? "border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 text-primary" : "border-muted-foreground/30 text-muted-foreground")}>
              {data.source === "ai" ? t("meetings.brief.byAi") : t("meetings.brief.byRules")}
            </span>
          )}
          <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
            {data && t("meetings.brief.updated", { when: new Date(data.generatedAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) })}
            {can("meetings.manage") && (
              <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={regen.isPending} onClick={() => regen.mutate()}>
                {regen.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} {t("meetings.brief.regen")}
              </Button>
            )}
          </span>
        </div>
        {isLoading || !data ? (
          <div className="space-y-2">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-4/5" />
          </div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
            <div className="space-y-2">
              <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <ListChecks className="size-3.5" /> {t("meetings.brief.ahead")}
              </h3>
              <ul className="space-y-1.5">
                {data.bullets.map((b, i) => (
                  <li key={i} className="flex gap-2 text-sm leading-relaxed">
                    <span className="mt-2 size-1.5 shrink-0 rounded-full bg-[color:var(--gold)]" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-2 rounded-xl border border-[color:var(--gold)]/20 bg-[color:var(--gold)]/[0.04] p-4">
              <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
                <Lightbulb className="size-3.5" /> {t("meetings.brief.suggestions")}
              </h3>
              <ul className="space-y-1.5">
                {data.suggestions.map((s, i) => (
                  <li key={i} className="flex gap-2 text-sm leading-relaxed">
                    <span className="font-mono text-xs text-primary">{i + 1}.</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
