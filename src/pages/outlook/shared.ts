import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { currentLocale } from "@/i18n";

export type MailAccount = { id: string; address: string; displayName: string | null; via?: "user" | "app"; folderPrefs?: { pinned: { id: string; name: string }[]; hidden: string[] } | null };
export type OutlookStatus = {
  ready: boolean;
  signedIn: { email: string; needsReconnect: boolean } | null;
  accounts: MailAccount[];
  ownAddresses: string[];
  canLinkAny: boolean;
  canSend: boolean;
  maxAttachmentBytes: number;
  /** The technician's signature (sanitized HTML; "" = none) */
  signature: string;
};
export type MailAddress = { name: string | null; address: string };
export type MailFolder = { id: string; name: string; unread: number; total: number; childCount: number; wellKnown: string | null };
export type MailListItem = {
  id: string;
  subject: string;
  from: MailAddress | null;
  receivedAt: string;
  preview: string;
  isRead: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  importance: string;
  lastVerb: "reply" | "replyAll" | "forward" | null;
  lastVerbAt: string | null;
};
export type MailPage = { items: MailListItem[]; next: string | null };
export type MailAttachment = { id: string; name: string; contentType: string; size: number; isInline: boolean };
export type MailMessage = MailListItem & {
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  replyTo: MailAddress[];
  html: string;
  attachments: MailAttachment[];
  folderId: string;
};
export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

export const KEY = ["outlook"] as const;
export const statusKey = [...KEY, "status"] as const;
export const foldersKey = (acc: string, parent?: string) => [...KEY, "folders", acc, parent ?? "root"] as const;
export const messagesKey = (acc: string, folder: string, q: string) => [...KEY, "messages", acc, folder, q] as const;
export const messageKey = (acc: string, id: string) => [...KEY, "message", acc, id] as const;

export const base = (acc: string) => `/outlook/accounts/${encodeURIComponent(acc)}`;

/** Update one message in every cached list of this mailbox (read / flag state). */
export function patchListItem(qc: QueryClient, acc: string, id: string, patch: Partial<MailListItem>) {
  qc.setQueriesData<InfiniteData<MailPage>>({ queryKey: [...KEY, "messages", acc] }, (d) =>
    d ? { ...d, pages: d.pages.map((p) => ({ ...p, items: p.items.map((m) => (m.id === id ? { ...m, ...patch } : m)) })) } : d,
  );
}

/** Drop a message from the cached lists (moved or deleted). */
export function removeListItem(qc: QueryClient, acc: string, id: string) {
  qc.setQueriesData<InfiniteData<MailPage>>({ queryKey: [...KEY, "messages", acc] }, (d) =>
    d ? { ...d, pages: d.pages.map((p) => ({ ...p, items: p.items.filter((m) => m.id !== id) })) } : d,
  );
}

export function outlookErrorText(t: (k: string, o?: Record<string, unknown>) => string, e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code.startsWith("outlook_")) {
      const k = `outlook.errors.${e.code.slice("outlook_".length)}`;
      const text = t(k);
      if (text !== k) return text;
    }
    if (e.code === "rate_limited") return t("login.rateLimited");
  }
  return t("common.error");
}

export const who = (a: MailAddress | null | undefined) => (a ? a.name || a.address : "—");

export function bytes(n: number): string {
  const [b, k, m] = currentLocale() === "en" ? ["B", "KB", "MB"] : ["o", "Ko", "Mo"];
  if (n < 1024) return `${n} ${b}`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} ${k}`;
  return `${(n / 1024 / 1024).toFixed(1)} ${m}`;
}

/** "Marie <marie@x.ca>, bob@y.ca" → addresses; null if one is invalid. */
export function parseAddresses(s: string): { ok: string[]; bad: string | null } {
  const parts = s
    .split(/[,;\n]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.match(/<([^>]+)>/)?.[1]?.trim() ?? p);
  const bad = parts.find((p) => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(p)) ?? null;
  return { ok: [...new Set(parts.map((p) => p.toLowerCase()))], bad };
}

/** File → base64 (without the data: prefix). */
export function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}
