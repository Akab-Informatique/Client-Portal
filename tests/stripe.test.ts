import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySignature } from "../server/lib/stripe.ts";

describe("Stripe webhook signature", () => {
  const secret = "whsec_abc123";
  const body = '{"id":"evt_1","type":"checkout.session.completed"}';
  const sign = (t: number, b = body, s = secret) => crypto.createHmac("sha256", s).update(`${t}.${b}`).digest("hex");
  const now = 1_800_000_000_000;
  const t = now / 1000;

  it("accepts the right signature within five minutes", () => {
    expect(verifySignature(body, `t=${t},v1=${sign(t)}`, secret, now)).toBe(true);
    expect(verifySignature(body, `t=${t - 299},v1=${sign(t - 299)}`, secret, now)).toBe(true);
  });

  it("accepts one good signature among several (a rolled secret) and ignores v0", () => {
    expect(verifySignature(body, `t=${t},v1=${sign(t, body, "whsec_old")},v1=${sign(t)},v0=00`, secret, now)).toBe(true);
    expect(verifySignature(body, `t=${t},v0=${sign(t)}`, secret, now)).toBe(false);
  });

  it("refuses a changed body, another secret, a replay, and junk", () => {
    expect(verifySignature(body + " ", `t=${t},v1=${sign(t)}`, secret, now)).toBe(false);
    expect(verifySignature(body, `t=${t},v1=${sign(t, body, "whsec_other")}`, secret, now)).toBe(false);
    expect(verifySignature(body, `t=${t - 301},v1=${sign(t - 301)}`, secret, now)).toBe(false);
    expect(verifySignature(body, `t=${t + 301},v1=${sign(t + 301)}`, secret, now)).toBe(false);
    for (const h of [undefined, "", "t=abc,v1=00", `t=${t}`, `t=${t},v1=`, `t=${t},v1=zz`, `v1=${sign(t)}`]) expect(verifySignature(body, h, secret, now)).toBe(false);
  });
});
