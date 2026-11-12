import { describe, expect, it } from "vitest";
import { bankBundle, bankMonths, bankNow, withTopupCharges } from "../shared/bank.ts";

const used = (o: Record<string, number>) => new Map(Object.entries(o));

describe("the hours bank of a contract", () => {
  it("is a bundle: whole hours at the price of an hour, else one unit at the total", () => {
    expect(bankBundle(10, 10000)).toEqual({ priceCents: 10000, quantity: 10 });
    expect(bankBundle(7.5, 10000)).toEqual({ priceCents: 75000, quantity: 1 });
  });

  const run = (rollover: "lose" | "carry" | "topup", u: Record<string, number>) => bankMonths({ hours: 10, rollover, start: "2026-01-15", end: "2026-12-31", today: "2026-03-10", used: used(u) });

  it("loses the hours not used", () => {
    const r = run("lose", { "2026-01": 4 });
    expect(r.map((x) => [x.month, x.available, x.left, x.charge])).toEqual([["2026-01", 10, 6, 10], ["2026-02", 10, 10, 10], ["2026-03", 10, 10, 10]]);
  });

  it("rolls them over: they add to next month and the whole bank is still bought", () => {
    const r = run("carry", { "2026-01": 4, "2026-02": 3 });
    expect(r.map((x) => [x.available, x.left, x.charge])).toEqual([[10, 6, 10], [16, 13, 10], [23, 23, 10]]);
  });

  it("tops up: next month only buys what fills the bank back", () => {
    const r = run("topup", { "2026-01": 4 });
    expect(r.map((x) => [x.available, x.charge])).toEqual([[10, 10], [10, 4], [10, 0]]);
  });

  it("tops up: hours above the bank (a balance he has) are all usable and nothing is bought until he is under it", () => {
    // 54 h added by hand in January: 64 h available, 4 used → 60 left, nothing to buy, all 60 usable
    const r = bankMonths({ hours: 10, rollover: "topup", start: "2026-01-15", end: "2026-12-31", today: "2026-04-10", used: used({ "2026-01": 4, "2026-02": 55, "2026-03": 3 }), adjust: used({ "2026-01": 54 }) });
    expect(r.map((x) => [x.month, x.available, x.used, x.left, x.charge])).toEqual([
      ["2026-01", 64, 4, 60, 10],
      ["2026-02", 60, 55, 5, 0],
      // 5 left: he buys 5 to be back at 10
      ["2026-03", 10, 3, 7, 5],
      ["2026-04", 10, 0, 10, 3],
    ]);
  });

  it("tops up: hours taken from next month are bought back (5 h over a 20 h bank = 25 h bought)", () => {
    const r = bankMonths({ hours: 20, rollover: "topup", start: "2026-01-01", end: "2026-12-31", today: "2026-03-10", used: used({ "2026-01": 25 }) });
    expect(r[0]).toMatchObject({ available: 20, left: 0, over: 5, charge: 20 });
    expect(r[1]).toMatchObject({ available: 20, charge: 25 });
  });

  it("takes hours worked past the bank right away from next month", () => {
    const r = run("lose", { "2026-01": 13 });
    expect(r[0]).toMatchObject({ left: 0, over: 3 });
    expect(r[1]).toMatchObject({ available: 7 });
    expect(bankNow(r, "2026-03-10")).toMatchObject({ available: 10, left: 10 });
  });

  it("is empty with no hours or no start day", () => {
    expect(bankMonths({ hours: 0, rollover: "lose", start: "2026-01-01", today: "2026-02-01", used: new Map() })).toEqual([]);
    expect(bankMonths({ hours: 5, rollover: "lose", start: null, today: "2026-02-01", used: new Map() })).toEqual([]);
  });
});

describe("an hours bank that tops up, foreseen", () => {
  it("buys nothing next month while the client has more than the bank, and the schedule shows it", () => {
    // 20 h a month, 64 h unused at the end of the current month: December buys nothing
    const rows = bankMonths({ hours: 20, rollover: "topup", start: "2026-11-01", end: "2027-03-31", today: "2026-11-12", used: used({ "2026-11": 0 }), adjust: used({ "2026-11": 44 }), project: true });
    expect(rows.find((r) => r.month === "2026-11")?.charge).toBe(20);
    expect(rows.find((r) => r.month === "2026-12")?.charge).toBe(0);
    const ch = { revenueCents: 340000, entries: [{ date: "2026-12-01", amountCents: 170000, prorated: false, pieces: [{ lineId: "bundle", amountCents: 170000, prorated: false }] }, { date: "2027-01-01", amountCents: 170000, prorated: false, pieces: [{ lineId: "bundle", amountCents: 170000, prorated: false }] }] };
    const out = withTopupCharges(ch, new Map(rows.map((r) => [r.month, r.charge])), 8500);
    expect(out.entries[0].amountCents).toBe(0);
    expect(out.revenueCents).toBe(0);
  });
});
