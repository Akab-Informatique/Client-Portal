import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { api } from "./api";

/**
 * Signing in with a notification on the phone — the phone's side. What this phone keeps (its device id and token) is in
 * localStorage; the private key of its passkey never leaves its secure hardware; the push subscription is in the browser.
 */
const KEY = "akab.push.device";
export type StoredDevice = { deviceId: string; token: string };

export function storedDevice(): StoredDevice | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as StoredDevice | null;
    return v?.deviceId && v?.token ? v : null;
  } catch {
    return null;
  }
}
const keepDevice = (d: StoredDevice | null) => {
  try {
    if (d) localStorage.setItem(KEY, JSON.stringify(d));
    else localStorage.removeItem(KEY);
  } catch {
    /* private window: this phone cannot keep its token */
  }
};
export const forgetDevice = () => keepDevice(null);

/** ok: this browser can; ios-install: an iPhone / iPad only gets notifications from the app added to the home screen; unsupported: no */
export function pushSupport(): "ok" | "ios-install" | "unsupported" {
  const push = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (push && window.PublicKeyCredential) return "ok";
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) return "ios-install";
  return "unsupported";
}

export async function registerWorker(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js");
  return navigator.serviceWorker.ready;
}

const toBytes = (b64url: string) => {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

async function subscribe(reg: ServiceWorkerRegistration, vapidPublicKey: string) {
  const existing = await reg.pushManager.getSubscription();
  // a subscription made with other keys is replaced
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(vapidPublicKey) as BufferSource }));
  return sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
}

/**
 * Make this phone one that approves sign-ins: notifications allowed, a passkey made (fingerprint / face / PIN), the push
 * subscription sent. The password is asked again by the server. Must be started by a tap (the browser asks for the permission).
 */
export async function enrollThisPhone(p: { password: string; label: string }): Promise<void> {
  const reg = await registerWorker();
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("notifications_denied");
  const { vapidPublicKey } = await api.get<{ vapidPublicKey: string }>("/auth/push/devices");
  const options = await api.post<PublicKeyCredentialCreationOptionsJSON>("/auth/push/enroll/options", { password: p.password });
  const response = await startRegistration({ optionsJSON: options });
  const subscription = await subscribe(reg, vapidPublicKey);
  const r = await api.post<{ id: string; token: string }>("/auth/push/enroll/verify", { label: p.label, subscription, response });
  keepDevice({ deviceId: r.id, token: r.token });
}

/** The server's list may hold a subscription this browser changed: send the current one (the phone proves itself with its token) */
export async function refreshSubscription(d: StoredDevice): Promise<void> {
  if (pushSupport() !== "ok" || Notification.permission !== "granted") return;
  const reg = await registerWorker();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  const last = localStorage.getItem(`${KEY}.endpoint`);
  if (last === json.endpoint) return;
  await api.post("/auth/push/device/refresh", { ...d, subscription: json });
  localStorage.setItem(`${KEY}.endpoint`, json.endpoint);
}

export type Pending =
  | { pending: false }
  | { pending: true; challengeId: string; numbers: number[]; where: { ip: string; agent: string; at: string; expiresAt: string }; options: PublicKeyCredentialRequestOptionsJSON };

export const loadPending = (d: StoredDevice, challengeId?: string) => api.post<Pending>("/auth/push/device/challenge", { ...d, ...(challengeId ? { challengeId } : {}) });

/** Approve: the person picked the number; the passkey (unlocked on the phone) signs the request */
export async function approve(d: StoredDevice, p: Extract<Pending, { pending: true }>, number: number): Promise<void> {
  const response = await startAuthentication({ optionsJSON: p.options });
  await api.post("/auth/push/device/respond", { ...d, challengeId: p.challengeId, number, response });
}

export const deny = (d: StoredDevice, challengeId: string) => api.post("/auth/push/device/deny", { ...d, challengeId });
