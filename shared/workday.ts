/**
 * A work day: start to end, minus the lunch. The lunch is 1 h of which 30 min are paid, so 30 min come off —
 * but only when the day worked without the lunch hour is 5 h or more; a shorter day has no lunch to take off.
 */
export const LUNCH_MINUTES = 60;
export const PAID_LUNCH_MINUTES = 30;
export const LUNCH_FROM_MINUTES = 5 * 60;

/** Minutes taken off a work day that goes from `start` to `end` (minutes since midnight) */
export function unpaidLunch(start: number, end: number): number {
  return end - start - LUNCH_MINUTES >= LUNCH_FROM_MINUTES ? LUNCH_MINUTES - PAID_LUNCH_MINUTES : 0;
}
