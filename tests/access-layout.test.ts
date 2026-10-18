import { describe, expect, it } from "vitest";
import { ACCESS_LAYOUT, MODULES } from "../shared/permissions.ts";

describe("roles and access laid out like the sidebar", () => {
  it("shows every module exactly once, in a section of its own audience", () => {
    const placed = ACCESS_LAYOUT.flatMap((s) => s.modules.map((m) => ({ m, audience: s.audience })));
    expect(placed.map((p) => p.m).sort()).toEqual(MODULES.map((m) => m.key).sort());
    for (const p of placed) expect(MODULES.find((m) => m.key === p.m)!.audience).toBe(p.audience);
  });
});
