import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";
import { seal, unseal } from "./crypto.ts";

/**
 * Microsoft Teams, one incoming webhook (a Teams "Workflows" webhook posting to a channel or a chat) set by an
 * admin. The portal posts a card there, mentioning the technician by their email address. Nothing is read from
 * Teams. The webhook address is a secret (sealed, never sent back to the browser).
 */
export const TEAMS_PROVIDER = "teams";

/** Teams / Power Automate webhooks only: https, and a host of Microsoft's. */
const HOSTS = ["webhook.office.com", "logic.azure.com", "powerplatform.com", "azure-api.net"];
export function validTeamsUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export type TeamsSettings = { enabled: boolean; webhookUrl: string | null; lastTest?: { ok: boolean; at: string; error?: string } };

export async function teamsSettings(): Promise<TeamsSettings> {
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, TEAMS_PROVIDER));
  const c = (row?.config ?? {}) as { lastTest?: TeamsSettings["lastTest"] };
  return { enabled: row?.enabled ?? false, webhookUrl: unseal(row?.secret), lastTest: c.lastTest };
}

export async function saveTeamsSettings(actorId: string, p: { enabled?: boolean; webhookUrl?: string | null; lastTest?: TeamsSettings["lastTest"] }) {
  const cur = await teamsSettings();
  const next = { ...cur, ...p };
  const values = {
    enabled: next.enabled,
    config: { lastTest: next.lastTest },
    secret: next.webhookUrl ? seal(next.webhookUrl) : null,
    updatedBy: actorId,
    updatedAt: new Date(),
  };
  await db()
    .insert(schema.integrations)
    .values({ provider: TEAMS_PROVIDER, ...values })
    .onConflictDoUpdate({ target: schema.integrations.provider, set: values });
}

export async function teamsReady(): Promise<boolean> {
  const s = await teamsSettings();
  return s.enabled && Boolean(s.webhookUrl && validTeamsUrl(s.webhookUrl));
}

/** An Adaptive Card post, mentioning the person when their email is known. */
export async function sendTeams(m: { title: string; text: string; link?: string; mention?: { name: string; email: string } }): Promise<void> {
  const s = await teamsSettings();
  if (!s.enabled || !s.webhookUrl || !validTeamsUrl(s.webhookUrl)) throw new Error("teams_not_ready");
  const at = m.mention ? `<at>${m.mention.name}</at> ` : "";
  const card = {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [
      { type: "TextBlock", text: m.title, weight: "Bolder", size: "Medium", wrap: true },
      { type: "TextBlock", text: `${at}${m.text}`, wrap: true },
    ],
    ...(m.link ? { actions: [{ type: "Action.OpenUrl", title: "Ouvrir le billet", url: m.link }] } : {}),
    ...(m.mention ? { msteams: { entities: [{ type: "mention", text: `<at>${m.mention.name}</at>`, mentioned: { id: m.mention.email, name: m.mention.name } }] } } : {}),
  };
  const res = await fetch(s.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: card }] }),
    signal: AbortSignal.timeout(15_000),
  });
  // Workflows answers 200 / 202; anything else is a refusal
  if (!res.ok) throw new Error(`teams_http_${res.status}`);
}
