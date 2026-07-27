const PERMISSION_KEY = "soluti-notify-pref";
const LAST_SEEN_PREFIX = "soluti-board-last-seen";

export type NotifyPreference = "default" | "granted" | "denied" | "unsupported";

export function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

/**
 * Effective preference for the app:
 * - unsupported / browser denied → denied/unsupported
 * - in-app mute (localStorage denied) → denied even if browser granted
 * - browser granted and not muted → granted
 * - otherwise default (prompt)
 */
export function getNotifyPreference(): NotifyPreference {
  if (!notificationsSupported()) return "unsupported";

  const browser = Notification.permission;
  if (browser === "denied") return "denied";

  const stored = localStorage.getItem(PERMISSION_KEY);
  if (stored === "denied") return "denied"; // in-app mute

  if (browser === "granted") return "granted";
  return "default";
}

export async function requestNotifyPermission(): Promise<NotifyPreference> {
  if (!notificationsSupported()) return "unsupported";
  try {
    // Clear in-app mute before asking
    localStorage.removeItem(PERMISSION_KEY);
    const result = await Notification.requestPermission();
    if (result === "granted") {
      localStorage.setItem(PERMISSION_KEY, "granted");
    } else if (result === "denied") {
      localStorage.setItem(PERMISSION_KEY, "denied");
    }
    return getNotifyPreference();
  } catch {
    return "denied";
  }
}

export function setNotifyOptOut() {
  localStorage.setItem(PERMISSION_KEY, "denied");
}

export function clearNotifyOptOut() {
  localStorage.removeItem(PERMISSION_KEY);
}

export function lastSeenKey(userId: number, companyId: number) {
  return `${LAST_SEEN_PREFIX}:${userId}:${companyId}`;
}

export function getLastSeenMessageId(userId: number, companyId: number): number {
  const raw = localStorage.getItem(lastSeenKey(userId, companyId));
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}

export function setLastSeenMessageId(
  userId: number,
  companyId: number,
  messageId: number,
) {
  localStorage.setItem(lastSeenKey(userId, companyId), String(messageId));
}

export interface BoardNotifyPayload {
  id: number;
  title: string;
  body: string;
  authorName: string;
}

export function showBoardNotification(msg: BoardNotifyPayload) {
  if (!notificationsSupported() || Notification.permission !== "granted") {
    return false;
  }
  // Respect in-app mute
  if (localStorage.getItem(PERMISSION_KEY) === "denied") {
    return false;
  }

  try {
    const n = new Notification(`AKAB · ${msg.title}`, {
      body: `${msg.authorName}: ${msg.body.slice(0, 160)}${msg.body.length > 160 ? "…" : ""}`,
      tag: `board-msg-${msg.id}`,
      icon: "/notify-icon.svg",
      badge: "/notify-icon.svg",
      requireInteraction: false,
    });

    n.onclick = () => {
      window.focus();
      if (!window.location.pathname.startsWith("/client/board")) {
        window.location.assign("/client/board");
      }
      n.close();
    };

    window.setTimeout(() => n.close(), 12_000);
    return true;
  } catch {
    return false;
  }
}
