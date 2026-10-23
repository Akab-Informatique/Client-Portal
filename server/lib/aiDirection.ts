/**
 * Extra direction typed by the person next to an AI button. It is the person's own instruction (not data from a
 * ticket), added to the prompt; the answer format and the portal's rules (hours, no overlap) still apply.
 */
export const MAX_DIRECTION = 1000;

export function cleanDirection(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, MAX_DIRECTION) : "";
}

/** The part to add at the end of a prompt ("" when there is none) */
export const directionPrompt = (direction: string) =>
  direction ? `\n\nConsigne supplémentaire du technicien (à suivre en plus de ce qui précède, sans changer le format de réponse demandé) : « ${direction} »` : "";
