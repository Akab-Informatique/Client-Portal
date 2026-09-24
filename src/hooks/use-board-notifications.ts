import { useCallback, useEffect, useRef, useState } from "react";
import { and, desc, eq, gt } from "drizzle-orm";
import { db, dbReady, schema } from "@/db";
import { useAuth } from "@/lib/auth";
import { countUnreadForUser } from "@/lib/message-state";
import {
  getLastSeenMessageId,
  getNotifyPreference,
  setLastSeenMessageId,
  showBoardNotification,
  type NotifyPreference,
} from "@/lib/notifications";

// New posts are rare; a tab coming back into view polls immediately anyway.
const POLL_MS = 30000;

/**
 * While a client user is logged in, poll their company board and fire
 * desktop notifications for newly arrived messages (when permission is granted).
 * Unread badge uses per-user message_user_states (default unread).
 */
export function useBoardNotifications() {
  const { user } = useAuth();
  const [permission, setPermission] = useState<NotifyPreference>(() =>
    getNotifyPreference(),
  );
  const [unreadCount, setUnreadCount] = useState(0);
  const [latestToast, setLatestToast] = useState<{
    id: number;
    title: string;
    body: string;
  } | null>(null);
  const baselinedRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);

  const refreshPermission = useCallback(() => {
    setPermission(getNotifyPreference());
  }, []);

  const dismissToast = useCallback(() => {
    setLatestToast(null);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
  }, []);

  const recomputeUnread = useCallback(async () => {
    if (!user?.company_id) {
      setUnreadCount(0);
      return;
    }
    const n = await countUnreadForUser(user.company_id, user.id);
    setUnreadCount(n);
  }, [user]);

  /** Kept for compatibility — no longer auto-marks all read on board open. */
  const markBoardViewed = useCallback(async () => {
    if (!user?.company_id) return;
    await dbReady;
    const rows = await db
      .select({ id: schema.board_messages.id })
      .from(schema.board_messages)
      .where(eq(schema.board_messages.company_id, user.company_id))
      .orderBy(desc(schema.board_messages.id))
      .limit(1);
    const maxId = rows[0]?.id ?? 0;
    // Only advances desktop-notify baseline so we don't re-fire toasts
    setLastSeenMessageId(user.id, user.company_id, maxId);
    dismissToast();
    await recomputeUnread();
  }, [user, dismissToast, recomputeUnread]);

  useEffect(() => {
    if (!user || user.role !== "client" || !user.company_id) {
      setUnreadCount(0);
      baselinedRef.current = false;
      return;
    }

    const companyId = user.company_id;
    const userId = user.id;
    let cancelled = false;

    const poll = async () => {
      // Background tabs don't poll; onVis catches up when the tab is shown
      if (baselinedRef.current && document.visibilityState === "hidden") return;
      try {
        await dbReady;

        // First poll after login: baseline "last notified" to current max so
        // historical messages don't spam desktop notifications.
        if (!baselinedRef.current) {
          const latest = await db
            .select({ id: schema.board_messages.id })
            .from(schema.board_messages)
            .where(eq(schema.board_messages.company_id, companyId))
            .orderBy(desc(schema.board_messages.id))
            .limit(1);
          const maxId = latest[0]?.id ?? 0;
          const lastNotified = getLastSeenMessageId(userId, companyId);
          if (lastNotified === 0 && maxId > 0) {
            setLastSeenMessageId(userId, companyId, maxId);
          }
          baselinedRef.current = true;
          if (!cancelled) await recomputeUnread();
          return;
        }

        const lastNotified = getLastSeenMessageId(userId, companyId);
        // Only messages newer than the last one we notified about
        const rows = await db
          .select()
          .from(schema.board_messages)
          .where(
            and(
              eq(schema.board_messages.company_id, companyId),
              gt(schema.board_messages.id, lastNotified),
            ),
          );

        const fresh = (rows as Array<{ id: number; title: string; body: string; author_name: string }>)
          .filter((m) => m.id > lastNotified)
          .sort((a, b) => a.id - b.id);

        if (fresh.length > 0 && !cancelled) {
          const pref = getNotifyPreference();
          for (const msg of fresh) {
            if (pref === "granted") {
              showBoardNotification({
                id: msg.id,
                title: msg.title,
                body: msg.body,
                authorName: msg.author_name,
              });
            }
          }

          const newest = fresh[fresh.length - 1];
          setLatestToast({
            id: newest.id,
            title: newest.title,
            body: newest.body,
          });
          if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
          toastTimerRef.current = window.setTimeout(() => {
            setLatestToast(null);
          }, 8000);

          setLastSeenMessageId(
            userId,
            companyId,
            Math.max(...fresh.map((m) => m.id)),
          );
        }

        if (!cancelled) await recomputeUnread();
      } catch {
        // ignore transient poll errors
      }
    };

    poll();
    const interval = window.setInterval(poll, POLL_MS);

    const onVis = () => {
      setPermission(getNotifyPreference());
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onVis);

    const onStatesChanged = () => {
      void recomputeUnread();
    };
    window.addEventListener("soluti-message-states-changed", onStatesChanged);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("soluti-message-states-changed", onStatesChanged);
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, [user, recomputeUnread]);

  return {
    permission,
    refreshPermission,
    unreadCount,
    latestToast,
    dismissToast,
    markBoardViewed,
    refreshUnread: recomputeUnread,
  };
}

export function emitMessageStatesChanged() {
  window.dispatchEvent(new Event("soluti-message-states-changed"));
}
