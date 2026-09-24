import { useCallback, useEffect, useMemo, useState } from "react";
import { Bell, CheckCheck, Filter, Pin } from "lucide-react";
import { useAuth } from "@/lib/auth";
import type { BoardMessageWithState, MessageReadStatus } from "@/lib/types";
import {
  loadMessagesWithState,
  markAllReadForUser,
  setMessageCustomLabel,
  setMessageReadStatus,
} from "@/lib/message-state";
import { emitMessageStatesChanged } from "@/hooks/use-board-notifications";
import { EmptyState } from "@/components/EmptyState";
import { MessageLabelControls } from "@/components/MessageLabelControls";
import { NotificationBanner } from "@/components/NotificationBanner";
import { useBoardNotificationsContext } from "@/context/BoardNotificationsContext";
import { useLocale } from "@/hooks/use-locale";
import { BlurFade } from "@/components/ui/blur-fade";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

type FilterMode = "all" | "unread" | "read" | "labeled";

export function ClientBoardPage() {
  const { user } = useAuth();
  const { t } = useLocale();
  const { permission, refreshPermission, refreshUnread } =
    useBoardNotificationsContext();
  const [messages, setMessages] = useState<BoardMessageWithState[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  const reload = useCallback(async () => {
    if (!user?.company_id) {
      setMessages([]);
      setLoading(false);
      return;
    }
    const rows = await loadMessagesWithState(user.company_id, user.id);
    setMessages(rows);
    setLoading(false);
    emitMessageStatesChanged();
    await refreshUnread();
  }, [user, refreshUnread]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      if (!cancelled) await reload();
    })();
    return () => {
      cancelled = true;
    };
  }, [reload]);

  // Poll for new admin posts while viewing the board
  useEffect(() => {
    if (!user?.company_id) return;
    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState === "hidden") return;
      const rows = await loadMessagesWithState(user.company_id!, user.id);
      if (cancelled) return;
      setMessages((prev) => {
        if (
          prev.length === rows.length &&
          prev.every((p, i) => p.id === rows[i]?.id && p.readStatus === rows[i]?.readStatus && p.customLabel === rows[i]?.customLabel)
        ) {
          return prev;
        }
        return rows;
      });
      await refreshUnread();
    };
    const id = window.setInterval(tick, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [user, refreshUnread]);

  const filtered = useMemo(() => {
    switch (filter) {
      case "unread":
        return messages.filter((m) => m.readStatus === "unread");
      case "read":
        return messages.filter((m) => m.readStatus === "read");
      case "labeled":
        return messages.filter((m) => Boolean(m.customLabel));
      default:
        return messages;
    }
  }, [messages, filter]);

  const unreadTotal = messages.filter((m) => m.readStatus === "unread").length;

  const updateLocal = (
    messageId: number,
    patch: Partial<Pick<BoardMessageWithState, "readStatus" | "customLabel">>,
  ) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, ...patch } : m)),
    );
  };

  const handleStatus = async (messageId: number, status: MessageReadStatus) => {
    if (!user) return;
    setBusyId(messageId);
    await setMessageReadStatus(messageId, user.id, status);
    updateLocal(messageId, { readStatus: status });
    emitMessageStatesChanged();
    await refreshUnread();
    setBusyId(null);
  };

  const handleLabel = async (messageId: number, label: string | null) => {
    if (!user) return;
    setBusyId(messageId);
    await setMessageCustomLabel(messageId, user.id, label);
    updateLocal(messageId, {
      customLabel: label,
      readStatus: "read",
    });
    emitMessageStatesChanged();
    await refreshUnread();
    setBusyId(null);
  };

  const handleMarkAllRead = async () => {
    if (!user?.company_id) return;
    setMarkingAll(true);
    await markAllReadForUser(user.company_id, user.id);
    setMessages((prev) => prev.map((m) => ({ ...m, readStatus: "read" as const })));
    emitMessageStatesChanged();
    await refreshUnread();
    setMarkingAll(false);
  };

  return (
    <div className="space-y-6">
      <BlurFade delay={0.05}>
        <NotificationBanner
          permission={permission}
          onPermissionChange={refreshPermission}
        />
      </BlurFade>

      <BlurFade delay={0.08}>
        <Card>
          <CardHeader className="gap-4 space-y-0">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Bell className="size-5 text-primary" />
                  {t("board.title")}
                </CardTitle>
                <CardDescription className="mt-1.5">
                  {t("board.desc")}
                </CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {unreadTotal > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={markingAll}
                    onClick={handleMarkAllRead}
                  >
                    <CheckCheck className="size-4" />
                    {t("board.markAllRead")}
                  </Button>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Filter className="size-4" />
                {t("board.show")}
              </div>
              <Select
                value={filter}
                onValueChange={(v) => setFilter(v as FilterMode)}
              >
                <SelectTrigger className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("board.all")}</SelectItem>
                  <SelectItem value="unread">{t("board.unreadOnly")}</SelectItem>
                  <SelectItem value="read">{t("board.readOnly")}</SelectItem>
                  <SelectItem value="labeled">{t("board.withLabel")}</SelectItem>
                </SelectContent>
              </Select>
              <Badge variant="outline" className="tabular-nums">
                {t("board.unreadCount", { n: unreadTotal })}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-28 animate-pulse rounded-xl bg-muted" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={<Bell className="size-5" />}
                title={
                  messages.length === 0
                    ? t("board.empty")
                    : t("board.noFilter")
                }
                description={
                  messages.length === 0
                    ? t("board.emptyDesc")
                    : t("board.noFilterDesc")
                }
              />
            ) : (
              <div className="space-y-4">
                {filtered.map((msg, index) => {
                  const isUnread = msg.readStatus === "unread";
                  return (
                    <BlurFade key={msg.id} delay={0.04 + index * 0.03}>
                      <article
                        className={cn(
                          "rounded-xl border p-5 transition-colors",
                          msg.pinned && "border-primary/40 bg-primary/5 shadow-sm",
                          isUnread && !msg.pinned && "border-primary/30 bg-primary/[0.06]",
                          !isUnread && !msg.pinned && "border-border bg-card/50",
                        )}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            {isUnread && (
                              <span
                                className="size-2 shrink-0 rounded-full bg-primary"
                                aria-hidden
                              />
                            )}
                            <h3
                              className={cn(
                                "text-lg tracking-tight",
                                isUnread ? "font-bold" : "font-semibold",
                              )}
                            >
                              {msg.title}
                            </h3>
                            {msg.pinned && (
                              <Badge className="bg-primary text-primary-foreground hover:bg-primary">
                                <Pin className="mr-1 size-3" />
                                {t("board.pinned")}
                              </Badge>
                            )}
                          </div>
                        </div>

                        <p
                          className={cn(
                            "mt-3 whitespace-pre-wrap text-sm leading-relaxed",
                            isUnread ? "text-foreground" : "text-foreground/90",
                          )}
                        >
                          {msg.body}
                        </p>

                        <div className="mt-4 flex flex-wrap gap-x-3 gap-y-1 border-t border-border/60 pt-3 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground/80">
                            {msg.author_name}
                          </span>
                          <span>AKAB</span>
                          <span>{formatDate(msg.created_at)}</span>
                        </div>

                        <div className="mt-3 border-t border-border/40 pt-3">
                          <MessageLabelControls
                            readStatus={msg.readStatus}
                            customLabel={msg.customLabel}
                            busy={busyId === msg.id}
                            onMarkRead={() => handleStatus(msg.id, "read")}
                            onMarkUnread={() => handleStatus(msg.id, "unread")}
                            onSetLabel={(label) => handleLabel(msg.id, label)}
                          />
                        </div>
                      </article>
                    </BlurFade>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </BlurFade>
    </div>
  );
}
