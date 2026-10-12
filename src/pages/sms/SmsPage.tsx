import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Archive, Bot, Building2, Clock3, Loader2, MessageSquareText, Search, Send, Ticket, Timer, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GlassBackdrop } from "@/components/brand/GlassBackdrop";
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
  companyName: string | null;
  status: "waiting" | "open" | "ticket" | "closed";
  ticketId: number | null;
  ticketNumber: string | null;
  autoTicketAt: string | null;
  unread: number;
  lastMessageAt: string;
  lastPreview: string;
};
type Message = { id: string; direction: "in" | "out"; body: string; auto: boolean; status: "received" | "sent" | "failed"; error?: string | null; createdAt: string; author: string | null };
type Thread = Conversation & { messages: Message[]; max: number };
type Summary = { waiting: number; unread: number; open: number; next: string | null; ready: boolean };

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
  open: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  ticket: "border-[color:var(--gold)]/50 bg-[color:var(--gold)]/10 text-primary",
  closed: "border-border text-muted-foreground",
};

export function useSmsSummary() {
  const can = useCan();
  return useQuery({ queryKey: ["sms", "summary"], queryFn: () => api.get<Summary>("/sms/summary"), enabled: can("sms.view"), refetchInterval: 30_000 });
}

/** Tile on the ticket page: texts waiting for a technician. */
export function SmsTile() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data } = useSmsSummary();
  if (!data || (!data.ready && !data.open)) return null;
  const left = minutesLeft(data.next);
  return (
    <button
      type="button"
      onClick={() => navigate("/sms")}
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
          {data.waiting ? t("sms.tileWaiting", { count: data.waiting, minutes: left ?? 0 }) : t("sms.tileUnread", { count: data.unread })}
        </span>
      </span>
      <span className={cn("font-mono text-3xl font-semibold tabular-nums", data.waiting || data.unread ? "text-foreground" : "text-muted-foreground/50")}>{data.waiting || data.unread}</span>
    </button>
  );
}

export function SmsPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const selected = params.get("c");
  const [q, setQ] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const { data: list, isLoading } = useQuery({
    queryKey: ["sms", "conversations", showClosed],
    queryFn: () => api.get<Conversation[]>(`/sms/conversations${showClosed ? "?all=1" : ""}`),
    refetchInterval: 15_000,
  });
  const { data: summary } = useSmsSummary();
  const shown = useMemo(() => {
    const w = q.toLowerCase().replace(/[^\w\s]/g, "");
    return (list ?? []).filter((c) => !w || `${c.phone} ${c.contactName ?? ""} ${c.companyName ?? ""} ${c.lastPreview}`.toLowerCase().includes(w));
  }, [list, q]);
  const pick = (id: string | null) =>
    setParams((p) => {
      if (id) p.set("c", id);
      else p.delete("c");
      return p;
    });

  return (
    <div className="relative isolate space-y-4">
      <GlassBackdrop className="-inset-x-8 -top-6" />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <MessageSquareText className="size-6 text-primary" /> {t("sms.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("sms.subtitle")}</p>
        </div>
        {summary && !summary.ready && <p className="rounded-lg border border-orange-500/40 bg-orange-500/10 px-3 py-1.5 text-xs text-orange-200">{t("sms.notReady")}</p>}
      </div>

      <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
        {/* Conversations */}
        <section className={cn("glass flex max-h-[calc(100dvh-14rem)] flex-col overflow-hidden rounded-2xl border", selected && "hidden lg:flex")}>
          <div className="flex items-center gap-2 border-b p-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("sms.search")} className="h-8 pl-8 text-sm" />
            </div>
            <Button variant={showClosed ? "secondary" : "ghost"} size="sm" className="h-8 text-xs" onClick={() => setShowClosed((v) => !v)}>
              <Archive className="size-3.5" /> {t("sms.closed")}
            </Button>
          </div>
          <ul className="min-h-0 flex-1 divide-y overflow-y-auto">
            {isLoading && <Skeleton className="m-3 h-16" />}
            {list && shown.length === 0 && <li className="px-4 py-10 text-center text-sm text-muted-foreground">{t("sms.none")}</li>}
            {shown.map((c) => {
              const left = c.status === "waiting" ? minutesLeft(c.autoTicketAt) : null;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => pick(c.id)}
                    className={cn("flex w-full flex-col gap-1 px-4 py-3 text-left transition hover:bg-accent/40", selected === c.id && "bg-[color:var(--gold)]/[0.07]")}
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
                          <Timer className="size-3" /> {t("sms.autoIn", { count: left })}
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
          <ThreadView key={selected} id={selected} onBack={() => pick(null)} />
        ) : (
          <div className="glass hidden min-h-80 items-center justify-center rounded-2xl border text-sm text-muted-foreground lg:flex">{t("sms.pick")}</div>
        )}
      </div>
    </div>
  );
}

function ThreadView({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const can = useCan();
  const confirm = useConfirm();
  const ws = useTicketWorkspace();
  const { data, isLoading } = useQuery({ queryKey: ["sms", "thread", id], queryFn: () => api.get<Thread>(`/sms/conversations/${id}`), refetchInterval: 10_000 });
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [data?.messages.length]);
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
  const toTicket = useMutation({
    mutationFn: () => api.post<{ id: number; number: string }>(`/sms/conversations/${id}/ticket`, {}),
    onSuccess: (r) => {
      toast.success(t("sms.ticketOpened", { number: r.number }));
      refresh();
      void qc.invalidateQueries({ queryKey: ["tickets"] });
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
  if (isLoading || !data) return <Skeleton className="h-96 rounded-2xl" />;
  const parts = Math.max(1, Math.ceil(text.length / (data.max || 160)));
  const left = data.status === "waiting" ? minutesLeft(data.autoTicketAt) : null;
  return (
    <section className="glass flex max-h-[calc(100dvh-14rem)] min-h-96 flex-col overflow-hidden rounded-2xl border">
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
          <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => ws.open(data.ticketId!)}>
            <Ticket className="size-3.5" /> {data.ticketNumber}
          </Button>
        ) : (
          can("tickets.edit") && (
            <Button size="sm" className="h-8 gap-1.5 bg-grad-gold font-semibold text-[#1a1204]" disabled={toTicket.isPending} onClick={() => toTicket.mutate()}>
              {toTicket.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Ticket className="size-3.5" />} {t("sms.openTicket")}
            </Button>
          )
        )}
        {data.status !== "closed" && (
          <Button size="sm" variant="ghost" className="h-8" onClick={() => void confirm({ title: t("sms.closeConfirm") }).then((ok) => ok && close.mutate())}>
            <Archive className="size-3.5" /> {t("sms.close")}
          </Button>
        )}
      </div>
      {left !== null && (
        <p className="flex items-center gap-2 border-b bg-orange-500/10 px-4 py-2 text-xs text-orange-200">
          <Clock3 className="size-3.5" /> {t("sms.waitingBanner", { count: left })}
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
                    <TooltipContent>{t("sms.failed", { error: m.error ?? "" })}</TooltipContent>
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
          <Textarea
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
            <span>{t("sms.counter", { count: text.length, parts })}</span>
            <Button type="submit" size="sm" disabled={!text.trim() || send.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
              {send.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} {t("sms.send")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

export function smsErrorText(t: (k: string, o?: Record<string, unknown>) => string, e: unknown): string {
  if (e instanceof ApiError) {
    const detail = e.fields?.find((f) => f.path === "sms" || f.path === "autotask")?.message;
    return t(`sms.errors.${e.code}`, { defaultValue: t("common.error") }) + (detail ? ` (${detail})` : "");
  }
  return t("common.error");
}

/** From a ticket: the texts with the client, and a new one (to the contact's number by default). */
export function TicketSmsDialog({ ticketId, ticketNumber, phone, contact, onClose }: { ticketId: number; ticketNumber: string; phone: string | null; contact: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["sms", "ticket", ticketId], queryFn: () => api.get<{ messages: Message[] }>(`/sms/ticket/${ticketId}`) });
  const [to, setTo] = useState(phone ?? "");
  const [text, setText] = useState("");
  const send = useMutation({
    mutationFn: () => api.post(`/sms/ticket/${ticketId}`, { phone: to, body: text.trim() }),
    onSuccess: () => {
      setText("");
      toast.success(t("sms.sent"));
      void qc.invalidateQueries({ queryKey: ["sms"] });
      void qc.invalidateQueries({ queryKey: ["tickets", "detail", ticketId] });
    },
    onError: (e) => toast.error(smsErrorText(t, e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquareText className="size-5 text-primary" /> {t("sms.toClient")}
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono text-primary">{ticketNumber}</span> · {contact || t("sms.unknown")}
          </DialogDescription>
        </DialogHeader>
        {data && data.messages.length > 0 && (
          <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-xl border p-3">
            {data.messages.map((m) => (
              <div key={m.id} className={cn("flex", m.direction === "out" ? "justify-end" : "justify-start")}>
                <p className={cn("max-w-[85%] rounded-xl px-2.5 py-1.5 text-xs", m.direction === "in" ? "bg-muted" : m.auto ? "italic text-muted-foreground" : "bg-[color:var(--gold)]/20")}>
                  {m.body}
                  <span className="block text-right text-[9px] text-muted-foreground">{time(m.createdAt)}</span>
                </p>
              </div>
            ))}
          </div>
        )}
        <form
          className="space-y-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (to && text.trim()) send.mutate();
          }}
        >
          <Input type="tel" value={to} onChange={(e) => setTo(e.target.value)} placeholder={t("sms.toNumber")} />
          <Textarea autoFocus rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("sms.replyPlaceholder")} />
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{t("sms.counter", { count: text.length, parts: Math.max(1, Math.ceil(text.length / 160)) })}</span>
            <Button type="submit" size="sm" disabled={!to || !text.trim() || send.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
              {send.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} {t("sms.send")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
