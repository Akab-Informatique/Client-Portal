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
