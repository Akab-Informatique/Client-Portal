import { describe, expect, it } from "vitest";
import { prorata, type Prorata } from "../shared/prorata.ts";

const ok = (r: Prorata | string) => {
  if (typeof r === "string") throw new Error(r);
  return r;
};

describe("prorata of a service added to a contract", () => {
  it("monthly: the days left of the month, then full months, the last one prorated to the contract end", () => {
    // 300 $ a month, added on 16 October to a contract 1 Oct → 15 Dec
    const r = ok(prorata({ period: "monthly", priceCents: 30_000, addedOn: "2026-10-16", start: "2026-10-01", end: "2026-12-15" }));
    expect(r.periods.map((p) => [p.from, p.to, p.days, p.periodDays, p.full, p.amountCents])).toEqual([
      ["2026-10-16", "2026-10-31", 16, 31, false, 15_484],
      ["2026-11-01", "2026-11-30", 30, 30, true, 30_000],
      ["2026-12-01", "2026-12-15", 15, 31, false, 14_516],
    ]);
    expect(r.firstCents).toBe(15_484);
    expect(r.totalCents).toBe(60_000);
  });

  it("monthly: added on the 1st, the first month is full; February counts its 28 days", () => {
    const r = ok(prorata({ period: "monthly", priceCents: 10_000, addedOn: "2027-02-01", start: "2027-01-01", end: "2027-03-31" }));
    expect(r.periods.map((p) => p.full)).toEqual([true, true]);
    expect(r.totalCents).toBe(20_000);
    const mid = ok(prorata({ period: "monthly", priceCents: 28_000, addedOn: "2027-02-15", start: "2027-01-01", end: "2027-02-28" }));
    expect(mid.periods).toHaveLength(1);
    expect(mid.firstCents).toBe(14_000); // 14 days of 28
  });

  it("yearly: the days left of the contract year, then full years, the last prorated", () => {
    // 1 200 $ a year, contract 1 Jan 2026 → 31 Dec 2027, added on 1 July 2026
    const r = ok(prorata({ period: "yearly", priceCents: 120_000, addedOn: "2026-07-01", start: "2026-01-01", end: "2027-12-31" }));
    expect(r.periods.map((p) => [p.from, p.to, p.days, p.periodDays, p.full])).toEqual([
      ["2026-07-01", "2026-12-31", 184, 365, false],
      ["2027-01-01", "2027-12-31", 365, 365, true],
    ]);
    expect(r.firstCents).toBe(60_493); // 120 000 × 184 ÷ 365
    expect(r.totalCents).toBe(180_493);
    // a contract that does not start on the 1st: years run from its start date
    const odd = ok(prorata({ period: "yearly", priceCents: 36_500, addedOn: "2026-11-01", start: "2026-09-15", end: "2027-09-14" }));
    expect(odd.periods).toHaveLength(1);
    expect(odd.periods[0]).toMatchObject({ from: "2026-11-01", to: "2027-09-14", days: 318, periodDays: 365 });
  });

  it("yearly: a term of less than a year is prorated to its end; a leap year has 366 days", () => {
    const short = ok(prorata({ period: "yearly", priceCents: 36_500, addedOn: "2026-01-01", start: "2026-01-01", end: "2026-06-30" }));
    expect(short.periods).toHaveLength(1);
    expect(short.firstCents).toBe(Math.round((36_500 * 181) / 365));
    const leap = ok(prorata({ period: "yearly", priceCents: 36_600, addedOn: "2028-01-01", start: "2028-01-01", end: "2028-06-30" }));
    expect(leap.periods[0]!.periodDays).toBe(366);
  });

  it("refuses dates that make no sense", () => {
    expect(prorata({ period: "monthly", priceCents: 1, addedOn: "2026-09-30", start: "2026-10-01", end: "2026-12-31" })).toBe("outside");
    expect(prorata({ period: "monthly", priceCents: 1, addedOn: "2027-01-01", start: "2026-10-01", end: "2026-12-31" })).toBe("outside");
    expect(prorata({ period: "monthly", priceCents: 1, addedOn: "2026-10-01", start: "2026-12-31", end: "2026-10-01" })).toBe("dates");
    expect(prorata({ period: "monthly", priceCents: 1, addedOn: "nope", start: "2026-10-01", end: "2026-12-31" })).toBe("dates");
  });
});
