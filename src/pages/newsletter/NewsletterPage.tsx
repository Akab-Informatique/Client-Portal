import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, Copy, Loader2, MailX, Newspaper, Search, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";

type Contact = { email: string; firstName: string; lastName: string; client: string; contactId: string; unsubscribeUrl: string; subscribed: boolean };
type Issue = { id: string; subject: string; sentAt: string; recipientCount: number; recipientsListed: number; recordedBy: string };
type IssueFull = Issue & { body: string; recipients: string[] };
type Filter = "all" | "subscribed" | "unsubscribed";

/**
 * Infolettre: the clients' contacts (every active contact with an email) and who unsubscribed, and the newsletters
 * that were sent (recorded by the tool that sends them, through the API) to answer a client who asks about one.
 */
export function NewsletterPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"contacts" | "issues">("contacts");
  return (
    <div className="relative">
      <GlassBackdrop />
      <div className="relative space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold">
              <Newspaper className="size-6" /> {t("newsletter.title")}
            </h1>
            <p className="text-sm text-muted-foreground">{t("newsletter.subtitle")}</p>
          </div>
          <div className="flex gap-1 rounded-xl border bg-card/60 p-1">
            {(["contacts", "issues"] as const).map((k) => (
              <button key={k} type="button" onClick={() => setTab(k)} className={cn("rounded-lg px-3 py-1.5 text-sm", tab === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
                {t(`newsletter.tab.${k}`)}
              </button>
            ))}
          </div>
        </header>
        {tab === "contacts" ? <Contacts /> : <Issues />}
      </div>
    </div>
  );
}

function Contacts() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const can = useCan();
  const canManage = can("newsletter.manage");
  const { data = [], isLoading, isError } = useQuery({ queryKey: ["newsletter", "contacts"], queryFn: () => api.get<Contact[]>("/newsletter/contacts") });
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const toggle = useMutation({
    mutationFn: (c: Contact) => api.post("/newsletter/optouts", { email: c.email, unsubscribed: c.subscribed }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["newsletter", "contacts"] }),
    onError: () => toast.error(t("common.error")),
  });
  const subscribed = data.filter((c) => c.subscribed).length;
  const rows = useMemo(() => {
    const w = q.trim().toLowerCase();
    return data.filter((c) => (filter === "all" || (filter === "subscribed") === c.subscribed) && (!w || `${c.firstName} ${c.lastName} ${c.email} ${c.client}`.toLowerCase().includes(w)));
  }, [data, q, filter]);
  const copy = (s: string) => void navigator.clipboard.writeText(s).then(() => toast.success(t("newsletter.copied")));
  if (isError) return <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">{t("newsletter.needsUrl")}</p>;
  return (
    <section className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { k: "subscribed", n: subscribed, f: "subscribed" as Filter },
          { k: "unsubscribed", n: data.length - subscribed, f: "unsubscribed" as Filter },
          { k: "all", n: data.length, f: "all" as Filter },
        ].map((x) => (
          <button key={x.k} type="button" onClick={() => setFilter(x.f)} className={cn("rounded-2xl border bg-card/60 p-4 text-left", filter === x.f && "border-[color:var(--gold)]/60")}>
            <p className="text-3xl font-bold">{x.n}</p>
            <p className="text-xs text-muted-foreground">{t(`newsletter.count.${x.k}`)}</p>
          </button>
        ))}
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("newsletter.search")} className="pl-9" />
      </div>
      <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border">
        {isLoading && (
          <li className="p-4">
            <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
          </li>
        )}
        {!isLoading && rows.length === 0 && <li className="p-6 text-center text-sm text-muted-foreground">{t("newsletter.none")}</li>}
        {rows.map((c) => (
          <li key={c.email} className={cn("flex flex-wrap items-center gap-3 px-3 py-2.5", !c.subscribed && "opacity-60")}>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{`${c.firstName} ${c.lastName}`.trim() || c.email}</p>
              <p className="truncate text-xs text-muted-foreground">
                {c.email} · {c.client}
              </p>
            </div>
            <span className={cn("rounded-full border px-2 py-0.5 text-xs", c.subscribed ? "border-emerald-500/40 text-emerald-300" : "border-red-500/40 text-red-300")}>{t(c.subscribed ? "newsletter.status.on" : "newsletter.status.off")}</span>
            <Button type="button" variant="ghost" size="icon" aria-label={t("newsletter.copyLink")} title={t("newsletter.copyLink")} onClick={() => copy(c.unsubscribeUrl)}>
              <Copy className="size-4" />
            </Button>
            {canManage && (
              <Button type="button" variant="outline" size="sm" disabled={toggle.isPending} onClick={() => toggle.mutate(c)}>
                {c.subscribed ? <MailX className="size-4" /> : <UserCheck className="size-4" />} {t(c.subscribed ? "newsletter.unsubscribe" : "newsletter.resubscribe")}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Issues() {
  const { t } = useTranslation();
  const { data = [], isLoading } = useQuery({ queryKey: ["newsletter", "issues"], queryFn: () => api.get<Issue[]>("/newsletter/issues") });
  const [open, setOpen] = useState<string | null>(null);
  const full = useQuery({ queryKey: ["newsletter", "issue", open], queryFn: () => api.get<IssueFull>(`/newsletter/issues/${open}`), enabled: Boolean(open) });
  return (
    <section className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("newsletter.issuesHelp")}</p>
      <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border">
        {isLoading && (
          <li className="p-4">
            <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
          </li>
        )}
        {!isLoading && data.length === 0 && <li className="p-6 text-center text-sm text-muted-foreground">{t("newsletter.noIssues")}</li>}
        {data.map((i) => (
          <li key={i.id}>
            <button type="button" className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-muted/40" onClick={() => setOpen(open === i.id ? null : i.id)}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{i.subject}</p>
                <p className="text-xs text-muted-foreground">
                  {dateTime(i.sentAt)} · {t("newsletter.recipients", { n: i.recipientCount })} · {i.recordedBy}
                </p>
              </div>
              <ChevronDown className={cn("size-4 transition-transform", open === i.id && "rotate-180")} />
            </button>
            {open === i.id && (
              <div className="space-y-3 border-t bg-card/40 px-3 py-3">
                {full.isLoading || !full.data ? (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                ) : (
                  <>
                    {/* the content is shown as text, never run as HTML */}
                    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-background/60 p-3 text-xs">{full.data.body || t("newsletter.noBody")}</pre>
                    {full.data.recipients.length > 0 && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-muted-foreground">{t("newsletter.sentTo", { n: full.data.recipients.length })}</summary>
                        <p className="mt-2 break-words">{full.data.recipients.join(", ")}</p>
                      </details>
                    )}
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
