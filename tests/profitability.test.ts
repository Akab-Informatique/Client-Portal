import { describe, expect, it } from "vitest";
import { profitLevel } from "../shared/profitability.ts";

describe("how profitable a client is", () => {
  it("reads the margin: loss, weak, fair, healthy", () => {
    expect(profitLevel(-5, 100)).toBe("loss");
    expect(profitLevel(0, 100)).toBe("weak");
    expect(profitLevel(24.9, 100)).toBe("weak");
    expect(profitLevel(25, 100)).toBe("fair");
    expect(profitLevel(45, 100)).toBe("healthy");
    // nothing billed but time spent is a loss; nothing at all says nothing
    expect(profitLevel(null, 5000)).toBe("loss");
    expect(profitLevel(null, 0)).toBeNull();
  });
});
