import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ClipboardList, FileSignature, FolderKanban, Loader2, Plus, Search, ThumbsDown } from "lucide-react";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ConfirmDialog";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { money } from "@/pages/crm/shared";
import { shortDate } from "@/pages/tickets/shared";
import { QUOTE_STATUSES } from "@shared/quotes";
import { STATUS_STYLE, type QuoteListItem } from "./shared";
import { useToProject } from "./useToProject";

/** Accounting › Soumissions: every quote, newest first. */
export function QuotesPage() {
  const { t, i18n } = useTranslation();
  const nav = useNavigate();
  const can = useCan();
  const project = useToProject();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const decline = useMutation({
    mutationFn: (id: string) => api.post(`/quotes/${id}/status`, { status: "declined" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["quotes"] });
      toast.success(t("quotes.decline.done"));
    },
    onError: () => toast.error(t("common.error")),
  });
  const [status, setStatus] = useState<string>("all");
  const [q, setQ] = useState("");
  const { data, isLoading } = useQuery({ queryKey: ["quotes", "list"], queryFn: () => api.get<QuoteListItem[]>("/quotes"), refetchInterval: 30_000 });
  const all = data ?? [];
  const words = q.trim().toLowerCase();
  const list = all
    // "Actives" leaves out what the client did not keep: those are under their own filter
    .filter((x) => (status === "all" ? x.status !== "declined" : x.status === status))
    .filter((x) => !words || `${x.number} ${x.title} ${x.clientName ?? ""} ${x.prospectName ?? ""} ${x.contactName ?? ""}`.toLowerCase().includes(words));
  const count = (s: string) => all.filter((x) => x.status === s).length;
  const open = all.filter((x) => x.status === "sent" && !x.expired).reduce((n, x) => n + x.totals.totalCents, 0);
  const won = all.filter((x) => x.status === "accepted").reduce((n, x) => n + x.totals.totalCents, 0);

  return (
    <div className="relative isolate space-y-6">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <FileSignature className="size-6 text-primary" /> {t("quotes.title")}
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t("quotes.subtitle")}</p>
        </div>
        {can("quotes.manage") && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => nav("/accounting/quotes/new?type=site_visit")}>
              <ClipboardList className="size-4" /> {t("quotes.newSiteVisit")}
            </Button>
            <Button onClick={() => nav("/accounting/quotes/new")}>
              <Plus className="size-4" /> {t("quotes.new")}
            </Button>
          </div>
        )}
      </div>

      {all.length > 0 && (
        <dl className="grid gap-3 sm:grid-cols-3">
          <Stat label={t("quotes.summary.open")} value={money(open, i18n.language)} hint={String(count("sent"))} />
          <Stat label={t("quotes.summary.accepted")} value={money(won, i18n.language)} hint={String(count("accepted"))} />
          <Stat label={t("quotes.summary.draft")} value={String(count("draft"))} />
        </dl>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="h-9 bg-background/40 pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("quotes.search")} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {["all", ...QUOTE_STATUSES].map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={status === s}
              onClick={() => setStatus(s)}
              className={cn("rounded-full border px-3 py-1 text-sm transition-colors", status === s ? "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10" : "border-transparent text-muted-foreground hover:bg-accent")}
            >
              {s === "all" ? t("quotes.all") : t(`quotes.status.${s}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="glass overflow-hidden rounded-2xl border">
        {isLoading ? (
          <div className="space-y-2 p-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : all.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <p className="font-semibold">{t("quotes.none")}</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{t("quotes.noneText")}</p>
          </div>
        ) : list.length === 0 ? (
          <p className="p-10 text-center text-sm text-muted-foreground">{t("quotes.noMatch")}</p>
        ) : (
          <ul className="divide-y">
            {list.map((x) => {
              const shown = x.expired ? "expired" : x.status;
              return (
                <li key={x.id} className="flex flex-wrap items-center transition-colors hover:bg-accent/50 sm:flex-nowrap">
                  <Link to={`/accounting/quotes/${x.id}`} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                    <span className="flex w-20 shrink-0 items-center gap-1.5 font-mono text-sm">
                      {x.kind === "site_visit" && <ClipboardList className="size-3.5 text-primary" aria-label={t("quotes.siteVisit")} />}
                      {x.number}
                    </span>
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="truncate font-medium">{x.clientName ?? x.prospectName ?? t("quotes.prospect")}</p>
                      <p className="truncate text-sm text-muted-foreground">
                        {x.title || t("quotes.untitled")}
                        {x.preparedBy ? `  ·  ${x.preparedBy}` : ""}
                      </p>
                    </div>
                    <div className="hidden text-right text-xs text-muted-foreground sm:block">
                      <p>{t("quotes.lines", { count: x.lineCount })}</p>
                      {x.validUntil && <p>{t("quotes.validUntil", { date: shortDate(x.validUntil) })}</p>}
                    </div>
                    <span className={cn("rounded-full border px-2.5 py-0.5 text-xs", STATUS_STYLE[shown])}>{t(`quotes.status.${shown}`)}</span>
                    <span className="w-28 text-right font-semibold tabular-nums">{money(x.totals.totalCents, i18n.language)}</span>
                  </Link>
                  {x.status !== "declined" && can("quotes.manage") && (
                    <div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-2 px-4 pb-3 sm:w-auto sm:flex-nowrap sm:px-3 sm:pb-0">
                      {x.projectTicketNumber ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-300" title={t("quotes.project.doneTitle")}>
                          <FolderKanban className="size-3.5" /> {t("quotes.project.badge", { number: x.projectTicketNumber })}
                        </span>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={project.pending || !project.allowed(x)}
                          title={!x.clientId ? t("quotes.errors.project_needs_client") : x.lineCount === 0 ? t("quotes.errors.quote_empty") : undefined}
                          onClick={() => void project.start(x)}
                        >
                          {project.pending ? <Loader2 className="size-4 animate-spin" /> : <FolderKanban className="size-4" />} {t("quotes.project.action")}
                        </Button>
                      )}
                      {(x.status === "draft" || x.status === "sent") && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground hover:text-red-400"
                          disabled={decline.isPending}
                          onClick={() => void confirm({ title: t("quotes.decline.title", { number: x.number }), description: t("quotes.decline.text"), confirmLabel: t("quotes.decline.confirm"), destructive: true }).then((ok) => ok && decline.mutate(x.id))}
                        >
                          <ThumbsDown className="size-4" /> {t("quotes.decline.action")}
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="glass rounded-2xl border px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex items-baseline gap-2">
        <span className="text-xl font-bold tabular-nums">{value}</span>
        {hint && <span className="text-xs text-muted-foreground tabular-nums">({hint})</span>}
      </dd>
    </div>
  );
}
