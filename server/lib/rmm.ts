import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.ts";

/**
 * RMM links (Datto RMM, N-able, NinjaOne…). No API: the portal only builds
 * links to the RMM web console from the asset's RMM identifiers, with two
 * URL templates set by an admin (device page, web remote control). The RMM
 * keeps its own sign-in and rights.
 *
 * Placeholders: {uid} {id} {hostname} {serial} {ip}
 */
export const RMM_PROVIDER = "rmm";
export const RMM_PLACEHOLDERS = ["uid", "id", "hostname", "serial", "ip"] as const;
export type RmmPlaceholder = (typeof RMM_PLACEHOLDERS)[number];

export type RmmSettings = { enabled: boolean; name: string; deviceUrl: string; remoteUrl: string };

export async function rmmSettings(): Promise<RmmSettings> {
  const [row] = await db().select().from(schema.integrations).where(eq(schema.integrations.provider, RMM_PROVIDER));
  const c = (row?.config ?? {}) as Partial<RmmSettings>;
  return { enabled: row?.enabled ?? false, name: c.name ?? "", deviceUrl: c.deviceUrl ?? "", remoteUrl: c.remoteUrl ?? "" };
}

export async function saveRmmSettings(actorId: string, p: RmmSettings) {
  const values = {
    enabled: p.enabled,
    config: { name: p.name, deviceUrl: p.deviceUrl, remoteUrl: p.remoteUrl },
    updatedBy: actorId,
    updatedAt: new Date(),
  };
  await db()
    .insert(schema.integrations)
    .values({ provider: RMM_PROVIDER, ...values })
    .onConflictDoUpdate({ target: schema.integrations.provider, set: values });
}

/** A template is an https URL whose {placeholders} are all known. */
export function validTemplate(t: string): boolean {
  if (!t) return true;
  if (!/^https:\/\/[^\s/{}]+\//i.test(t)) return false;
  const used = [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  return used.length > 0 && used.every((u) => (RMM_PLACEHOLDERS as readonly string[]).includes(u));
}

/** The link for this device, or null when a value it needs is missing. */
export function rmmLink(template: string, values: Partial<Record<RmmPlaceholder, string | null>>): string | null {
  if (!template || !validTemplate(template)) return null;
  let missing = false;
  const url = template.replace(/\{(\w+)\}/g, (_, k: RmmPlaceholder) => {
    const v = values[k];
    if (!v) missing = true;
    return encodeURIComponent(v ?? "");
  });
  return missing ? null : url;
}
