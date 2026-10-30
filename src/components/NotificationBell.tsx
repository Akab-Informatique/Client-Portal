import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Bell, BellOff, BellRing, CalendarClock, CheckCheck, MapPin, Megaphone, MessageSquareReply, Paperclip, ShieldAlert, Siren, Star, Timer, type LucideIcon, MessageSquareText, Swords, Wrench, Workflow } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type Notification = {
  id: string;
  type: string;
  data: Record<string, string>;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};
type Feed = { items: Notification[]; unread: number };

/** Only in-app paths ("/…", never "//host" or "javascript:"). */
const safeLink = (l: string | null) => (l && l.startsWith("/") && !l.startsWith("//") ? l : null);

function useView(n: Notification): { icon: LucideIcon; title: string; body: string; tone: "gold" | "alert" } {
  const { t } = useTranslation();
  switch (n.type) {
    case "message.new":
      return { icon: Megaphone, title: t("notifications.messageNew"), body: n.data.title ?? "", tone: "gold" };
    case "user.locked":
      return { icon: ShieldAlert, title: t("notifications.userLocked"), body: `${n.data.name ?? ""} · ${n.data.email ?? ""}`, tone: "alert" };
    case "sms.received":
      return { icon: MessageSquareText, title: t("notifications.smsReceived", { from: n.data.from ?? "" }), body: [n.data.company, n.data.preview].filter(Boolean).join(" · "), tone: "gold" };
    case "calendar.reminder":
      return {
        icon: n.data.kind === "onsite" ? MapPin : CalendarClock,
        title: t(n.data.kind === "onsite" ? "notifications.reminderOnsite" : "notifications.reminder", { minutes: n.data.minutes ?? "" }),
        body: [n.data.number, n.data.title, n.data.company].filter(Boolean).join(" · "),
        tone: "gold",
      };
    case "ticket.pinned":
      return {
        icon: Star,
        title: t(n.data.horizon === "day" ? "notifications.pinnedDay" : "notifications.pinnedWeek", { by: n.data.by ?? "" }),
        body: `${n.data.number ?? ""} · ${n.data.title ?? ""}${n.data.note ? ` — ${n.data.note}` : ""}`,
        tone: "gold",
      };
    case "ticket.client": {
      const k = n.data.kind === "escalation" ? "Escalation" : n.data.kind === "file" ? "File" : "Comment";
      return {
        icon: k === "Escalation" ? Siren : k === "File" ? Paperclip : MessageSquareReply,
        title: t(`notifications.client${k}`, { from: n.data.from ?? "" }),
        body: [`${n.data.number ?? ""} · ${n.data.title ?? ""}`, n.data.company, n.data.preview].filter(Boolean).join(" — "),
        tone: k === "Escalation" ? "alert" : "gold",
      };
    }
    case "ticket.work":
      return {
        icon: Wrench,
        title: t("notifications.workDone", { from: n.data.from ?? "" }),
        body: [`${n.data.number ?? ""} · ${n.data.title ?? ""}`, n.data.preview].filter(Boolean).join(" — "),
        tone: "gold",
      };
    case "ticket.notify":
      return {
        icon: BellRing,
        title: t("notifications.ticketNotify", { from: n.data.from ?? "" }),
        body: [`${n.data.number ?? ""} · ${n.data.title ?? ""}`, n.data.company, n.data.message].filter(Boolean).join(" — "),
        tone: "gold",
      };
    case "security.alert":
      return {
        icon: ShieldAlert,
        title: t(n.data.kind === "signin_denied" ? "notifications.signinDenied" : "notifications.deviceAdded"),
        body: n.data.kind === "signin_denied" ? [n.data.agent, n.data.ip].filter(Boolean).join(" · ") : String(n.data.label ?? ""),
        tone: "alert",
      };
    case "pipeline.assigned":
      return { icon: Workflow, title: t(n.data.comment ? "notifications.pipelineComment" : "notifications.pipelineAssigned", { by: n.data.by ?? "" }), body: String(n.data.title ?? ""), tone: "gold" };
    case "breakroom.complots":
      return { icon: Swords, title: t("notifications.complotsInvite", { from: n.data.from ?? "" }), body: t("notifications.complotsInviteBody"), tone: "gold" };
    case "breakroom.invite":
      return { icon: Swords, title: t("notifications.breakroomInvite", { from: n.data.from ?? "" }), body: t("notifications.breakroomInviteBody"), tone: "gold" };
    case "hr.negative":
      return { icon: ShieldAlert, title: t("notifications.hrNegative", { name: n.data.name ?? "" }), body: t(`hr.account.${n.data.account ?? "bank"}`), tone: "alert" };
    case "timer.pending":
      return { icon: Timer, title: t("notifications.timerPending"), body: t("notifications.timerPendingBody", { number: n.data.number ?? "", minutes: n.data.minutes ?? "", title: n.data.title ?? "" }), tone: "alert" };
    default:
      return { icon: Bell, title: n.type, body: "", tone: "gold" };
  }
}

/** Bell with unread badge; the preview list opens the related place on click. */
export function NotificationBell() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<Feed>("/notifications"),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSettled: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const markAll = useMutation({
    mutationFn: () => api.post("/notifications/read-all"),
    onSettled: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const unread = data?.unread ?? 0;

  function openItem(n: Notification) {
    if (!n.readAt) markRead.mutate(n.id);
    setOpen(false);
    const link = safeLink(n.link);
    if (link) navigate(link);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) void qc.invalidateQueries({ queryKey: ["notifications"] });
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative flex size-9 items-center justify-center rounded-full border border-transparent text-muted-foreground transition-colors hover:border-border hover:bg-card hover:text-foreground data-[state=open]:border-[color:var(--gold)]/40 data-[state=open]:bg-card data-[state=open]:text-foreground"
          aria-label={unread ? t("notifications.titleCount", { count: unread }) : t("notifications.title")}
        >
          <Bell className={cn("size-[18px]", unread > 0 && "text-foreground")} />
          <AnimatePresence>
            {unread > 0 && (
              <motion.span
                key={unread}
                initial={{ scale: 0.4, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.4, opacity: 0 }}
                className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-grad-gold px-1 text-[10px] font-bold text-[#1a1204] ring-2 ring-background"
              >
                {unread > 99 ? "99+" : unread}
              </motion.span>
            )}
          </AnimatePresence>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="font-display text-sm font-semibold">{t("notifications.title")}</p>
          {unread > 0 && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => markAll.mutate()}>
              <CheckCheck className="size-3.5" /> {t("notifications.markAll")}
            </Button>
          )}
        </div>
        <ul className="max-h-[420px] overflow-y-auto p-1.5 scrollbar-thin">
          {!data?.items.length && (
            <li className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
              <BellOff className="size-6 opacity-60" />
              {t("notifications.empty")}
            </li>
          )}
          {data?.items.map((n) => (
            <Item key={n.id} n={n} onOpen={() => openItem(n)} />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function Item({ n, onOpen }: { n: Notification; onOpen: () => void }) {
  const v = useView(n);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cn("group flex w-full items-start gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-accent", !n.readAt && "bg-[color:var(--gold)]/[0.06]")}
      >
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
            v.tone === "alert" ? "bg-destructive/15 text-destructive" : n.readAt ? "bg-muted text-muted-foreground" : "bg-grad-gold text-[#1a1204]",
          )}
        >
          <v.icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className={cn("truncate text-sm", n.readAt ? "text-muted-foreground" : "font-semibold")}>{v.title}</span>
            {!n.readAt && <span className="size-1.5 shrink-0 rounded-full bg-[color:var(--gold)]" />}
          </span>
          {v.body && <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{v.body}</span>}
          <span className="mt-1 block text-[11px] text-muted-foreground/70">{relativeTime(n.createdAt)}</span>
        </span>
      </button>
    </li>
  );
}
