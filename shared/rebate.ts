/**
 * Rebates (rabais): a percentage off a price, kept as basis points (percent × 100, 0–10000). The regular price is always
 * kept as it is; what is charged is the price after the rebate, rounded to the cent. Two rebates stack (a line's, then the contract's).
 */
export const MAX_REBATE_BPS = 10_000;
export const clampBps = (n: number) => Math.max(0, Math.min(MAX_REBATE_BPS, Math.round(Number.isFinite(n) ? n : 0)));
/** The price after a rebate */
export const netCents = (priceCents: number, bps: number | null | undefined) => Math.round((priceCents * (MAX_REBATE_BPS - clampBps(bps ?? 0))) / MAX_REBATE_BPS);
/** One rebate made of two: 10 % then 10 % = 19 % */
export const combineBps = (a: number | null | undefined, b: number | null | undefined) => clampBps(MAX_REBATE_BPS - ((MAX_REBATE_BPS - clampBps(a ?? 0)) * (MAX_REBATE_BPS - clampBps(b ?? 0))) / MAX_REBATE_BPS);
/** Percent typed by a person ("12,5") → bps */
export const bpsOfPercent = (v: string | number) => clampBps((typeof v === "number" ? v : Number(String(v).replace(",", ".")) || 0) * 100);
/** The rebate that takes a regular price to a price after it (both in cents; 0 when they do not make sense) */
export const bpsOfPrices = (regularCents: number, finalCents: number) => (regularCents > 0 && finalCents >= 0 && finalCents <= regularCents ? clampBps(((regularCents - finalCents) / regularCents) * MAX_REBATE_BPS) : 0);
export const percentText = (bps: number) => `${(clampBps(bps) / 100).toLocaleString("fr-CA", { maximumFractionDigits: 2 })} %`;
