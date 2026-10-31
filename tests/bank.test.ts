import { describe, expect, it } from "vitest";
import { bankBundle, bankMonths, bankNow } from "../shared/bank.ts";

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
