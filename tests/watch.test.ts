import { describe, expect, it } from "vitest";
import { isStale, watchDays, workingDaysBetween } from "../shared/watch.ts";

describe("the no-activity reminder", () => {
  it("counts working days only: weekends do not count", () => {
    // Friday 2026-11-13 → Monday 2026-11-16 is one working day
    expect(workingDaysBetween("2026-11-13", "2026-11-16")).toBe(1);
    expect(workingDaysBetween("2026-11-13", "2026-11-14")).toBe(0);
    expect(workingDaysBetween("2026-11-09", "2026-11-13")).toBe(4);
    expect(workingDaysBetween("2026-11-13", "2026-11-13")).toBe(0);
  });

  it("3 working days by default, 6 when the due day is more than 3 weeks away, its own when set", () => {
    const today = "2026-11-13";
    expect(watchDays(null, today)).toBe(3);
    expect(watchDays("2026-11-20", today)).toBe(3);
    expect(watchDays("2026-12-04", today)).toBe(3); // exactly 21 days
    expect(watchDays("2026-12-05", today)).toBe(6);
    expect(watchDays("2026-12-05", today, 4)).toBe(4);
    expect(watchDays("2026-11-20", today, 10)).toBe(10);
  });

  it("flashes after the delay, and a weekend never makes it flash", () => {
    // last activity Thursday: Friday = 1, Monday = 2, Tuesday = 3
    expect(isStale("2026-11-12", "2026-11-13", 3)).toBe(false);
    expect(isStale("2026-11-12", "2026-11-16", 3)).toBe(false);
    expect(isStale("2026-11-12", "2026-11-17", 3)).toBe(true);
    // last activity Friday, today Sunday: nothing counted yet
    expect(isStale("2026-11-13", "2026-11-15", 1)).toBe(false);
  });
});
