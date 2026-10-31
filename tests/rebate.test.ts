import { describe, expect, it } from "vitest";
import { bpsOfPercent, bpsOfPrices, combineBps, netCents } from "../shared/rebate.ts";
import { contractCharges, linesForCharges } from "../shared/contractCharges.ts";
import { hourlyRateOf } from "../server/lib/contracts.ts";

describe("rebates", () => {
  it("take a percentage off a price, kept apart from the regular price", () => {
    expect(netCents(10000, 1000)).toBe(9000);
    expect(netCents(10000, 0)).toBe(10000);
    expect(netCents(9999, 1250)).toBe(8749);
    expect(bpsOfPercent("12,5")).toBe(1250);
    expect(bpsOfPrices(10000, 9000)).toBe(1000);
    // two rebates stack: 10 % then 10 % = 19 %
    expect(combineBps(1000, 1000)).toBe(1900);
  });

  it("change what a contract charges: a line's, then the contract's", () => {
    const line = { id: "a", name: "Exchange", kind: "recurring" as const, priceCents: 10000, quantity: 2, addedOn: "2026-01-01" };
    const make = (rebateBps: number, lineBps = 0) =>
      contractCharges({ startDate: "2026-01-01", endDate: "2026-12-31", billingPeriod: "monthly" }, linesForCharges({ name: "C", startDate: "2026-01-01", billingPeriod: "monthly", rebateBps }, [{ ...line, rebateBps: lineBps }]));
    expect(make(0).perPeriodCents).toBe(20000);
    expect(make(1000).perPeriodCents).toBe(18000);
    expect(make(1000, 1000).perPeriodCents).toBe(2 * netCents(10000, 1900));
    // a bundle takes the contract's rebate too
    const bundled = contractCharges({ startDate: "2026-01-01", endDate: "2026-12-31", billingPeriod: "monthly" }, linesForCharges({ name: "C", startDate: "2026-01-01", billingPeriod: "monthly", bundlePriceCents: 12000, bundleQuantity: 10, rebateBps: 2500 }, []));
    expect(bundled.perPeriodCents).toBe(10 * 9000);
  });

  it("take the contract's hourly rate down, and never bill an hours bank by the hour", () => {
    expect(hourlyRateOf({ billingMode: "hourly", hourlyRateCents: 12000, rebateBps: 1000 }, 115)).toBe(10800);
    expect(hourlyRateOf({ billingMode: "hourly", hourlyRateCents: null, rebateBps: 1000 }, 100)).toBe(9000);
    expect(hourlyRateOf({ billingMode: "hourly", hourlyRateCents: 0, rebateBps: 1000 }, 100)).toBeNull();
    expect(hourlyRateOf({ billingMode: "banked", hourlyRateCents: 12000, rebateBps: 0 }, 100)).toBeNull();
  });
});
