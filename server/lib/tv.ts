import crypto from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db, schema } from "../db/index.ts";
import { seal, unseal } from "./crypto.ts";

/**
 * Dashboard TV: the AI bots shown on the lobby screen. The screen is PUBLIC, so only bot names and APPROVED generic
 * task labels (LABELS below) ever leave the server: a free-text label is never stored, it becomes a generic one.
 * Secrets (one report key per bot, one display key) are random, kept sealed, compared in constant time, never logged.
 */

export const TV_PROVIDER = "tv";
export const TV_STATES = ["idle", "working", "needs_human"] as const;
export type TvState = (typeof TV_STATES)[number];
export const MAX_BOTS = 12;
export const GENERIC_LABELS = { working: "Tâche en cours", needs_human: "Besoin d'aide" } as const;
export const STALE_MS = 30 * 60_000;
export const NEEDS_HUMAN_HOLD_MS = 4 * 60 * 60_000;

// ── Approved public labels: generic French wording, no client or internal system names ──
const BASE_LABELS = [
  "Tri des courriels",
  "Mise à jour des postes",
  "Sauvegarde des données",
  "Surveillance réseau",
  "Rédaction de rapport",
  "Analyse de sécurité",
  "Support technique",
  "Planification",
  "Vérification des factures",
  "Classement des documents",
  "Synchronisation des calendriers",
  "Contrôle qualité",
];

/** Suggested labels per bot (key = labelKey of the bot's name). Any bot may send any approved label. */
export const LABELS_BY_BOT: Readonly<Record<string, readonly string[]>> = {
  clicky: ["Réponse aux questions", "Recherche d'information", "Résumé de réunion", "Organisation des tâches"],
  finance: ["Rapprochement bancaire", "Vérification des factures", "Suivi des comptes clients", "Préparation de la paie", "Rapport financier"],
  adjointe: ["Gestion de l'agenda", "Tri des courriels", "Préparation de réunion", "Classement des documents", "Suivi des échéances"],
  "portail akab": ["Consultation des billets ouverts", "Suivi des billets", "Mise à jour du portail", "Support technique"],
  boss: ["Supervision de l'équipe", "Revue des priorités", "Répartition des tâches", "Contrôle qualité"],
  facebook: ["Vérification des publicités Meta", "Publication Marketplace", "Mise à jour des annonces", "Réponse aux messages"],
  legale: ["Révision de contrat", "Vérification de conformité", "Rédaction de document légal", "Suivi des échéances légales"],
  videaste: ["Édition d'une vidéo", "Montage vidéo", "Mixage audio", "Rendu de la vidéo"],
  "l'artiste": ["Création graphique", "Retouche d'images", "Cadrage de la vidéo", "Choix des accessoires"],
};

/** Base labels first, then the per-bot ones in bot order, without duplicates. The index in this list is the report link's label number. */
export const LABELS: readonly string[] = [...new Set([...BASE_LABELS, ...Object.values(LABELS_BY_BOT).flat()])];

/** Comparison key: accents removed, typographic apostrophes made plain, lowercase, single spaces. */
export function labelKey(text: string): string {
  return String(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’´`]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const LABEL_INDEX = new Map(LABELS.map((l) => [labelKey(l), l]));

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Letters (accents too), digits, space, hyphen, apostrophe; 1 to 12 characters.
const NAME_RE = /^[\p{L}\p{N} '-]{1,12}$/u;

/** The trimmed name, or null when it is not an acceptable bot name (a typographic apostrophe becomes '; at most one). */
export function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/’/g, "'");
  if ((name.match(/'/g) || []).length > 1) return null;
  if (!NAME_RE.test(name) || !slugify(name)) return null;
  return name;
}

/** Report-link wording for a state: working|travail, idle|repos, needs_human|aide|humain|help. */
const STATE_ALIASES: Record<string, TvState> = {
  working: "working",
  travail: "working",
  idle: "idle",
  repos: "idle",
  needs_human: "needs_human",
  aide: "needs_human",
  humain: "needs_human",
  help: "needs_human",
};
export function parseState(value: unknown): TvState | null {
  if (typeof value !== "string") return null;
  const k = value.toLowerCase();
  return Object.hasOwn(STATE_ALIASES, k) ? STATE_ALIASES[k] : null;
}

/** An approved label (exact match ignoring case and accents) or an index into LABELS; anything else becomes the generic text. Idle: none. */
export function resolveLabel(value: unknown, state: TvState): string | null {
  if (state === "idle") return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < LABELS.length) return LABELS[value];
  if (typeof value === "string") {
    const text = value.trim();
    if (/^\d{1,2}$/.test(text) && Number(text) < LABELS.length) return LABELS[Number(text)];
    const match = LABEL_INDEX.get(labelKey(text));
    if (match) return match;
  }
  return GENERIC_LABELS[state];
}

/** What the screen shows: a working bot with no report for 30 min is idle; needs_human holds for 4 h. */
export function effectiveStatus(row: { state: string; label: string | null; since: Date; updatedAt: Date }, now = Date.now()) {
  const age = now - row.updatedAt.getTime();
  const state = (TV_STATES as readonly string[]).includes(row.state) ? (row.state as TvState) : "idle";
  const expired = state !== "idle" && age >= STALE_MS && !(state === "needs_human" && age < NEEDS_HUMAN_HOLD_MS);
  if (expired) return { state: "idle" as TvState, label: null as string | null, since: new Date(row.updatedAt.getTime() + STALE_MS) };
  // a label that is not on the approved list can never reach the screen
  const label = state === "idle" ? null : row.label && LABEL_INDEX.has(labelKey(row.label)) ? row.label : GENERIC_LABELS[state];
  return { state, label, since: row.since };
}

// ── Secrets ──
const digest = (v: string) => crypto.createHash("sha256").update(v, "utf8").digest();
export const newKey = () => crypto.randomBytes(24).toString("base64url");

/** Constant-time comparison (both sides hashed to equal length). */
export function sameSecret(a: string, b: string): boolean {
  return crypto.timingSafeEqual(digest(a), digest(b));
}

// ── First use: the 9 starting bots and the display key ──
const SEED_BOTS = ["Clicky", "Finance", "Adjointe", "Portail AKAB", "Boss", "Facebook", "Légale", "Vidéaste", "L'artiste"];

let seeding: Promise<void> | null = null;
export function ensureTv(): Promise<void> {
  seeding ??= (async () => {
    // the settings row is the "already set up" mark: deleting every bot later does not bring the 9 back
    const claimed = await db()
      .insert(schema.integrations)
      .values({ provider: TV_PROVIDER, enabled: true, config: {}, secret: seal(JSON.stringify({ displayKey: newKey() })) })
      .onConflictDoNothing()
      .returning({ provider: schema.integrations.provider });
    if (claimed.length) {
      for (const [i, name] of SEED_BOTS.entries()) await insertBot(name, i);
    }
  })().catch((e) => {
    seeding = null;
    throw e;
  });
  return seeding;
}


async function insertBot(name: string, sort: number) {
  const d = db();
  const key = newKey();
  let id = slugify(name);
  if ((await d.select({ id: schema.tvBots.id }).from(schema.tvBots).where(eq(schema.tvBots.id, id))).length) id = `${id}-${crypto.randomBytes(3).toString("hex")}`;
  await d.insert(schema.tvBots).values({ id, name, nameKey: slugify(name), keyHash: digest(key).toString("hex"), keySealed: seal(key), sort });
  await d.insert(schema.tvStatus).values({ botId: id });
  return id;
}

export async function getDisplayKey(): Promise<string> {
  await ensureTv();
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, TV_PROVIDER));
  const key = (JSON.parse(unseal(row?.secret) ?? "{}") as { displayKey?: string }).displayKey;
  return key ?? rotateDisplayKey();
}

export async function rotateDisplayKey(): Promise<string> {
  await ensureTv();
  const key = newKey();
  await db()
    .update(schema.integrations)
    .set({ secret: seal(JSON.stringify({ displayKey: key })), updatedAt: new Date() })
    .where(eq(schema.integrations.provider, TV_PROVIDER));
  return key;
}

export async function displayKeyMatches(probe: string): Promise<boolean> {
  return sameSecret(probe, await getDisplayKey());
}

// ── Bots ──
async function rows() {
  await ensureTv();
  return db()
    .select({ bot: schema.tvBots, status: schema.tvStatus })
    .from(schema.tvBots)
    .leftJoin(schema.tvStatus, eq(schema.tvStatus.botId, schema.tvBots.id))
    .orderBy(asc(schema.tvBots.sort), asc(schema.tvBots.createdAt), asc(schema.tvBots.id));
}

const statusOf = (s: { state: string; label: string | null; since: Date; updatedAt: Date } | null, now: number) =>
  effectiveStatus(s ?? { state: "idle", label: null, since: new Date(now), updatedAt: new Date(now) }, now);

/** The public body: names and approved labels only, never a key. */
export async function publicState() {
  const now = Date.now();
  const list = (await rows()).map(({ bot, status }) => {
    const e = statusOf(status, now);
    return { id: bot.id, name: bot.name, state: e.state, label: e.label, since: e.since.toISOString() };
  });
  return { updatedAt: new Date(now).toISOString(), source: "portal" as const, stale: false, bots: list };
}

/** For the managers: same as the public list, plus each bot's secret report key and its position. */
export async function managedBots() {
  const now = Date.now();
  return (await rows()).map(({ bot, status }) => {
    const e = statusOf(status, now);
    return { id: bot.id, name: bot.name, key: unseal(bot.keySealed) ?? "", sort: bot.sort, state: e.state, label: e.label, since: e.since.toISOString() };
  });
}

/** The bot owning this report key (every key is compared, so timing does not tell which one matched). */
export async function botByKey(probe: string) {
  const p = digest(probe);
  let found: { id: string; name: string } | null = null;
  for (const { bot } of await rows()) {
    if (crypto.timingSafeEqual(p, Buffer.from(bot.keyHash, "hex"))) found = { id: bot.id, name: bot.name };
  }
  return found;
}

/** Records a report. A label is stored only when approved; anything else is the generic text. */
export async function setStatus(botId: string, state: TvState, labelInput: unknown) {
  const now = new Date();
  const [cur] = await db().select().from(schema.tvStatus).where(eq(schema.tvStatus.botId, botId));
  const before = cur ? effectiveStatus(cur, now.getTime()) : null;
  const label = resolveLabel(labelInput, state);
  const since = before && before.state === state ? before.since : now;
  const values = { state, label, since, updatedAt: now };
  await db().insert(schema.tvStatus).values({ botId, ...values }).onConflictDoUpdate({ target: schema.tvStatus.botId, set: values });
}

export async function botExists(id: string): Promise<boolean> {
  return (await db().select({ id: schema.tvBots.id }).from(schema.tvBots).where(eq(schema.tvBots.id, id))).length > 0;
}

export async function addBot(rawName: unknown) {
  const name = cleanName(rawName);
  if (!name) throw new HTTPException(400, { message: "invalid_name" });
  const all = await rows();
  if (all.length >= MAX_BOTS) throw new HTTPException(409, { message: "too_many_bots" });
  if (all.some((r) => r.bot.nameKey === slugify(name))) throw new HTTPException(409, { message: "name_taken" });
  const sort = Math.max(-1, ...all.map((r) => r.bot.sort)) + 1;
  try {
    return { id: await insertBot(name, sort), name };
  } catch {
    throw new HTTPException(409, { message: "name_taken" });
  }
}

export async function updateBot(id: string, p: { name?: unknown; sort?: number }) {
  if (!(await botExists(id))) throw new HTTPException(404, { message: "not_found" });
  const set: Partial<typeof schema.tvBots.$inferInsert> = {};
  if (p.name !== undefined) {
    const name = cleanName(p.name);
    if (!name) throw new HTTPException(400, { message: "invalid_name" });
    const taken = (await rows()).some((r) => r.bot.id !== id && r.bot.nameKey === slugify(name));
    if (taken) throw new HTTPException(409, { message: "name_taken" });
    set.name = name;
    set.nameKey = slugify(name);
  }
  if (p.sort !== undefined) set.sort = p.sort;
  if (Object.keys(set).length) await db().update(schema.tvBots).set(set).where(eq(schema.tvBots.id, id));
}

export async function deleteBot(id: string): Promise<string> {
  const gone = await db().delete(schema.tvBots).where(eq(schema.tvBots.id, id)).returning({ name: schema.tvBots.name });
  if (!gone.length) throw new HTTPException(404, { message: "not_found" });
  return gone[0].name;
}

export async function rotateBotKey(id: string): Promise<string> {
  const key = newKey();
  const done = await db()
    .update(schema.tvBots)
    .set({ keyHash: digest(key).toString("hex"), keySealed: seal(key) })
    .where(eq(schema.tvBots.id, id))
    .returning({ id: schema.tvBots.id });
  if (!done.length) throw new HTTPException(404, { message: "not_found" });
  return key;
}
