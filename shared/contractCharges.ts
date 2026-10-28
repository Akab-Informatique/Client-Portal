import { addYears, prorata, type ServicePeriod } from "./prorata.ts";

/**
 * What the recurring services of a contract will charge, period by period (the portal and the API use the same rule).
 *
 * Each service is prorated on the term of the contract (see prorata.ts). A contract is charged **monthly** (one charge
 * on the first of each month, or on the day a service starts when that is mid-month) or **yearly** (one charge per
 * contract year, the services starting later in the year charged on their own day for what is left of it). Nothing
 * here bills anything: it is the schedule, shown on the contract.
 */
export type BillingPeriod = "monthly" | "yearly";
export type ChargeLine = { id: string; name: string; kind: "recurring" | "recurring_yearly"; priceCents: number; quantity: number; addedOn: string };
export type ChargePiece = { lineId: string; name: string; amountCents: number; prorated: boolean; days: number; periodDays: number; from: string; to: string };
export type ChargeEntry = {
  /** The day it is charged */
  date: string;
  from: string;
  to: string;
  amountCents: number;
  /** At least one piece covers only part of its period */
  prorated: boolean;
  pieces: ChargePiece[];
};
export type ContractCharges = {
  /** The last day charged: the end of the contract, or the day it was stopped */
  endsOn: string | null;
  /** Everything the contract will charge over its term */
  revenueCents: number;
  /** A full period: per month for a monthly contract, per year for a yearly one */
  perPeriodCents: number;
  /** Monthly contract only: the yearly services, charged once per contract year, on top of the monthly charge */
  yearlyExtraCents: number;
  entries: ChargeEntry[];
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A recurring contract can be sold as a **bundle**: one price and a quantity for the whole package, per billing period
 * (per month on a monthly contract, per year on a yearly one). Its services stay listed on the contract but carry no price of
 * their own: what is charged is the bundle, from the contract's start day. Without a bundle, the services are charged one by one.
 */
export type BundleOf = { name: string; startDate: string | null; billingPeriod: BillingPeriod; bundlePriceCents?: number | null; bundleQuantity?: number | null };
export const hasBundle = (c: { bundlePriceCents?: number | null }) => c.bundlePriceCents != null;
/** The lines the charges are worked out from: the bundle alone when there is one, else the services */
export function linesForCharges(c: BundleOf, services: ChargeLine[]): ChargeLine[] {
  if (!hasBundle(c) || !c.startDate) return services;
  return [{ id: "bundle", name: c.name, kind: c.billingPeriod === "yearly" ? "recurring_yearly" : "recurring", priceCents: c.bundlePriceCents!, quantity: Math.max(1, c.bundleQuantity ?? 1), addedOn: c.startDate }];
}

export function contractCharges(
  c: { startDate: string | null; endDate: string | null; endedOn?: string | null; billingPeriod: BillingPeriod },
  lines: ChargeLine[],
): ContractCharges {
  const empty: ContractCharges = { endsOn: null, revenueCents: 0, perPeriodCents: 0, yearlyExtraCents: 0, entries: [] };
  if (!c.startDate || !c.endDate || !DAY_RE.test(c.startDate) || !DAY_RE.test(c.endDate) || c.endDate < c.startDate) return empty;
  const start = c.startDate;
  const endsOn = c.endedOn && c.endedOn < c.endDate ? (c.endedOn < start ? start : c.endedOn) : c.endDate;
  const byDate = new Map<string, ChargeEntry>();
  const add = (date: string, piece: ChargePiece) => {
    const e = byDate.get(date) ?? { date, from: piece.from, to: piece.to, amountCents: 0, prorated: false, pieces: [] };
    e.pieces.push(piece);
    e.amountCents += piece.amountCents;
    e.prorated = e.prorated || piece.prorated;
    if (piece.from < e.from) e.from = piece.from;
    if (piece.to > e.to) e.to = piece.to;
    byDate.set(date, e);
  };
  for (const l of lines) {
    const period: ServicePeriod = l.kind === "recurring_yearly" ? "yearly" : "monthly";
    const plan = prorata({ period, priceCents: l.priceCents * Math.max(1, l.quantity), addedOn: l.addedOn, start, end: endsOn });
    if (typeof plan === "string") continue;
    const piece = (p: (typeof plan.periods)[number]): ChargePiece => ({ lineId: l.id, name: l.name, amountCents: p.amountCents, prorated: !p.full, days: p.days, periodDays: p.periodDays, from: p.from, to: p.to });
    if (c.billingPeriod === "monthly" || period === "yearly") {
      // one charge per period of the service
      for (const p of plan.periods) add(p.from, piece(p));
    } else {
      // a yearly contract charges a monthly service once per contract year, on the first day it covers in that year
      const yearOf = (d: string) => {
        let k = 0;
        while (addYears(start, k + 1) <= d) k++;
        return addYears(start, k);
      };
      const groups = new Map<string, typeof plan.periods>();
      for (const p of plan.periods) {
        const y = yearOf(p.from);
        groups.set(y, [...(groups.get(y) ?? []), p]);
      }
      for (const ps of groups.values()) {
        const first = ps[0];
        add(first.from, {
          lineId: l.id,
          name: l.name,
          amountCents: ps.reduce((n, p) => n + p.amountCents, 0),
          prorated: ps.some((p) => !p.full),
          days: ps.reduce((n, p) => n + p.days, 0),
          periodDays: first.periodDays,
          from: first.from,
          to: ps[ps.length - 1].to,
        });
      }
    }
  }
  const entries = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const monthly = lines.filter((l) => l.kind === "recurring").reduce((n, l) => n + l.priceCents * Math.max(1, l.quantity), 0);
  const yearly = lines.filter((l) => l.kind === "recurring_yearly").reduce((n, l) => n + l.priceCents * Math.max(1, l.quantity), 0);
  return {
    endsOn,
    revenueCents: entries.reduce((n, e) => n + e.amountCents, 0),
    perPeriodCents: c.billingPeriod === "yearly" ? monthly * 12 + yearly : monthly,
    yearlyExtraCents: c.billingPeriod === "yearly" ? 0 : yearly,
    entries,
  };
}

/** What has fallen due on a day, and the next charge after it */
export function chargesOn(ch: ContractCharges, today: string, billedThrough?: string | null) {
  // what was invoiced in the old system (on or before `billedThrough`) is never due here
  const billed = billedThrough ? ch.entries.filter((e) => e.date <= billedThrough) : [];
  const due = ch.entries.filter((e) => e.date <= today && !(billedThrough && e.date <= billedThrough));
  return {
    due,
    dueCents: due.reduce((n, e) => n + e.amountCents, 0),
    billedCents: billed.reduce((n, e) => n + e.amountCents, 0),
    next: ch.entries.find((e) => e.date > today && !(billedThrough && e.date <= billedThrough)) ?? null,
  };
}
