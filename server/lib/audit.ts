import { db, schema } from "../db/index.ts";

/** Record an admin action. Never store secrets in details. */
export async function audit(
  actorId: string | null,
  action: string,
  target?: string | null,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    await db().insert(schema.auditLog).values({ actorId, action, target: target ?? null, details: details ?? null });
  } catch (e) {
    console.warn("[audit] write failed", e);
  }
}
