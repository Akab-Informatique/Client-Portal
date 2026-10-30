import { describe, expect, it } from "vitest";
import { ruled } from "../server/lib/billables.ts";
import { NO_CONTRACT_HOURLY_CENTS } from "../server/lib/contracts.ts";

describe("time under no contract", () => {
  it("is billed 100 $ an hour and is never approved by a rule", () => {
    expect(NO_CONTRACT_HOURLY_CENTS).toBe(10_000);
    const client = { invoice: { autoApprove: ["labour", "charge"] } } as never;
    // no contract at all: the client's rule does not approve the hours — someone does
    expect(ruled({ kind: "labour", contractId: null }, client, new Set(), false)).toBe(false);
    // the client has a default contract, or the time is under one: the rules apply as before
    expect(ruled({ kind: "labour", contractId: null }, client, new Set(), true)).toBe(true);
    expect(ruled({ kind: "labour", contractId: "k1" }, { invoice: null } as never, new Set(["k1"]), false)).toBe(true);
    // other kinds are not concerned
    expect(ruled({ kind: "charge", contractId: null }, client, new Set(), false)).toBe(true);
  });
});
