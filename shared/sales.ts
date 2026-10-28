/**
 * Vente › Ventes: the sales pipeline (opportunities) and its dashboard.
 * Shared by the API and the screen so the figures are always worked out the same way.
 */

export const SALES_STAGES = ["lead", "contact", "meeting", "quote_sent", "won", "lost"] as const;
export type SalesStage = (typeof SALES_STAGES)[number];
export const OPEN_STAGES: readonly SalesStage[] = ["lead", "contact", "meeting", "quote_sent"];
export const isOpenStage = (s: string) => (OPEN_STAGES as readonly string[]).includes(s);

/** The chance of closing a deal at each stage, unless typed otherwise on the opportunity */
export const STAGE_PROBABILITY: Record<SalesStage, number> = { lead: 10, contact: 20, meeting: 35, quote_sent: 50, won: 100, lost: 0 };

export const SALES_SOURCES = ["bni", "referral", "website", "millenium", "prospecting", "other"] as const;
export type SalesSource = (typeof SALES_SOURCES)[number];

/** recurring = the contract per user and per month; one_time = a project or equipment, counted apart */
export const SALES_KINDS = ["recurring", "one_time"] as const;
export type SalesKind = (typeof SALES_KINDS)[number];

export const LOST_REASONS = ["price", "timing", "incumbent", "no_answer", "other"] as const;
export type LostReason = (typeof LOST_REASONS)[number];

/** The usual price of the contract: 150 $ per user per month */
export const DEFAULT_RATE_PER_USER_CENTS = 15_000;

/** What a recurring opportunity brings each month (users × price per user); 0 for a one-time sale */
export const monthlyCents = (o: { kind: string; users: number | null; ratePerUserCents: number }) =>
  o.kind === "recurring" ? Math.max(o.users ?? 0, 0) * o.ratePerUserCents : 0;

// ---- periods -------------------------------------------------------------

/** month, quarter of the financial year, or the financial year (AKAB's ends on October 31) */
export const SALES_PERIODS = ["month", "quarter", "year"] as const;
export type SalesPeriod = (typeof SALES_PERIODS)[number];

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** The financial year a day falls in: FY 2026 = 2025-11-01 … 2026-10-31 */
export const fiscalYearOf = (day: string) => {
  const [y, m] = day.split("-").map(Number);
  return m >= 11 ? y + 1 : y;
};

/**
 * The days a period covers around a reference day, both included.
 * Quarters follow the financial year: Q1 Nov–Jan, Q2 Feb–Apr, Q3 May–Jul, Q4 Aug–Oct.
 */
export function periodRange(period: SalesPeriod, day: string): { from: string; to: string; fiscalYear: number; quarter: number } {
  const [y, m] = day.split("-").map(Number);
  const fiscalYear = fiscalYearOf(day);
  // month index inside the financial year: November = 0 … October = 11
  const fm = (m + 1) % 12;
  const quarter = Math.floor(fm / 3) + 1;
  if (period === "month") return { from: ymd(y, m, 1), to: ymd(y, m, lastDay(y, m)), fiscalYear, quarter };
  if (period === "year") return { from: ymd(fiscalYear - 1, 11, 1), to: ymd(fiscalYear, 10, 31), fiscalYear, quarter };
  const startFm = (quarter - 1) * 3;
  const at = (k: number) => {
    // k-th month of the financial year → calendar year and month
    const cm = ((k + 10) % 12) + 1;
    return { y: cm >= 11 ? fiscalYear - 1 : fiscalYear, m: cm };
  };
  const a = at(startFm);
  const b = at(startFm + 2);
  return { from: ymd(a.y, a.m, 1), to: ymd(b.y, b.m, lastDay(b.y, b.m)), fiscalYear, quarter };
}

/** The reference day moved by one period (for the ‹ › arrows) */
export function shiftPeriod(period: SalesPeriod, day: string, by: number): string {
  const [y, m] = day.split("-").map(Number);
  const months = period === "month" ? by : period === "quarter" ? by * 3 : by * 12;
  const total = y * 12 + (m - 1) + months;
  return ymd(Math.floor(total / 12), (total % 12) + 1, 1);
}

/** Whole days from one day to the other */
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
