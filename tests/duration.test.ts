import { describe, expect, it } from "vitest";
import { hm, parseHm } from "../shared/duration.ts";

describe("time entry durations (h:mm)", () => {
  it("reads h:mm, h, 1h15; refuses minutes over 59 and decimals", () => {
    expect(parseHm("1:15")).toBe(1.25);
    expect(parseHm("0:45")).toBe(0.75);
    expect(parseHm("1h15")).toBe(1.25);
    expect(parseHm("2")).toBe(2);
    expect(parseHm("1:20")).toBe(1.3333);
    expect(parseHm("1:60")).toBeNull();
    expect(parseHm("1.5")).toBeNull();
    expect(parseHm("")).toBeNull();
  });
  it("shows decimal hours as h:mm", () => {
    expect(hm(1.25)).toBe("1:15");
    expect(hm(0.0167)).toBe("0:01");
    expect(hm(1.3333)).toBe("1:20");
    expect(hm(0)).toBe("0:00");
  });
});
