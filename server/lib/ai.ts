import { and, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { seal, unseal } from "./crypto.ts";

/**
 * AI assistant (Anthropic Claude), configured in Admin settings › Integrations.
 * The API key is sealed with APP_SECRET and never leaves the server. Only the
 * ticket text needed for the task is sent (no portal accounts, no secrets).
 */
export const AI_PROVIDER = "anthropic";
export const AI_MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"] as const;
export type AiModel = (typeof AI_MODELS)[number];

/**
 * The parts of the portal that use Claude. Each uses the general model unless
 * an admin chose another one for it; a technician may pick another one for
 * one request when allowed. A new AI feature: add it here (and its label).
 */
export const AI_FEATURE_KEYS = ["ticket.analyze", "ticket.reply", "tickets.plan", "text.polish"] as const;
export type AiFeature = (typeof AI_FEATURE_KEYS)[number];

/** US dollars per million tokens (Anthropic API prices). */
export const AI_PRICES: Record<AiModel, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};
/** Cost of a request in millionths of a dollar (tokens × $/M tokens). */
export const costMicros = (model: AiModel, input: number, output: number) => Math.round(input * AI_PRICES[model].input + output * AI_PRICES[model].output);
const API = "https://api.anthropic.com/v1/messages";

export type AiErrorCode = "not_configured" | "disabled" | "auth" | "rate_limit" | "network" | "api" | "bad_output" | "billing" | "model" | "overloaded" | "refusal" | "daily_limit";
export class AiError extends Error {
  constructor(
    public code: AiErrorCode,
    public status?: number,
    /** Anthropic's own explanation (never contains the key) */
    public detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** Anthropic's error answer → a code the portal can explain. */
function apiError(status: number, body: { error?: { type?: string; message?: string } } | null): AiError {
  const type = body?.error?.type ?? "";
  const message = (body?.error?.message ?? "").slice(0, 300);
  if (status === 401 || status === 403 || type === "authentication_error" || type === "permission_error") return new AiError("auth", status, message);
  if (status === 429 || type === "rate_limit_error") return new AiError("rate_limit", status, message);
  // a new account without credits, or a spending limit reached
  if (/credit balance|billing|spend(ing)? limit|purchase credits/i.test(message)) return new AiError("billing", status, message);
  if (status === 404 || type === "not_found_error" || /model/i.test(message) && status === 400 && /not (found|available|supported)/i.test(message)) return new AiError("model", status, message);
  if (status === 529 || type === "overloaded_error") return new AiError("overloaded", status, message);
  return new AiError("api", status, message || `HTTP ${status}`);
}

export type AiSettings = {
  enabled: boolean;
  /** Default model (connection test, features without their own) */
  model: AiModel;
  apiKey: string | null;
  lastTest?: { ok: boolean; at: string; error?: AiErrorCode };
  /** Model chosen per part of the portal */
  featureModels: Partial<Record<AiFeature, AiModel>>;
  /** Technicians may pick another model for one request */
  allowChoice: boolean;
  /** Spending allowed per person per day (US$); null: no limit */
  dailyLimitUsd: number | null;
  /** Per person, instead of the daily limit (0: no AI for them) */
  userLimits: Record<string, number>;
};
type AiConfig = Omit<AiSettings, "enabled" | "apiKey">;

export async function aiSettings(): Promise<AiSettings> {
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, AI_PROVIDER));
  const config = (row?.config ?? {}) as Partial<AiConfig>;
  let apiKey: string | null = null;
  try {
    apiKey = (JSON.parse(unseal(row?.secret) ?? "{}") as { apiKey?: string }).apiKey ?? null;
  } catch {
    apiKey = null;
  }
  return {
    enabled: row?.enabled ?? false,
    model: AI_MODELS.includes(config.model as AiModel) ? (config.model as AiModel) : AI_MODELS[0],
    apiKey,
    lastTest: config.lastTest,
    featureModels: Object.fromEntries(Object.entries(config.featureModels ?? {}).filter(([k, v]) => (AI_FEATURE_KEYS as readonly string[]).includes(k) && AI_MODELS.includes(v as AiModel))) as AiSettings["featureModels"],
    allowChoice: config.allowChoice ?? true,
    dailyLimitUsd: typeof config.dailyLimitUsd === "number" ? config.dailyLimitUsd : null,
    userLimits: config.userLimits ?? {},
  };
}

/** The model of a part of the portal: the one asked for (when allowed), else its own, else the general one. */
export function modelFor(s: AiSettings, feature: AiFeature, asked?: AiModel | null): AiModel {
  if (asked && s.allowChoice && AI_MODELS.includes(asked)) return asked;
  return s.featureModels[feature] ?? s.model;
}

/** Midnight in Québec today (the daily limits restart then). */
export function startOfToday(now = new Date()): Date {
  const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const off = new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", timeZoneName: "longOffset" }).formatToParts(new Date(`${day}T12:00:00Z`)).find((p) => p.type === "timeZoneName")?.value.replace("GMT", "") || "-05:00";
  return new Date(`${day}T00:00:00${off}`);
}

/** What this person spent today (US$), and what they may spend (null: no limit). */
export async function todayOf(s: AiSettings, userId: string): Promise<{ spentUsd: number; limitUsd: number | null }> {
  const [r] = await db()
    .select({ micros: sql<number>`coalesce(sum(${schema.aiUsage.costMicros}), 0)::int` })
    .from(schema.aiUsage)
    .where(and(eq(schema.aiUsage.userId, userId), gte(schema.aiUsage.createdAt, startOfToday())));
  const limit = userId in s.userLimits ? s.userLimits[userId] : s.dailyLimitUsd;
  return { spentUsd: (r?.micros ?? 0) / 1_000_000, limitUsd: limit };
}

export async function saveAiSettings(actorId: string, p: Partial<Omit<AiSettings, "apiKey">> & { apiKey?: string }) {
  const cur = await aiSettings();
  const config: AiConfig = {
    model: p.model ?? cur.model,
    lastTest: p.apiKey !== undefined ? undefined : (p.lastTest ?? cur.lastTest),
    featureModels: p.featureModels ?? cur.featureModels,
    allowChoice: p.allowChoice ?? cur.allowChoice,
    dailyLimitUsd: p.dailyLimitUsd !== undefined ? p.dailyLimitUsd : cur.dailyLimitUsd,
    userLimits: p.userLimits ?? cur.userLimits,
  };
  const values = {
    enabled: p.enabled ?? cur.enabled,
    config: config as unknown as Record<string, unknown>,
    secret: seal(JSON.stringify({ apiKey: p.apiKey ?? cur.apiKey ?? undefined })),
    updatedBy: actorId,
    updatedAt: new Date(),
  };
  await db()
    .insert(schema.integrations)
    .values({ provider: AI_PROVIDER, ...values })
    .onConflictDoUpdate({ target: schema.integrations.provider, set: values });
}

/**
 * One request to Claude; returns the text answer. Routine portal tasks
 * think little (effort "low": faster and cheaper); the answer room covers
 * the model's reasoning, which counts in max_tokens.
 */
export async function askClaude(
  opts: {
    system: string;
    prompt: string;
    maxTokens?: number;
    /** The part of the portal (its model, and the usage summary) */
    feature?: AiFeature;
    /** Who asked (their daily limit; null: the admin's connection test) */
    userId?: string | null;
    /** A model picked for this one request (used when allowed) */
    model?: AiModel | null;
  },
  settings?: Pick<AiSettings, "apiKey" | "model">,
): Promise<string> {
  const full = await aiSettings();
  const s = settings ?? full;
  if (!s.apiKey) throw new AiError("not_configured");
  if (!settings && !full.enabled) throw new AiError("disabled");
  const model = settings ? settings.model : opts.feature ? modelFor(full, opts.feature, opts.model) : full.model;
  if (opts.userId) {
    const day = await todayOf(full, opts.userId);
    if (day.limitUsd !== null && day.spentUsd >= day.limitUsd) throw new AiError("daily_limit");
  }
  let res: Response;
  try {
    res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": s.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 4000,
        output_config: { effort: "low" },
        system: opts.system,
        messages: [{ role: "user", content: opts.prompt }],
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new AiError("network");
  }
  if (!res.ok) throw apiError(res.status, (await res.json().catch(() => null)) as { error?: { type?: string; message?: string } } | null);
  const j = (await res.json()) as { content?: { type: string; text?: string }[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } };
  // every request is counted (the usage summary, the daily limits)
  const input = (j.usage?.input_tokens ?? 0) + (j.usage?.cache_creation_input_tokens ?? 0) + (j.usage?.cache_read_input_tokens ?? 0);
  const output = j.usage?.output_tokens ?? 0;
  await db()
    .insert(schema.aiUsage)
    .values({ userId: opts.userId ?? null, feature: opts.feature ?? "test", model, inputTokens: input, outputTokens: output, costMicros: costMicros(model, input, output) })
    .catch((e) => console.warn("[ai] usage:", e instanceof Error ? e.message : e));
  if (j.stop_reason === "refusal") throw new AiError("refusal");
  return (j.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}

/** Ask for JSON and parse it (tolerates text or ``` fences around it). */
export async function askClaudeJson<T>(opts: Parameters<typeof askClaude>[0]): Promise<T> {
  const text = await askClaude({ ...opts, system: `${opts.system}\nRéponds uniquement avec un objet JSON valide, sans texte autour.` });
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new AiError("bad_output");
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    throw new AiError("bad_output");
  }
}
