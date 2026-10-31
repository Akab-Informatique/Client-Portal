/**
 * How profitable a client is for us (administrators only): the money that comes in against what the work costs us, over a period.
 *
 *  - money in  = what we bill the client in the period: every line of work to bill that is not set aside (recurring contract
 *    charges, time, charges, expenses billed back…), before taxes;
 *  - cost      = the hours our technicians spent on the client's tickets × each one's hourly wage (HR file), whether billed or not,
 *    + the cost price of the charges sold and of the recurring services (what the vendors bill us);
 *  - profit    = money in − cost; margin = profit ÷ money in;
 *  - per hour  = money in ÷ hours spent, against what an hour costs us (labour cost ÷ hours): the "real hourly rate" of the client.
 *
 * An MSP lives on recurring revenue against the time the client takes, so the gauge reads the margin: under 0 we lose money on the
 * client, up to 25 % it barely pays, up to 45 % it is fair, above it is healthy.
 */
export type ProfitLevel = "loss" | "weak" | "fair" | "healthy";
export const LEVEL_FAIR_FROM = 25;
export const LEVEL_HEALTHY_FROM = 45;
export function profitLevel(marginPct: number | null, costCents: number): ProfitLevel | null {
  if (marginPct === null) return costCents > 0 ? "loss" : null;
  return marginPct < 0 ? "loss" : marginPct < LEVEL_FAIR_FROM ? "weak" : marginPct < LEVEL_HEALTHY_FROM ? "fair" : "healthy";
}
