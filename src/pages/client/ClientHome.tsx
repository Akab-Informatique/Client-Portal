import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { ArrowLeft, CalendarDays, ChevronRight, Info, Loader2, Megaphone, Pin, TicketPlus, X } from "lucide-react";
import { useDeepLink } from "@/lib/useDeepLink";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, ApiError } from "@/lib/api";
import { useCan, useMe } from "@/lib/session";
import { dateTime, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PageHeader, Pane } from "./ui";

type BoardMessage = { id: string; title: string; body: string; pinned: boolean; createdAt: string; read: boolean };
type SupportContact = { phone: string | null; email: string | null };

/** Client portal › Message board: read-only for clients; a click opens the message, a question becomes a ticket. */
export function ClientHome() {
  const { t } = useTranslation();
  const me = useMe();
  const qc = useQueryClient();
  const { data = [], isLoading } = useQuery({ queryKey: ["board"], queryFn: () => api.get<BoardMessage[]>("/board") });
  const { data: contact } = useQuery({ queryKey: ["board", "contact"], queryFn: () => api.get<SupportContact>("/board/contact"), staleTime: 10 * 60_000 });
  const highlight = useDeepLink("message", "msg-", data.length > 0);
  const [openId, setOpenId] = useState<string | null>(null);
  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/board/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["board"] }),
  });
  const open = (m: BoardMessage) => {
    setOpenId(m.id);
    if (!m.read && !me.viewAs) markRead.mutate(m.id);
  };
  // a link to a message (notification, email) opens it
  useEffect(() => {
    const m = highlight ? data.find((x) => x.id === highlight) : null;
    if (m) open(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight]);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Megaphone}
        eyebrow={t("client.nav.boardSection")}
        title={t("client.board")}
        subtitle={`${t("client.welcome", { name: me.viewAs ? me.viewAs.clientName : me.name.split(" ")[0] })} — ${t("client.boardIntro")}`}
      />

      {isLoading && <div className="pane h-40 animate-pulse rounded-2xl" />}
      {!isLoading && !data.length && (
        <Pane className="flex flex-col items-center gap-2 p-12 text-center text-sm text-muted-foreground">
          <Megaphone className="size-6 text-primary/60" />
          {t("client.boardEmpty")}
        </Pane>
      )}

      <ul className="space-y-3">
        {data.map((m, i) => (
          <motion.li key={m.id} id={`msg-${m.id}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.05, 0.4) }}>
            <button
              type="button"
              onClick={() => open(m)}
              className={cn(
                "pane group flex w-full items-start gap-4 overflow-hidden rounded-2xl p-5 text-left transition-all duration-300 hover:-translate-y-px hover:border-[color:var(--gold)]/35 hover:shadow-[0_20px_44px_-26px_var(--gold)] sm:p-6",
                m.pinned && "gold-edge border-[color:var(--gold)]/30",
                highlight === m.id && "border-[color:var(--gold)]",
              )}
            >
              {!m.read && <span className="absolute inset-y-4 left-0 w-[3px] rounded-r-full bg-grad-gold shadow-[0_0_12px_var(--gold)]" />}
              <span
                className={cn(
                  "flex size-10 shrink-0 items-center justify-center rounded-xl border",
                  m.pinned ? "border-[color:var(--gold)]/35 bg-[color:var(--gold)]/12 text-primary" : "border-[color:var(--glass-border)] bg-foreground/[0.04] text-muted-foreground",
                )}
              >
                {m.pinned ? <Pin className="size-4" /> : <Megaphone className="size-4" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2.5">
                  <span className={cn("text-[1.05rem] font-semibold", !m.read && "text-foreground")}>{m.title}</span>
                  {!m.read && <Badge className="rounded-full bg-grad-gold text-[#1a1204]">{t("client.new")}</Badge>}
                  <span className="ml-auto text-xs text-muted-foreground">{relativeTime(m.createdAt)}</span>
                </span>
                <span className="mt-1.5 line-clamp-2 block whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{m.body}</span>
                <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary/90 transition-colors group-hover:text-primary">
                  {t("client.boardRead")} <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </span>
            </button>
          </motion.li>
        ))}
      </ul>

      <MessageDialog message={data.find((x) => x.id === openId) ?? null} onClose={() => setOpenId(null)} contact={contact ?? null} />
    </div>
  );
}

/**
 * One message, centred over the page (glass): the full text, then how to ask
 * about it. "Open a ticket" turns the same window into the question form.
 */
function MessageDialog({ message, onClose, contact }: { message: BoardMessage | null; onClose: () => void; contact: SupportContact | null }) {
  const { t } = useTranslation();
  const me = useMe();
  const can = useCan();
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  useEffect(() => {
    setAsking(false);
    setQuestion("");
  }, [message?.id]);
  // client view is read-only: technicians see the button, disabled
  const canAsk = can("board.ticket");
  const ask = useMutation({
    mutationFn: () => api.post<{ id: number; number: string | null }>(`/board/${message!.id}/ticket`, { question }),
    onSuccess: (r) => {
      toast.success(r.number ? t("client.askSent", { number: r.number }) : t("client.askSentNoNumber"));
      onClose();
    },
    onError: (e) => {
      const code = e instanceof ApiError ? e.code : "";
      if (code === "board_not_linked") toast.error(contact?.phone ? t("client.askNotLinkedPhone", { phone: contact.phone }) : t("client.askNotLinked"));
      else if (code === "rate_limited") toast.error(t("client.askTooMany"));
      else toast.error(t("client.askFailed"));
    },
  });

  return (
    <Dialog open={Boolean(message)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(85dvh,46rem)] w-[calc(100vw-1.5rem)] flex-col gap-0 overflow-hidden rounded-3xl border-[color:var(--glass-border)] bg-background/90 p-0 shadow-[0_40px_120px_-40px_rgba(0,0,0,0.8)] backdrop-blur-2xl sm:max-w-2xl dark:bg-background/70"
      >
        <div className="client-ambient pointer-events-none absolute inset-0 -z-10" />
        <span className="pointer-events-none absolute inset-x-[18%] top-0 h-px bg-gradient-to-r from-transparent via-[color:var(--gold)]/80 to-transparent" />
        {message && (
          <>
            <header className="flex items-start gap-4 px-6 pb-4 pt-6 sm:px-8">
              <span
                className={cn(
                  "flex size-11 shrink-0 items-center justify-center rounded-2xl border",
                  message.pinned ? "border-[color:var(--gold)]/35 bg-[color:var(--gold)]/12 text-primary" : "border-[color:var(--glass-border)] bg-foreground/[0.04] text-primary",
                )}
              >
                {message.pinned ? <Pin className="size-5" /> : <Megaphone className="size-5" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary/80">{message.pinned ? t("client.boardPinned") : t("client.board")}</p>
                <DialogTitle className="mt-0.5 text-xl leading-snug sm:text-2xl">{message.title}</DialogTitle>
                <DialogDescription className="mt-1 flex items-center gap-1.5 text-xs">
                  <CalendarDays className="size-3.5" /> {dateTime(message.createdAt)} · {relativeTime(message.createdAt)}
                </DialogDescription>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="pane flex size-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:text-foreground"
                aria-label={t("common.close")}
              >
                <X className="size-4" />
              </button>
            </header>

            <AnimatePresence mode="wait" initial={false}>
              {asking ? (
                /* The question → a ticket for the company */
                <motion.form
                  key="ask"
                  initial={{ opacity: 0, x: 16 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 16 }}
                  transition={{ duration: 0.18 }}
                  className="flex min-h-0 flex-1 flex-col"
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault();
                    if (question.trim()) ask.mutate();
                  }}
                >
                  <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 pb-2 sm:px-8 scrollbar-thin">
                    <p className="text-sm text-muted-foreground">{t("client.askText", { title: message.title })}</p>
                    <Label htmlFor="ask-q">{t("client.askLabel")}</Label>
                    <div className="pane rounded-2xl transition-colors focus-within:border-[color:var(--gold)]/45">
                      <Textarea
                        id="ask-q"
                        autoFocus
                        required
                        rows={6}
                        maxLength={4000}
                        value={question}
                        onChange={(e) => setQuestion(e.target.value)}
                        placeholder={t("client.askPlaceholder")}
                        className="resize-none border-0 bg-transparent px-4 py-3 shadow-none focus-visible:ring-0 dark:bg-transparent"
                      />
                    </div>
                  </div>
                  <footer className="flex items-center gap-2 border-t border-[color:var(--glass-border)] bg-foreground/[0.02] px-6 py-4 sm:px-8">
                    <Button type="button" variant="ghost" className="rounded-xl" onClick={() => setAsking(false)}>
                      <ArrowLeft className="size-4" /> {t("client.boardBack")}
                    </Button>
                    <Button type="submit" disabled={ask.isPending || !question.trim()} className="glow-gold ml-auto rounded-xl bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105">
                      {ask.isPending ? <Loader2 className="size-4 animate-spin" /> : <TicketPlus className="size-4" />} {t("client.askSend")}
                    </Button>
                  </footer>
                </motion.form>
              ) : (
                /* The full message */
                <motion.div
                  key="read"
                  initial={{ opacity: 0, x: -16 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -16 }}
                  transition={{ duration: 0.18 }}
                  className="flex min-h-0 flex-1 flex-col"
                >
                  <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 sm:px-8 scrollbar-thin">
                    <div className="pane rounded-2xl p-5 sm:p-6">
                      <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground/90">{message.body}</p>
                    </div>
                  </div>
                  <footer className="flex flex-wrap items-center gap-3 border-t border-[color:var(--glass-border)] bg-foreground/[0.02] px-6 py-4 sm:px-8">
                    <p className="flex min-w-0 flex-1 items-start gap-2 text-xs text-muted-foreground">
                      <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
                      <span>{contact?.phone ? t("client.questionNotePhone", { phone: contact.phone }) : t("client.questionNote")}</span>
                    </p>
                    {canAsk || me.viewAs ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="ml-auto">
                            <Button
                              disabled={Boolean(me.viewAs)}
                              onClick={() => setAsking(true)}
                              className="glow-gold rounded-xl bg-grad-gold font-semibold text-[#1a1204] hover:brightness-105"
                            >
                              <TicketPlus className="size-4" /> {t("client.ask")}
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{me.viewAs ? t("client.readOnlyView") : t("client.askHint")}</TooltipContent>
                      </Tooltip>
                    ) : null}
                  </footer>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
