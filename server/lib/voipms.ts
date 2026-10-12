import { randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { seal, unseal } from "./crypto.ts";

/**
 * VoIP.ms text messages (server side only).
 *
 * Sending: the REST API (sendSMS) with the account email and its API
 * password (VoIP.ms › Main menu › SOAP and REST/JSON API: enable it and allow
 * the server's IP address). Receiving: on the DID, "SMS URL Callback" points
 * to the portal with a secret token; VoIP.ms calls it for each text.
 * The API password and the token are sealed with APP_SECRET.
 */
export const VOIPMS_PROVIDER = "voipms";
const API = "https://voip.ms/api/v1/rest.php";
const TIMEOUT_MS = 15_000;
/** VoIP.ms refuses texts longer than this: longer messages go in several parts. */
export const SMS_MAX = 160;

export type SmsSettings = {
  enabled: boolean;
  username: string;
  password: string | null;
  /** Our VoIP.ms number (10 digits) */
  did: string;
  token: string | null;
  /** No technician reply after this many minutes: the conversation becomes a ticket */
  autoTicketMinutes: number;
  autoReply: string;
  ticketOpened: string;
  /** When it became a ticket because nobody answered in time */
  ticketTimeout: string;
  /** Unknown numbers: the client used for their tickets */
  defaultCompanyId: number | null;
  defaultCompanyName: string | null;
  queue: string | null;
  priority: string | null;
  lastTest?: { ok: boolean; at: string; error?: string };
};

export const DEFAULT_AUTO_REPLY =
  "AKAB Informatique : message bien reçu. Répondez 1 pour en faire un billet maintenant, ou un technicien vous répondra sous peu. Sans réponse d'ici {delay}, un billet sera ouvert automatiquement.";
export const DEFAULT_TICKET_TIMEOUT =
  "AKAB Informatique : aucun technicien n'a pu prendre votre message à temps, nous avons donc ouvert le billet {number}. Nous vous contacterons dès que possible.";
export const DEFAULT_TICKET_OPENED = "AKAB Informatique : votre demande est maintenant le billet {number}. Un technicien vous contactera. Merci!";

export class SmsError extends Error {
  constructor(
    public code: "not_configured" | "disabled" | "network" | "api",
    public detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** North American number, 10 digits ("+1 (450) 555-0199" → "4505550199"); null if it is not one. */
export function normalizePhone(v: string | null | undefined): string | null {
  const d = (v ?? "").replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return /^[2-9]\d{9}$/.test(ten) ? ten : null;
}
/** "4 h", "1 h 30", "45 min" (for the messages to the client). */
export function formatDelay(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h${m ? ` ${String(m).padStart(2, "0")}` : ""}` : `${m} min`;
}
export const formatPhone = (p: string) => `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}`;

export async function smsSettings(): Promise<SmsSettings> {
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, VOIPMS_PROVIDER));
  const c = (row?.config ?? {}) as Partial<SmsSettings>;
  let secrets: { password?: string; token?: string } = {};
  try {
    secrets = JSON.parse(unseal(row?.secret) ?? "{}") as typeof secrets;
  } catch {
    secrets = {};
  }
  return {
    enabled: row?.enabled ?? false,
    username: c.username ?? "",
    password: secrets.password ?? null,
    did: c.did ?? "",
    token: secrets.token ?? null,
    autoTicketMinutes: c.autoTicketMinutes ?? 240,
    autoReply: c.autoReply ?? DEFAULT_AUTO_REPLY,
    ticketOpened: c.ticketOpened ?? DEFAULT_TICKET_OPENED,
    ticketTimeout: c.ticketTimeout ?? DEFAULT_TICKET_TIMEOUT,
    defaultCompanyId: c.defaultCompanyId ?? null,
    defaultCompanyName: c.defaultCompanyName ?? null,
    queue: c.queue ?? null,
    priority: c.priority ?? null,
    lastTest: c.lastTest,
  };
}

export async function saveSmsSettings(actorId: string, p: Partial<Omit<SmsSettings, "token">> & { newToken?: boolean }) {
  const cur = await smsSettings();
  const next = { ...cur, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) } as SmsSettings;
  const token = p.newToken || !cur.token ? randomBytes(24).toString("base64url") : cur.token;
  const { enabled, password, token: _t, ...config } = next;
  const values = {
    enabled,
    config: config as unknown as Record<string, unknown>,
    secret: seal(JSON.stringify({ password: password ?? undefined, token })),
    updatedBy: actorId,
    updatedAt: new Date(),
  };
  await db()
    .insert(schema.integrations)
    .values({ provider: VOIPMS_PROVIDER, ...values })
    .onConflictDoUpdate({ target: schema.integrations.provider, set: values });
}

/** The callback token, compared in constant time. */
export async function tokenMatches(given: string | undefined): Promise<boolean> {
  const s = await smsSettings();
  if (!s.token || !given) return false;
  const a = Buffer.from(s.token);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function smsReady(): Promise<boolean> {
  const s = await smsSettings();
  return s.enabled && Boolean(s.username && s.password && normalizePhone(s.did));
}

async function call<T extends { status: string }>(s: Pick<SmsSettings, "username" | "password">, method: string, params: Record<string, string>): Promise<T> {
  if (!s.username || !s.password) throw new SmsError("not_configured");
  const q = new URLSearchParams({ api_username: s.username, api_password: s.password, method, ...params });
  let res: Response;
  try {
    // VoIP.ms REST only takes GET (a POST is read as SOAP: HTTP 500). The
    // address carries the password: server to server over HTTPS, never logged.
    res = await fetch(`${API}?${q}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new SmsError("network", (e as Error).name);
  }
  const j = (await res.json().catch(() => null)) as T | null;
  if (!res.ok || !j) throw new SmsError("api", `HTTP ${res.status}`);
  if (j.status !== "success") throw new SmsError("api", j.status);
  return j;
}

/** Test: the account answers (balance). */
export async function testVoipms(s: Pick<SmsSettings, "username" | "password">) {
  await call(s, "getBalance", {});
}

/** Split a long text into parts VoIP.ms accepts (at spaces when possible). */
export function splitSms(text: string): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > SMS_MAX) {
    let cut = rest.lastIndexOf(" ", SMS_MAX);
    if (cut < SMS_MAX * 0.6) cut = SMS_MAX;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Send a text from our number (several parts if long). */
export async function sendSms(dst: string, text: string): Promise<void> {
  const s = await smsSettings();
  if (!s.enabled) throw new SmsError("disabled");
  const did = normalizePhone(s.did);
  const to = normalizePhone(dst);
  if (!did || !to) throw new SmsError("not_configured");
  for (const part of splitSms(text)) await call(s, "sendSMS", { did, dst: to, message: part });
}
