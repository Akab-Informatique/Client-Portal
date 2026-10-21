import { describe, expect, it } from "vitest";
import { decide } from "../server/lib/qbSync.ts";

const t = (n: number) => new Date(1_700_000_000_000 + n * 1000);

describe("QuickBooks sync: which way a changed record goes", () => {
  it("nothing differs → nothing", () => expect(decide({ portalAt: t(5), qbAt: t(9), syncedAt: t(1), differs: false })).toBe("none"));
  it("only the portal changed since the last sync → push", () => expect(decide({ portalAt: t(5), qbAt: t(1), syncedAt: t(2), differs: true })).toBe("push"));
  it("only QuickBooks changed → pull", () => expect(decide({ portalAt: t(1), qbAt: t(5), syncedAt: t(2), differs: true })).toBe("pull"));
  it("both changed → the latest wins", () => {
    expect(decide({ portalAt: t(8), qbAt: t(6), syncedAt: t(2), differs: true })).toBe("push");
    expect(decide({ portalAt: t(6), qbAt: t(8), syncedAt: t(2), differs: true })).toBe("pull");
  });
  it("never synced → the latest wins; differing with no change seen → QuickBooks", () => {
    expect(decide({ portalAt: t(8), qbAt: t(6), syncedAt: null, differs: true })).toBe("push");
    expect(decide({ portalAt: t(6), qbAt: null, syncedAt: null, differs: true })).toBe("push");
    expect(decide({ portalAt: t(1), qbAt: t(1), syncedAt: t(2), differs: true })).toBe("pull");
  });
});
