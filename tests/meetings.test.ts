import { describe, expect, it } from "vitest";
import { fridayDate, fridayEnd } from "../server/routes/meetings.ts";

describe("weekly meeting: end of Friday (Québec time)", () => {
  it("is this week's Friday on weekdays and the coming one on weekends", () => {
    const fri = (iso: string) => fridayEnd(new Date(iso)).toISOString();
    // Monday 19 Oct 2026, 9:00 in Québec → Friday 23 Oct, 23:59:59.999 (-05:00)
    expect(fri("2026-10-19T13:00:00Z")).toBe("2026-10-24T04:59:59.999Z");
    // Friday evening is still that Friday
    expect(fri("2026-10-23T23:00:00Z")).toBe("2026-10-24T04:59:59.999Z");
    // Saturday and Sunday → the next Friday
    expect(fri("2026-10-24T15:00:00Z")).toBe("2026-10-31T04:59:59.999Z");
    expect(fri("2026-10-25T15:00:00Z")).toBe("2026-10-31T04:59:59.999Z");
    // Sunday 23:30 in Québec is already Monday in UTC: still the coming Friday
    expect(fri("2026-10-26T03:30:00Z")).toBe("2026-10-31T04:59:59.999Z");
    expect(fridayDate(new Date("2026-10-23T23:00:00Z"))).toBe("2026-10-23");
  });
});

import { holidaysBetween, quebecHolidays } from "../shared/holidays.ts";

describe("Quebec holidays", () => {
  const dates = (y: number) => Object.fromEntries(quebecHolidays(y).map((h) => [h.key, h.date]));
  it("are right for 2026 and 2025", () => {
    expect(dates(2026)).toEqual({
      newYear: "2026-01-01",
      goodFriday: "2026-04-03",
      easterMonday: "2026-04-06",
      // May 25 is a Monday: the Monday before it
      patriots: "2026-05-18",
      stJean: "2026-06-24",
      canada: "2026-07-01",
      labour: "2026-09-07",
      thanksgiving: "2026-10-12",
      christmas: "2026-12-25",
    });
    expect(dates(2025)).toMatchObject({ goodFriday: "2025-04-18", easterMonday: "2025-04-21", patriots: "2025-05-19", labour: "2025-09-01", thanksgiving: "2025-10-13" });
  });
  it("move June 24 and July 1 from a Sunday to the Monday", () => {
    expect(dates(2029)).toMatchObject({ stJean: "2029-06-25", canada: "2029-07-02" });
    expect(dates(2018).stJean).toBe("2018-06-25");
  });
  it("can be listed across years", () => {
    expect([...holidaysBetween("2026-12-20", "2027-01-05").entries()]).toEqual([
      ["2026-12-25", "christmas"],
      ["2027-01-01", "newYear"],
    ]);
  });
});
