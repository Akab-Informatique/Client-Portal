/** Durations typed and shown as h:mm (time entries), kept as decimal hours. */
/** Hours as h:mm ("1:15" for 1.25) */
export function hm(hours: number): string {
  const total = Math.round((hours || 0) * 60);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
/**
 * A duration typed as h:mm ("1:15", "0:45", "1h15", "2" = 2:00) → decimal hours;
 * null when it is not one (minutes over 59, letters…).
 */
export function parseHm(text: string): number | null {
  const v = text.trim().toLowerCase().replace(/\s+/g, "");
  if (!v) return null;
  const m = v.match(/^(\d{1,2})(?:[:h](\d{0,2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return null;
  return Math.round((h + min / 60) * 10_000) / 10_000;
}
