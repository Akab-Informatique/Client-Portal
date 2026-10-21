import { describe, expect, it } from "vitest";
import { nextAfter, nextOccurrence } from "../shared/recurrence.ts";

describe("recurring tasks", () => {
  it("daily, weekly (with weekdays), monthly and yearly", () => {
    expect(nextOccurrence("2026-10-20", { freq: "daily", interval: 3 })).toBe("2026-10-23");
    expect(nextOccurrence("2026-10-20", { freq: "weekly", interval: 2 })).toBe("2026-11-03");
    // Tuesday 20 Oct; Mon / Wed / Fri chosen: Wednesday the 21st, then Friday, then Monday the next week
    const w = { freq: "weekly", interval: 1, weekdays: [1, 3, 5] } as const;
    expect(nextOccurrence("2026-10-20", w)).toBe("2026-10-21");
    expect(nextOccurrence("2026-10-21", w)).toBe("2026-10-23");
    expect(nextOccurrence("2026-10-23", w)).toBe("2026-10-26");
    // every 2 weeks on Monday: from a Monday, two weeks on
    expect(nextOccurrence("2026-10-19", { freq: "weekly", interval: 2, weekdays: [1] })).toBe("2026-11-02");
    expect(nextOccurrence("2026-01-31", { freq: "monthly", interval: 1 })).toBe("2026-02-28");
    expect(nextOccurrence("2028-01-31", { freq: "monthly", interval: 1 })).toBe("2028-02-29");
    expect(nextOccurrence("2026-10-20", { freq: "yearly", interval: 1 })).toBe("2027-10-20");
    expect(nextOccurrence("2028-02-29", { freq: "yearly", interval: 1 })).toBe("2029-02-28");
  });

  it("stops at the end day, and a task completed late comes back after today", () => {
    expect(nextOccurrence("2026-10-20", { freq: "daily", interval: 1, until: "2026-10-20" })).toBeNull();
    expect(nextAfter("2026-10-01", "2026-10-20", { freq: "weekly", interval: 1 })).toBe("2026-10-22");
    expect(nextAfter("2026-10-01", "2026-10-20", { freq: "monthly", interval: 1 })).toBe("2026-11-01");
    expect(nextAfter("2026-10-01", "2026-10-20", { freq: "daily", interval: 1, until: "2026-10-10" })).toBeNull();
  });
});
