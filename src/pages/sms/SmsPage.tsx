import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Archive, Bot, Building2, Clock3, Loader2, MessageSquareText, Search, Send, Ticket, Timer, X } from "lucide-react";
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
  const { data: list, isLoading } = useQuery({
    queryKey: ["sms", "conversations", scope === "closed"],
    queryFn: () => api.get<Conversation[]>(`/sms/conversations${scope === "closed" ? "?all=1" : ""}`),
    refetchInterval: 15_000,
  });
  const { data: summary } = useSmsSummary();
  const shown = useMemo(() => {
    const w = q.toLowerCase().replace(/[^\w\s]/g, "");
    return (list ?? [])
      .filter((c) => (scope === "pending" ? c.status === "waiting" || c.status === "open" : scope === "closed" ? c.status === "closed" : c.status !== "closed"))
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
            <ul className="min-h-0 flex-1 divide-y overflow-y-auto">
              {isLoading && <Skeleton className="m-3 h-16" />}
              {list && shown.length === 0 && <li className="px-4 py-10 text-center text-sm text-muted-foreground">{t("sms.none")}</li>}
              {shown.map((c) => {
                const left = c.status === "waiting" ? minutesLeft(c.autoTicketAt) : null;
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
  const toTicket = useMutation({
    mutationFn: () => api.post<{ id: number; number: string }>(`/sms/conversations/${id}/ticket`, {}),
    onSuccess: (r) => {
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
  if (isLoading || !data) return <Skeleton className="h-96 rounded-2xl" />;
  const parts = Math.max(1, Math.ceil(text.length / (data.max || 160)));
  const left = data.status === "waiting" ? minutesLeft(data.autoTicketAt) : null;
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
    const detail = e.fields?.find((f) => f.path === "sms" || f.path === "autotask")?.message;
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

/** In a ticket: the texts with the client (instead of the activity), and the reply box. */
export function TicketSmsPanel({ ticketId, phone }: { ticketId: number; phone: string | null }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useTicketSms(ticketId, true);
  const { data: summary } = useSmsSummary();
  const known = data?.conversations[0]?.phone ?? null;
  const [to, setTo] = useState(known ?? phone ?? "");
  useEffect(() => {
    if (known) setTo((v) => v || known);
  }, [known]);
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [data?.messages.length]);
  const send = useMutation({
    mutationFn: () => api.post(`/sms/ticket/${ticketId}`, { phone: to, body: text.trim() }),
    onSuccess: () => {
      setText("");
      void qc.invalidateQueries({ queryKey: ["sms"] });
      void qc.invalidateQueries({ queryKey: ["tickets", "detail", ticketId] });
    },
    onError: (e) => toast.error(smsErrorText(t, e)),
  });
  return (
    <section className="glass flex flex-col rounded-2xl border">
      <div className="max-h-[50vh] min-h-40 space-y-2 overflow-y-auto p-4">
        {isLoading && <Skeleton className="h-16" />}
        {data && data.messages.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">{t("sms.noneInTicket")}</p>}
        {data?.messages.map((m) => (
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
                {m.auto ? t("sms.automatic") : m.direction === "in" ? t("sms.client") : m.author}
                <span>· {time(m.createdAt)}</span>
                {m.status === "failed" && <AlertTriangle className="size-3 text-destructive" />}
              </p>
              {m.status === "failed" && <p className="mt-1 text-[11px] not-italic text-destructive">{t("sms.failed", { error: smsFailureText(t, m.error) })}</p>}
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        className="space-y-2 border-t p-3"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (to && text.trim()) send.mutate();
        }}
      >
        {summary && !summary.ready && (
          <p className="flex items-start gap-1.5 rounded-lg border border-orange-500/40 bg-orange-500/10 px-2.5 py-1.5 text-[11px] text-orange-200">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {t("sms.cannotSend")}
          </p>
        )}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("sms.to")}</span>
          <Input type="tel" value={to} onChange={(e) => setTo(e.target.value)} placeholder={t("sms.toNumber")} className="h-8 max-w-48 font-mono text-xs" />
        </div>
        <AiTextarea
          rows={2}
          maxLength={1000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && to && text.trim()) send.mutate();
          }}
          placeholder={t("sms.replyPlaceholder")}
        />
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>
            {t("sms.counter", { count: text.length, parts: Math.max(1, Math.ceil(text.length / 160)) })} · {t("sms.inAutotask")}
          </span>
          <Button type="submit" size="sm" disabled={!to || !text.trim() || send.isPending} className="bg-grad-gold font-semibold text-[#1a1204]">
            {send.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} {t("sms.send")}
          </Button>
        </div>
      </form>
    </section>
  );
}
