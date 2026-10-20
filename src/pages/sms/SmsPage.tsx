import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { CompanyPicker, ContactPicker, useCompanies, useContacts, type Company } from "@/pages/tickets/pickers";
import { smsPartCount } from "@shared/sms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Archive, Bot, Building2, Clock3, Loader2, MessageSquareText, Plus, Search, Send, Ticket, Timer, Trash2, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AiTextarea } from "@/components/AiPolish";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConfirm } from "@/components/ConfirmDialog";
import { api, ApiError } from "@/lib/api";
import { currentLocale } from "@/i18n";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { useTicketWorkspace } from "@/pages/tickets/workspace";

/**
 * Text conversations with clients (the VoIP.ms number). Every technician
 * sees them and answers; a conversation becomes a ticket on request ("1"),
 * from here, or by itself when nobody answers in time.
 */
export type Conversation = {
  id: string;
  phone: string;
  contactName: string | null;
  contactId: string | null;
  companyId: number | null;
  companyName: string | null;
  status: "waiting" | "details" | "open" | "ticket" | "closed";
  ticketId: number | null;
  ticketNumber: string | null;
  autoTicketAt: string | null;
  unread: number;
  lastMessageAt: string;
  lastPreview: string;
};
type Message = {
  id: string;
  direction: "in" | "out";
  body: string;
  auto: boolean;
  status: "received" | "sent" | "failed";
  error?: string | null;
  createdAt: string;
  author: string | null;
  /** In a ticket: whose conversation it is, and the group it was sent to (if any) */
  conversationId?: string;
  groupKey?: string | null;
};
type Thread = Conversation & { messages: Message[]; max: number };
type Summary = { waiting: number; unread: number; open: number; next: string | null; ready: boolean; longAsMms?: boolean };

const loc = () => (currentLocale() === "en" ? "en-CA" : "fr-CA");
export const fmtPhone = (p: string) => (p.length === 10 ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : p);
const time = (iso: string) => {
  const d = new Date(iso);
  const today = d.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(loc(), today ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
};
/** Minutes left before the automatic ticket. */
const minutesLeft = (iso: string | null) => (iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 60_000)) : null);

const STATUS_STYLE: Record<Conversation["status"], string> = {
  waiting: "border-orange-500/50 bg-orange-500/15 text-orange-300",
  details: "border-violet-500/50 bg-violet-500/15 text-violet-300",
  open: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  ticket: "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 text-primary",
  closed: "border-border text-muted-foreground",
};

export function useSmsSummary() {
  const can = useCan();
  return useQuery({ queryKey: ["sms", "summary"], queryFn: () => api.get<Summary>("/sms/summary"), enabled: can("sms.view"), refetchInterval: 30_000 });
}

/** Tile on the ticket page: texts waiting for a technician. */
export function SmsTile({ onOpen, compact }: { onOpen: () => void; compact?: boolean }) {
  const { t } = useTranslation();
  const { data } = useSmsSummary();
  if (!data) return null;
  const left = minutesLeft(data.next);
  if (compact) {
    return (
      <button
        type="button"
        onClick={onOpen}
        title={data.waiting ? t("sms.tileWaiting", { count: data.waiting, delay: delayText(left ?? 0) }) : !data.ready && !data.open ? t("sms.tileOff") : t("sms.tileUnread", { count: data.unread })}
        className={cn("glass flex h-10 shrink-0 items-center gap-1.5 rounded-xl border px-2.5 text-left transition-colors hover:border-[color:var(--gold)]/40", data.waiting > 0 && "border-orange-500/50")}
      >
        <span className="relative">
          <MessageSquareText className={cn("size-4", data.waiting ? "text-orange-300" : "text-sky-300")} />
          {data.unread > 0 && <span className="absolute -right-1 -top-1 size-2 animate-ping rounded-full bg-orange-400" />}
        </span>
        <span className="text-xs font-medium">{t("sms.tile")}</span>
        <span className={cn("font-mono text-base font-semibold tabular-nums", data.waiting || data.unread ? "text-foreground" : "text-muted-foreground/50")}>{data.waiting || data.unread}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "glass group relative flex items-center gap-3.5 overflow-hidden rounded-2xl border px-4 py-3.5 text-left transition-all hover:border-[color:var(--gold)]/40",
        data.waiting > 0 && "border-orange-500/50 shadow-[0_0_28px_-12px_rgba(249,115,22,0.7)]",
      )}
    >
      <span className={cn("relative flex size-10 shrink-0 items-center justify-center rounded-xl border bg-background/60", data.waiting ? "text-orange-300" : "text-sky-300")}>
        <MessageSquareText className="size-5" />
        {data.unread > 0 && <span className="absolute -right-1 -top-1 size-2.5 animate-ping rounded-full bg-orange-400" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{t("sms.tile")}</span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
          {data.waiting
            ? t("sms.tileWaiting", { count: data.waiting, delay: delayText(left ?? 0) })
            : !data.ready && !data.open
              ? t("sms.tileOff")
              : t("sms.tileUnread", { count: data.unread })}
        </span>
      </span>
      <span className={cn("font-mono text-3xl font-semibold tabular-nums", data.waiting || data.unread ? "text-foreground" : "text-muted-foreground/50")}>{data.waiting || data.unread}</span>
    </button>
  );
}

/**
 * The texts in a pop-up on the ticket page: by default those not in a ticket
 * yet (to answer, continue, or turn into a ticket); all of them on demand.
 */
export function SmsInboxDialog({ initialId, onClose }: { initialId: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(initialId);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"pending" | "all" | "closed">("pending");
  const inboxQc = useQueryClient();
  const inboxConfirm = useConfirm();
  const deleteClosed = useMutation({
    mutationFn: () => api.del<{ deleted: number }>("/sms/conversations?closed=1"),
    onSuccess: (r) => {
      void inboxQc.invalidateQueries({ queryKey: ["sms"] });
      setSelected(null);
      toast.success(t("sms.deletedMany", { count: r.deleted }));
    },
    onError: () => toast.error(t("common.error")),
  });
  const { data: list, isLoading } = useQuery({
    queryKey: ["sms", "conversations", scope === "closed"],
    queryFn: () => api.get<Conversation[]>(`/sms/conversations${scope === "closed" ? "?all=1" : ""}`),
    refetchInterval: 15_000,
  });
  const { data: summary } = useSmsSummary();
  const shown = useMemo(() => {
    const w = q.toLowerCase().replace(/[^\w\s]/g, "");
    return (list ?? [])
      .filter((c) => (scope === "pending" ? c.status === "waiting" || c.status === "details" || c.status === "open" : scope === "closed" ? c.status === "closed" : c.status !== "closed"))
      .filter((c) => !w || `${c.phone} ${c.contactName ?? ""} ${c.companyName ?? ""} ${c.lastPreview}`.toLowerCase().includes(w));
  }, [list, q, scope]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[min(820px,92dvh)] max-w-[min(1100px,96vw)] flex-col gap-3 p-4 sm:max-w-[min(1100px,96vw)]">
        <DialogHeader className="flex-row items-center gap-3 space-y-0">
          <MessageSquareText className="size-5 text-primary" />
          <div className="min-w-0 flex-1">
            <DialogTitle>{t("sms.title")}</DialogTitle>
            <DialogDescription>{t("sms.subtitle")}</DialogDescription>
          </div>
          {summary && !summary.ready && <span className="rounded-lg border border-orange-500/40 bg-orange-500/10 px-2 py-1 text-[11px] text-orange-200">{t("sms.notReady")}</span>}
        </DialogHeader>
        <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[320px_minmax(0,1fr)]">
          {/* Conversations */}
          <section className={cn("flex min-h-0 flex-col overflow-hidden rounded-xl border", selected && "hidden md:flex")}>
            <div className="space-y-2 border-b p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("sms.search")} className="h-8 pl-8 text-sm" />
              </div>
              <div className="grid grid-cols-3 gap-1 rounded-lg border p-0.5 text-[11px]">
                {(["pending", "all", "closed"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setScope(k)}
                    className={cn("rounded-md px-1.5 py-1 font-medium", scope === k ? "bg-grad-gold text-[#1a1204]" : "text-muted-foreground hover:text-foreground")}
                  >
                    {t(`sms.scope.${k}`)}
                  </button>
                ))}
              </div>
            </div>
            {scope === "closed" && shown.length > 0 && (
              <div className="border-b px-2 py-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-full justify-start gap-1.5 text-[11px] text-muted-foreground hover:text-destructive"
                  disabled={deleteClosed.isPending}
                  onClick={() => void inboxConfirm({ title: t("sms.deleteClosedConfirm"), description: t("sms.deleteText"), destructive: true }).then((ok) => ok && deleteClosed.mutate())}
                >
                  {deleteClosed.isPending ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />} {t("sms.deleteClosed")}
                </Button>
              </div>
            )}
            <ul className="min-h-0 flex-1 divide-y overflow-y-auto">
              {isLoading && <Skeleton className="m-3 h-16" />}
              {list && shown.length === 0 && <li className="px-4 py-10 text-center text-sm text-muted-foreground">{t("sms.none")}</li>}
              {shown.map((c) => {
                const left = c.status === "waiting" || c.status === "details" ? minutesLeft(c.autoTicketAt) : null;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(c.id)}
                      className={cn("flex w-full flex-col gap-1 px-3 py-2.5 text-left transition hover:bg-accent/40", selected === c.id && "bg-[color:var(--gold)]/[0.07]")}
                    >
                      <span className="flex items-center gap-2">
                        <span className={cn("min-w-0 flex-1 truncate text-sm", c.unread ? "font-semibold" : "font-medium")}>{c.contactName || fmtPhone(c.phone)}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">{time(c.lastMessageAt)}</span>
                      </span>
                      <span className="truncate text-xs text-muted-foreground">{c.companyName ?? (c.contactName ? fmtPhone(c.phone) : t("sms.unknown"))}</span>
                      <span className="flex items-center gap-2">
                        <span className={cn("min-w-0 flex-1 truncate text-xs", c.unread ? "text-foreground" : "text-muted-foreground")}>{c.lastPreview}</span>
                        {c.unread > 0 && <span className="hex flex size-5 items-center justify-center bg-orange-500 text-[10px] font-bold text-white">{c.unread}</span>}
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className={cn("rounded-full border px-2 py-px text-[10px] font-medium", STATUS_STYLE[c.status])}>{t(`sms.status.${c.status}`)}</span>
                        {left !== null && (
                          <span className="flex items-center gap-1 text-[10px] text-orange-300">
                            <Timer className="size-3" /> {t("sms.autoIn", { delay: delayText(left) })}
                          </span>
                        )}
                        {c.ticketNumber && <span className="font-mono text-[10px] text-primary">{c.ticketNumber}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* Thread */}
          {selected ? (
            <ThreadView key={selected} id={selected} onBack={() => setSelected(null)} onTicket={onClose} />
          ) : (
            <div className="hidden min-h-0 items-center justify-center rounded-xl border text-sm text-muted-foreground md:flex">{t("sms.pick")}</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** "4 h", "1 h 30", "45 min". */
export function delayText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h${m ? ` ${String(m).padStart(2, "0")}` : ""}` : `${m} min`;
}

function ThreadView({ id, onBack, onTicket }: { id: string; onBack: () => void; onTicket: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const can = useCan();
  const confirm = useConfirm();
  const ws = useTicketWorkspace();
  const { data, isLoading } = useQuery({ queryKey: ["sms", "thread", id], queryFn: () => api.get<Thread>(`/sms/conversations/${id}`), refetchInterval: 10_000 });
  const { data: summary } = useSmsSummary();
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [data?.messages.length]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["sms"] });
  };
  const send = useMutation({
    mutationFn: () => api.post(`/sms/conversations/${id}/messages`, { body: text.trim() }),
    onSuccess: () => {
      setText("");
      refresh();
    },
    onError: (e) => toast.error(smsErrorText(t, e)),
  });
  // a number nobody knows: the technician says which client (and contact) first
  const [mapping, setMapping] = useState(false);
  const toTicket = useMutation({
    mutationFn: (who: { companyId: number; contactId: string | null } | void) => api.post<{ id: number; number: string }>(`/sms/conversations/${id}/ticket`, who ?? {}),
    onSuccess: (r) => {
      setMapping(false);
      toast.success(t("sms.ticketOpened", { number: r.number }));
      refresh();
      void qc.invalidateQueries({ queryKey: ["tickets"] });
      // straight into the new ticket, where the texts continue
      onTicket();
      ws.open(r.id);
    },
    onError: (e) => toast.error(smsErrorText(t, e)),
  });
  const close = useMutation({
    mutationFn: () => api.post(`/sms/conversations/${id}/close`, {}),
    onSuccess: () => {
      refresh();
      onBack();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/sms/conversations/${id}`),
    onSuccess: () => {
      refresh();
      onBack();
      toast.success(t("sms.deleted"));
    },
    onError: () => toast.error(t("common.error")),
  });
  if (isLoading || !data) return <Skeleton className="h-96 rounded-2xl" />;
  const parts = smsPartCount(text);
  const left = data.status === "waiting" || data.status === "details" ? minutesLeft(data.autoTicketAt) : null;
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Button variant="ghost" size="icon" className="size-8 lg:hidden" onClick={onBack} aria-label={t("common.close")}>
          <X className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{data.contactName || fmtPhone(data.phone)}</p>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span className="font-mono">{fmtPhone(data.phone)}</span>
            {data.companyName ? (
              <span className="flex items-center gap-1">
                <Building2 className="size-3" /> {data.companyName}
              </span>
            ) : (
              <span>{t("sms.unknown")}</span>
            )}
          </p>
        </div>
        <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", STATUS_STYLE[data.status])}>{t(`sms.status.${data.status}`)}</span>
        {data.ticketId ? (
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={() => {
              onTicket();
              ws.open(data.ticketId!);
            }}
          >
            <Ticket className="size-3.5" /> {data.ticketNumber}
          </Button>
        ) : (
          can("tickets.edit") && (
            <Button size="sm" className="h-8 gap-1.5 bg-grad-gold font-semibold text-[#1a1204]" disabled={toTicket.isPending} onClick={() => (data.contactId ? toTicket.mutate() : setMapping(true))}>
              {toTicket.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Ticket className="size-3.5" />} {t("sms.openTicket")}
            </Button>
          )
        )}
        {data.status !== "closed" && (
          <Button size="sm" variant="ghost" className="h-8" onClick={() => void confirm({ title: t("sms.closeConfirm") }).then((ok) => ok && close.mutate())}>
            <Archive className="size-3.5" /> {t("sms.close")}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-8 text-muted-foreground hover:text-destructive"
          disabled={remove.isPending}
          onClick={() => void confirm({ title: t("sms.deleteConfirm"), description: t("sms.deleteText"), destructive: true }).then((ok) => ok && remove.mutate())}
        >
          {remove.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />} {t("sms.delete")}
        </Button>
      </div>
      {left !== null && (
        <p className="flex items-center gap-2 border-b bg-orange-500/10 px-4 py-2 text-xs text-orange-200">
          <Clock3 className="size-3.5" /> {t("sms.waitingBanner", { delay: delayText(left) })}
        </p>
      )}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
        {data.messages.map((m) => (
          <div key={m.id} className={cn("flex", m.direction === "out" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[80%] rounded-2xl px-3 py-2 text-sm",
                m.direction === "in" ? "rounded-bl-sm bg-muted" : m.auto ? "rounded-br-sm border border-dashed border-[color:var(--gold)]/40 bg-transparent italic text-muted-foreground" : "rounded-br-sm bg-[color:var(--gold)]/20",
                m.status === "failed" && "border border-destructive/60",
              )}
            >
              <p className="whitespace-pre-wrap">{m.body}</p>
              <p className="mt-1 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
                {m.auto && <Bot className="size-3" />}
                {m.auto ? t("sms.automatic") : m.author}
                <span>· {time(m.createdAt)}</span>
                {m.status === "failed" && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <AlertTriangle className="size-3 text-destructive" />
                    </TooltipTrigger>
                    <TooltipContent>{t("sms.failed", { error: smsFailureText(t, m.error) })}</TooltipContent>
                  </Tooltip>
                )}
              </p>
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      {data.status !== "closed" && (
        <form
          className="border-t p-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (text.trim()) send.mutate();
          }}
        >
          <AiTextarea
            rows={2}
            value={text}
            maxLength={1000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim()) send.mutate();
            }}
            placeholder={t("sms.replyPlaceholder")}
          />
          <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>{counterText(t, text, parts, summary?.longAsMms)}</span>
            <Button type="submit" size="sm" disabled={!text.trim() || send.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
              {send.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} {t("sms.send")}
            </Button>
          </div>
        </form>
      )}
      {mapping && (
        <MapDialog
          phone={data.phone}
          company={data.companyId != null ? { id: data.companyId, name: data.companyName ?? "" } : null}
          saving={toTicket.isPending}
          onClose={() => setMapping(false)}
          onPick={(who) => toTicket.mutate(who)}
        />
      )}
    </section>
  );
}

/** What VoIP.ms answered, in words (its status codes: ip_not_enabled, invalid_did…) */
const voipmsText = (t: (k: string, o?: Record<string, unknown>) => string, status: string) =>
  t(`sms.voipms.${status}`, { defaultValue: "" }) || `${t("sms.errors.sms_api")} (${status})`;

/** A failed text's stored reason ("disabled", "api: ip_not_enabled", "network: TimeoutError") in words */
export function smsFailureText(t: (k: string, o?: Record<string, unknown>) => string, raw: string | null | undefined): string {
  if (!raw) return t("sms.errors.sms_api");
  const [code, ...rest] = raw.split(":");
  const detail = rest.join(":").trim();
  if (code === "api" && detail) return voipmsText(t, detail);
  return t(`sms.errors.sms_${code}`, { defaultValue: raw }) + (detail && code !== "api" ? ` (${detail})` : "");
}

export function smsErrorText(t: (k: string, o?: Record<string, unknown>) => string, e: unknown): string {
  if (e instanceof ApiError) {
    const detail = e.fields?.find((f) => f.path === "sms")?.message;
    if (e.code === "sms_api" && detail) return voipmsText(t, detail);
    return t(`sms.errors.${e.code}`, { defaultValue: t("common.error") }) + (detail ? ` (${detail})` : "");
  }
  return t("common.error");
}

export function useTicketSms(ticketId: number, enabled: boolean) {
  return useQuery({
    queryKey: ["sms", "ticket", ticketId],
    queryFn: () => api.get<{ messages: Message[]; conversations: Conversation[] }>(`/sms/ticket/${ticketId}`),
    enabled,
    refetchInterval: 15_000,
  });
}

/** "120 caractères · 2 textos", or "· 1 MMS" when long messages go as MMS */
function counterText(t: (k: string, o?: Record<string, unknown>) => string, text: string, parts: number, mms?: boolean) {
  return parts > 1 && mms ? t("sms.counterMms", { count: text.length }) : t("sms.counter", { count: text.length, parts });
}

/** The last 10 digits: how numbers are compared */
const d10 = (p: string | null | undefined) => (p ?? "").replace(/\D/g, "").slice(-10);
const initialsOf = (n: string) =>
  n
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

type Recipient = { phone: string; name: string | null; contactId?: string | null };
type Entry = {
  key: string;
  kind: "person" | "group";
  name: string;
  /** Person: their number; group: the people's numbers */
  phones: string[];
  people: Recipient[];
  isClient?: boolean;
  groupKey?: string;
  messages: Message[];
  unread: number;
};

/**
 * In a ticket: the texts, with a small sidebar of the conversations of this
 * ticket — the ticket's client first (shown by default), anyone else, and group
 * texts (the same text to several people; each person answers on their own) —
 * and "+" to text someone new or a group.
 */
export function TicketSmsPanel({ ticketId, phone, companyId, clientName }: { ticketId: number; phone: string | null; companyId: number; clientName: string | null }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useTicketSms(ticketId, true);
  const { data: summary } = useSmsSummary();
  const { data: contacts = [] } = useContacts(companyId);
  const clientPhone = d10(phone);

  // who is who: every conversation of the ticket, by number
  const entries = useMemo<Entry[]>(() => {
    const convs = data?.conversations ?? [];
    const msgs = data?.messages ?? [];
    const nameOf = (c: Conversation | undefined, p: string) => c?.contactName ?? (p === clientPhone ? clientName : null) ?? fmtPhone(p);
    const phones = [...new Set([...(clientPhone ? [clientPhone] : []), ...convs.map((c) => c.phone)])];
    const people: Entry[] = phones.map((p) => {
      const mine = convs.filter((c) => c.phone === p);
      const ids = new Set(mine.map((c) => c.id));
      return {
        key: p === clientPhone ? "client" : `p:${p}`,
        kind: "person",
        name: nameOf(mine[0], p),
        phones: [p],
        people: [{ phone: p, name: nameOf(mine[0], p), contactId: mine[0]?.contactId }],
        isClient: p === clientPhone,
        messages: msgs.filter((m) => m.conversationId && ids.has(m.conversationId)),
        unread: mine.reduce((n, c) => n + c.unread, 0),
      };
    });
    // the ticket's client always has an entry, even with no number yet
    if (!clientPhone) people.unshift({ key: "client", kind: "person", name: clientName ?? t("sms.ticket.client"), phones: [], people: [], isClient: true, messages: [], unread: 0 });
    // group texts: one entry per group key — what was sent once, and what each person answered after
    const groups: Entry[] = [];
    for (const key of [...new Set(msgs.map((m) => m.groupKey).filter((k): k is string => Boolean(k)))]) {
      const sent = msgs.filter((m) => m.groupKey === key);
      const convIds = new Set(sent.map((m) => m.conversationId));
      const members = convs.filter((c) => convIds.has(c.id));
      const first = sent.map((m) => m.createdAt).sort()[0];
      // each person got their own copy a moment apart: shown once (same text within a minute)
      const out: Message[] = [];
      for (const m of [...sent].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        if (!out.some((o) => o.body === m.body && Math.abs(Date.parse(m.createdAt) - Date.parse(o.createdAt)) < 60_000)) out.push(m);
      }
      const back = msgs.filter((m) => m.direction === "in" && m.conversationId && convIds.has(m.conversationId) && m.createdAt >= first);
      groups.push({
        key: `g:${key}`,
        kind: "group",
        name: members.map((c) => nameOf(c, c.phone).split(" ")[0]).join(", "),
        phones: members.map((c) => c.phone),
        people: members.map((c) => ({ phone: c.phone, name: nameOf(c, c.phone), contactId: c.contactId })),
        groupKey: key,
        messages: [...out, ...back].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        unread: members.reduce((n, c) => n + c.unread, 0),
      });
    }
    const last = (e: Entry) => e.messages.at(-1)?.createdAt ?? "";
    const rest = [...people.filter((e) => !e.isClient), ...groups].sort((a, b) => last(b).localeCompare(last(a)));
    return [...people.filter((e) => e.isClient), ...rest];
  }, [data, clientPhone, clientName, t]);
  const names = useMemo(() => new Map((data?.conversations ?? []).map((c) => [c.id, c.contactName ?? fmtPhone(c.phone)])), [data]);

  // "client" (shown by default), another entry, or "new" (text someone / a group)
  const [sel, setSel] = useState("client");
  const entry = entries.find((e) => e.key === sel) ?? entries[0];
  const composing = sel === "new";
  const [to, setTo] = useState(phone ?? "");
  const [picked, setPicked] = useState<Recipient[]>([]);
  const [other, setOther] = useState("");
  const [text, setText] = useState("");
  const [find, setFind] = useState("");
  useEffect(() => setTo(phone ?? ""), [phone]);
  const end = useRef<HTMLDivElement>(null);
  const shown = composing ? [] : (entry?.messages ?? []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [shown.length, sel]);

  // looking at the texts of the ticket clears what was unread (and the blinking tab)
  const unreadTotal = (data?.conversations ?? []).reduce((n, c) => n + c.unread, 0);
  useEffect(() => {
    if (unreadTotal > 0) void api.post(`/sms/ticket/${ticketId}/read`).then(() => qc.invalidateQueries({ queryKey: ["sms"] }));
  }, [unreadTotal, ticketId, qc]);

  const send = useMutation({
    mutationFn: (v: { phone?: string; recipients?: Recipient[]; groupKey?: string }) => api.post<{ groupKey: string | null }>(`/sms/ticket/${ticketId}`, { ...v, body: text.trim() }),
    onSuccess: (r, v) => {
      setText("");
      void qc.invalidateQueries({ queryKey: ["sms"] });
      void qc.invalidateQueries({ queryKey: ["tickets", "detail", ticketId] });
      // a new text goes to its person (or its group) conversation
      if (composing) {
        setSel(r.groupKey ? `g:${r.groupKey}` : v.recipients?.[0] && d10(v.recipients[0].phone) === clientPhone ? "client" : `p:${d10(v.recipients?.[0]?.phone)}`);
        setPicked([]);
      }
    },
    onError: (e) => toast.error(smsErrorText(t, e)),
  });
  const canSend = Boolean(text.trim()) && !send.isPending && (composing ? picked.length > 0 : entry?.kind === "group" ? true : Boolean(to));
  const doSend = () => {
    if (!canSend) return;
    if (composing) send.mutate({ recipients: picked });
    else if (entry?.kind === "group") send.mutate({ recipients: entry.people, groupKey: entry.groupKey });
    else send.mutate({ phone: entry?.isClient ? to : entry?.phones[0] });
  };

  const togglePick = (r: Recipient) => setPicked((l) => (l.some((x) => d10(x.phone) === d10(r.phone)) ? l.filter((x) => d10(x.phone) !== d10(r.phone)) : [...l, r]));
  const addOther = () => {
    const n = other.trim();
    if (d10(n).length === 10 && !picked.some((x) => d10(x.phone) === d10(n))) setPicked((l) => [...l, { phone: n, name: null }]);
    setOther("");
  };
  const withPhone = contacts.filter((c) => d10(c.phone).length === 10 && `${c.name} ${c.phone}`.toLowerCase().includes(find.toLowerCase()));

  return (
    <section className="glass flex min-h-80 flex-col overflow-hidden rounded-2xl border sm:flex-row">
      {/* Sidebar: this ticket's conversations */}
      <aside className="flex max-h-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-b p-1.5 sm:max-h-[60vh] sm:w-52 sm:border-b-0 sm:border-r" aria-label={t("sms.ticket.sidebar")}>
        {entries.map((e) => (
          <button
            key={e.key}
            type="button"
            onClick={() => setSel(e.key)}
            aria-pressed={sel === e.key}
            className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors", sel === e.key ? "bg-[color:var(--gold)]/15" : "hover:bg-accent/50")}
          >
            <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold", e.kind === "group" ? "bg-violet-500/20 text-violet-300" : e.isClient ? "bg-grad-gold text-[#1a1204]" : "bg-muted")}>
              {e.kind === "group" ? <Users className="size-3.5" /> : initialsOf(e.name)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1 text-xs font-medium">
                <span className="truncate">{e.kind === "group" ? t("sms.ticket.groupOf", { count: e.people.length }) : e.name}</span>
                {e.isClient && <span className="shrink-0 rounded bg-[color:var(--gold)]/20 px-1 text-[9px] font-semibold uppercase text-primary">{t("sms.ticket.client")}</span>}
              </span>
              <span className="block truncate text-[10px] text-muted-foreground">{e.messages.at(-1)?.body ?? (e.kind === "group" ? e.name : t("sms.ticket.noText"))}</span>
            </span>
            {e.unread > 0 && <span className="size-2 shrink-0 animate-pulse rounded-full bg-orange-400" aria-label={t("sms.ticket.unread", { count: e.unread })} />}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setSel("new")}
          aria-pressed={composing}
          className={cn("mt-1 flex w-full items-center gap-2 rounded-lg border border-dashed px-2 py-1.5 text-left text-xs transition-colors", composing ? "border-[color:var(--gold)]/60 bg-[color:var(--gold)]/10 text-foreground" : "text-muted-foreground hover:border-[color:var(--gold)]/50 hover:text-foreground")}
        >
          <Plus className="size-4 shrink-0 text-primary" /> {t("sms.ticket.newText")}
        </button>
      </aside>

      {/* The conversation, or who the new text goes to */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b px-4 py-2 text-xs">
          {composing ? (
            <span className="font-medium">{t("sms.ticket.newTitle")}</span>
          ) : (
            <>
              <span className="font-medium">{entry?.kind === "group" ? t("sms.ticket.groupOf", { count: entry.people.length }) : entry?.name}</span>
              <span className="truncate text-muted-foreground">{entry?.kind === "group" ? entry.name : entry?.phones[0] ? fmtPhone(entry.phones[0]) : ""}</span>
            </>
          )}
        </div>

        {composing ? (
          <div className="max-h-[42vh] min-h-40 space-y-3 overflow-y-auto p-4">
            <p className="text-xs text-muted-foreground">{t("sms.ticket.pickHint")}</p>
            {contacts.some((c) => d10(c.phone).length === 10) && (
              <div className="space-y-1.5">
                {contacts.length > 6 && <Input value={find} onChange={(e) => setFind(e.target.value)} placeholder={t("sms.ticket.find")} className="h-8 text-xs" />}
                <ul className="max-h-40 divide-y overflow-y-auto rounded-lg border">
                  {withPhone.map((c) => {
                    const on = picked.some((x) => d10(x.phone) === d10(c.phone));
                    return (
                      <li key={c.id}>
                        <label className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-accent/40">
                          <input type="checkbox" checked={on} onChange={() => togglePick({ phone: c.phone!, name: c.name, contactId: c.id })} className="accent-[color:var(--gold)]" />
                          <span className="min-w-0 flex-1 truncate">{c.name}</span>
                          <span className="font-mono text-[11px] text-muted-foreground">{fmtPhone(d10(c.phone))}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Input type="tel" value={other} onChange={(e) => setOther(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addOther())} placeholder={t("sms.ticket.otherNumber")} className="h-8 max-w-48 font-mono text-xs" />
              <Button type="button" size="sm" variant="outline" className="h-8" disabled={d10(other).length !== 10} onClick={addOther}>
                <Plus className="size-3.5" /> {t("sms.ticket.add")}
              </Button>
            </div>
            {picked.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {picked.map((r) => (
                  <span key={r.phone} className="flex items-center gap-1 rounded-full border border-[color:var(--gold)]/40 bg-[color:var(--gold)]/10 py-0.5 pl-2.5 pr-1 text-xs">
                    {r.name ?? fmtPhone(d10(r.phone))}
                    <button type="button" onClick={() => togglePick(r)} aria-label={t("common.delete")} className="rounded-full p-0.5 hover:bg-foreground/10">
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
                {picked.length > 1 && <span className="text-[11px] text-violet-300">{t("sms.ticket.groupNote", { count: picked.length })}</span>}
              </div>
            )}
          </div>
        ) : (
          <div className="max-h-[42vh] min-h-40 space-y-2 overflow-y-auto p-4">
            {isLoading && <Skeleton className="h-16" />}
            {data && shown.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">{t("sms.noneInTicket")}</p>}
            {shown.map((m) => (
              <div key={m.id} className={cn("flex", m.direction === "out" ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "max-w-[80%] rounded-2xl px-3 py-2 text-sm",
                    m.direction === "in" ? "rounded-bl-sm bg-muted" : m.auto ? "rounded-br-sm border border-dashed border-[color:var(--gold)]/40 italic text-muted-foreground" : "rounded-br-sm bg-[color:var(--gold)]/20",
                    m.status === "failed" && "border border-destructive/60",
                  )}
                >
                  <p className="whitespace-pre-wrap">{m.body}</p>
                  <p className="mt-1 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
                    {m.auto && <Bot className="size-3" />}
                    {m.groupKey && entry?.kind !== "group" && <Users className="size-3 text-violet-300" aria-label={t("sms.ticket.groupMessage")} />}
                    {m.auto ? t("sms.automatic") : m.direction === "in" ? (entry?.kind === "group" ? (names.get(m.conversationId ?? "") ?? t("sms.client")) : t("sms.client")) : m.author}
                    <span>· {time(m.createdAt)}</span>
                    {m.status === "failed" && <AlertTriangle className="size-3 text-destructive" />}
                  </p>
                  {m.status === "failed" && <p className="mt-1 text-[11px] not-italic text-destructive">{t("sms.failed", { error: smsFailureText(t, m.error) })}</p>}
                </div>
              </div>
            ))}
            <div ref={end} />
          </div>
        )}

        <form
          className="space-y-2 border-t p-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            doSend();
          }}
        >
          {summary && !summary.ready && (
            <p className="flex items-start gap-1.5 rounded-lg border border-orange-500/40 bg-orange-500/10 px-2.5 py-1.5 text-[11px] text-orange-200">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {t("sms.cannotSend")}
            </p>
          )}
          {!composing && entry?.kind === "person" && entry.isClient && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{t("sms.to")}</span>
              <Input type="tel" value={to} onChange={(e) => setTo(e.target.value)} placeholder={t("sms.toNumber")} className="h-8 max-w-48 font-mono text-xs" />
            </div>
          )}
          {!composing && entry?.kind === "group" && <p className="text-[11px] text-violet-300">{t("sms.ticket.groupReply", { names: entry.name })}</p>}
          <AiTextarea
            rows={2}
            maxLength={1000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) doSend();
            }}
            placeholder={t("sms.replyPlaceholder")}
          />
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              {counterText(t, text, smsPartCount(text), summary?.longAsMms)} · {t("sms.inAutotask")}
            </span>
            <Button type="submit" size="sm" disabled={!canSend} className="bg-grad-gold font-semibold text-[#1a1204]">
              {send.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} {composing && picked.length > 1 ? t("sms.ticket.sendGroup", { count: picked.length }) : t("sms.send")}
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}

/** Before a ticket for a number nobody knows: which client, and which contact (optional, or a new one). */
function MapDialog({
  phone,
  company: start,
  saving,
  onClose,
  onPick,
}: {
  phone: string;
  company: Company | null;
  saving: boolean;
  onClose: () => void;
  onPick: (p: { companyId: number; contactId: string | null }) => void;
}) {
  const { t } = useTranslation();
  const { data: companies = [] } = useCompanies();
  const [company, setCompany] = useState<Company | null>(start);
  const [contact, setContact] = useState<{ id: string; name: string } | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Ticket className="size-5 text-primary" /> {t("sms.map.title")}
          </DialogTitle>
          <DialogDescription>{t("sms.map.text", { phone: fmtPhone(phone) })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">{t("sms.map.client")}</Label>
            <CompanyPicker
              value={company}
              companies={companies}
              onChange={(c) => {
                setCompany(c);
                setContact(null);
              }}
              triggerClassName="w-full"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("sms.map.contact")}</Label>
            <ContactPicker companyId={company?.id ?? null} value={contact?.id ?? null} valueName={contact?.name} onChange={(c) => setContact(c ? { id: c.id, name: c.name } : null)} disabled={!company} triggerClassName="w-full" canCreate />
            <p className="text-[11px] text-muted-foreground">{t("sms.map.contactHint")}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!company || saving} onClick={() => company && onPick({ companyId: company.id, contactId: contact?.id ?? null })} className="bg-grad-gold font-semibold text-[#1a1204]">
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Ticket className="size-4" />} {t("sms.openTicket")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
