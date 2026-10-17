import { eq } from "drizzle-orm";
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
const API = "https://api.anthropic.com/v1/messages";

export type AiErrorCode = "not_configured" | "disabled" | "auth" | "rate_limit" | "network" | "api" | "bad_output" | "billing" | "model" | "overloaded" | "refusal";
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

export type AiSettings = { enabled: boolean; model: AiModel; apiKey: string | null; lastTest?: { ok: boolean; at: string; error?: AiErrorCode } };

export async function aiSettings(): Promise<AiSettings> {
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, AI_PROVIDER));
  const config = (row?.config ?? {}) as { model?: AiModel; lastTest?: AiSettings["lastTest"] };
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
  };
}

export async function saveAiSettings(actorId: string, p: { enabled?: boolean; model?: AiModel; apiKey?: string; lastTest?: AiSettings["lastTest"] }) {
  const cur = await aiSettings();
  const values = {
    enabled: p.enabled ?? cur.enabled,
    config: { model: p.model ?? cur.model, lastTest: p.apiKey !== undefined ? undefined : (p.lastTest ?? cur.lastTest) },
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
  opts: { system: string; prompt: string; maxTokens?: number },
  settings?: Pick<AiSettings, "apiKey" | "model">,
): Promise<string> {
  const s = settings ?? (await aiSettings());
  if (!s.apiKey) throw new AiError("not_configured");
  if (!settings && !(await aiSettings()).enabled) throw new AiError("disabled");
  let res: Response;
  try {
    res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": s.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: s.model,
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
  const j = (await res.json()) as { content?: { type: string; text?: string }[]; stop_reason?: string };
  if (j.stop_reason === "refusal") throw new AiError("refusal");
  return (j.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}

/** Ask for JSON and parse it (tolerates text or ``` fences around it). */
export async function askClaudeJson<T>(opts: { system: string; prompt: string; maxTokens?: number }): Promise<T> {
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
