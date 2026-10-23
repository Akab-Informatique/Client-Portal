import { describe, expect, it } from "vitest";
import { chargesOn, contractCharges } from "../shared/contractCharges.ts";

const term = { startDate: "2026-01-01", endDate: "2026-12-31" };
const line = (id: string, kind: "recurring" | "recurring_yearly", priceCents: number, addedOn: string, quantity = 1) => ({ id, name: id, kind, priceCents, quantity, addedOn });

describe("contract charges", () => {
  it("monthly contract: a charge on the 1st of each month, a service added mid-month charged on its day for the days left", () => {
    const ch = contractCharges({ ...term, billingPeriod: "monthly" }, [line("a", "recurring", 10_000, "2026-01-01", 2), line("b", "recurring", 3_100, "2026-03-16")]);
    // 12 months of a (2 x 100 $), b from 16 March: 16/31 of March, then full months
    const march = ch.entries.filter((e) => e.date.startsWith("2026-03"));
    expect(march.map((e) => [e.date, e.amountCents, e.prorated])).toEqual([
      ["2026-03-01", 20_000, false],
      ["2026-03-16", 1_600, true],
    ]);
    expect(ch.entries.find((e) => e.date === "2026-04-01")!.amountCents).toBe(23_100);
    expect(ch.revenueCents).toBe(12 * 20_000 + 1_600 + 9 * 3_100);
    expect(ch.perPeriodCents).toBe(23_100);
    expect(ch.yearlyExtraCents).toBe(0);
  });

  it("yearly contract: one charge per contract year; a service added later is charged on its day for what is left of the year", () => {
    const ch = contractCharges({ ...term, billingPeriod: "yearly" }, [line("a", "recurring", 1_000, "2026-01-01"), line("y", "recurring_yearly", 36_500, "2026-01-01"), line("b", "recurring", 1_000, "2026-07-01")]);
    expect(ch.entries.map((e) => [e.date, e.amountCents])).toEqual([
      ["2026-01-01", 12_000 + 36_500],
      ["2026-07-01", 6_000],
    ]);
    expect(ch.entries[1].prorated).toBe(false);
    expect(ch.perPeriodCents).toBe(12 * 1_000 + 12 * 1_000 + 36_500);
  });

  it("a yearly service on a monthly contract is its own yearly charge; a stopped contract charges until the day it was stopped", () => {
    const ch = contractCharges({ ...term, endedOn: "2026-06-15", billingPeriod: "monthly" }, [line("a", "recurring", 3_000, "2026-01-01"), line("y", "recurring_yearly", 36_500, "2026-01-01")]);
    expect(ch.endsOn).toBe("2026-06-15");
    expect(ch.entries.find((e) => e.date === "2026-01-01")!.amountCents).toBe(3_000 + Math.round((36_500 * 166) / 365));
    // the last month is prorated: 15 of 30 days
    const june = ch.entries.find((e) => e.date === "2026-06-01")!;
    expect(june.amountCents).toBe(1_500);
    expect(june.prorated).toBe(true);
    expect(ch.entries.some((e) => e.date > "2026-06-15")).toBe(false);
    expect(ch.yearlyExtraCents).toBe(36_500);
  });

  it("what is due and what comes next; nothing without a term; a line outside the term is left out", () => {
    const ch = contractCharges({ ...term, billingPeriod: "monthly" }, [line("a", "recurring", 1_000, "2026-01-01"), line("late", "recurring", 1_000, "2027-02-01")]);
    const on = chargesOn(ch, "2026-03-10");
    expect(on.due).toHaveLength(3);
    expect(on.dueCents).toBe(3_000);
    expect(on.next?.date).toBe("2026-04-01");
    expect(contractCharges({ startDate: null, endDate: null, billingPeriod: "monthly" }, [line("a", "recurring", 1_000, "2026-01-01")]).entries).toEqual([]);
    expect(chargesOn(ch, "2027-01-01").next).toBeNull();
  });
});
