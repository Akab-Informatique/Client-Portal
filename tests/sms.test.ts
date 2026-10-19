import { describe, expect, it, vi } from "vitest";
import { smsPartCount, splitSms, SMS_GSM_MAX, SMS_UNICODE_MAX } from "../shared/sms.ts";

/** Units one part takes, as a phone counts them */
const units = (s: string) => [...s].reduce((n, ch) => n + ("^{}\\[~]|€".includes(ch) ? 2 : 1), 0);

describe("text message length (VoIP.ms)", () => {
  it("plain text: 160 per text", () => {
    const text = "Bonjour, le technicien passe demain matin vers 9 h. Merci de laisser la porte ouverte. ".repeat(3).trim();
    const parts = splitSms(text);
    expect(parts.length).toBe(2);
    expect(parts.every((p) => p.length <= SMS_GSM_MAX)).toBe(true);
    expect(parts.join(" ")).toBe(text);
    expect(splitSms("Merci!")).toEqual(["Merci!"]);
  });

  it("one character outside the SMS alphabet (ê, ’, emoji…): 70 per text", () => {
    // 100 characters with a "ê": one text for 160, but VoIP.ms refuses it as too long
    const text = "Votre poste est prêt, vous pouvez venir le chercher au bureau de Joliette dès demain matin, merci";
    expect(text.length).toBeLessThanOrEqual(SMS_GSM_MAX);
    const parts = splitSms(text);
    expect(parts.length).toBe(2);
    expect(parts.every((p) => p.length <= SMS_UNICODE_MAX)).toBe(true);
    expect(parts.join(" ")).toBe(text);
    expect(smsPartCount("C’est réglé 👍")).toBe(1);
    // an emoji takes two units, and is never cut in half
    const emoji = "👍".repeat(40);
    expect(splitSms(emoji).every((p) => p.length <= SMS_UNICODE_MAX && !/[\uD800-\uDBFF]$/.test(p))).toBe(true);
    expect(splitSms(emoji).join("")).toBe(emoji);
  });

  it("é, è, à, ù and Ç are in the SMS alphabet; € [ ] take two", () => {
    expect(splitSms("é".repeat(160))).toHaveLength(1);
    const brackets = "[x]".repeat(60);
    expect(splitSms(brackets).every((p) => units(p) <= SMS_GSM_MAX)).toBe(true);
    expect(smsPartCount("")).toBe(1);
  });
});

describe("text message parts (VoIP.ms)", () => {
  it("go out in order, with a pause between them, and two messages to one number never mix", async () => {
    process.env.NODE_ENV = "test";
    const { initDb, db, schema } = await import("../server/db/index.ts");
    await initDb({ memory: true });
    const { saveSmsSettings, sendSms, setSmsPartDelay } = await import("../server/lib/voipms.ts");
    await saveSmsSettings(null, { enabled: true, username: "a@akab.ca", password: "x", did: "4505559000", longAsMms: false });
    const sent: { message: string; at: number }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        sent.push({ message: new URL(String(url)).searchParams.get("message") ?? "", at: Date.now() });
        return new Response(JSON.stringify({ status: "success" }), { headers: { "content-type": "application/json" } });
      }),
    );
    setSmsPartDelay(60);
    try {
      const long = "Votre poste est prêt, vous pouvez venir le chercher au bureau de Joliette dès demain matin, merci";
      await Promise.all([sendSms("5145550001", long), sendSms("5145550001", "Deuxième message")]);
      expect(sent.map((s) => s.message)).toEqual([...splitSms(long), "Deuxième message"]);
      // a pause between the parts of one message
      expect(sent[1].at - sent[0].at).toBeGreaterThanOrEqual(55);
    } finally {
      setSmsPartDelay(0);
      vi.unstubAllGlobals();
      await db().delete(schema.integrations);
    }
  });
});

describe("long texts as MMS (VoIP.ms)", () => {
  it("one MMS when on; refused by VoIP.ms: split texts; a network error is not sent twice", async () => {
    process.env.NODE_ENV = "test";
    const { initDb, db, schema } = await import("../server/db/index.ts");
    await initDb({ memory: true });
    const { saveSmsSettings, sendSms } = await import("../server/lib/voipms.ts");
    await saveSmsSettings(null, { enabled: true, username: "a@akab.ca", password: "x", did: "4505559000", longAsMms: true });
    let mms: "ok" | "refused" | "down" = "ok";
    const sent: { method: string; message: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const p = new URL(String(url)).searchParams;
        const method = p.get("method") ?? "";
        if (method === "sendMMS" && mms === "down") throw new TypeError("fetch failed");
        if (method === "sendMMS" && mms === "refused") return new Response(JSON.stringify({ status: "invalid_did" }), { headers: { "content-type": "application/json" } });
        sent.push({ method, message: p.get("message") ?? "" });
        return new Response(JSON.stringify({ status: "success" }), { headers: { "content-type": "application/json" } });
      }),
    );
    const long = "Votre poste est prêt, vous pouvez venir le chercher au bureau de Joliette dès demain matin, merci";
    try {
      await sendSms("5145550002", long);
      expect(sent).toEqual([{ method: "sendMMS", message: long }]);
      // a short one stays a text
      sent.length = 0;
      await sendSms("5145550002", "Merci!");
      expect(sent).toEqual([{ method: "sendSMS", message: "Merci!" }]);
      // MMS refused (not on our number): split texts
      sent.length = 0;
      mms = "refused";
      await sendSms("5145550002", long);
      expect(sent.map((s) => s.method)).toEqual(splitSms(long).map(() => "sendSMS"));
      // VoIP.ms unreachable: an error, not a second copy as texts
      sent.length = 0;
      mms = "down";
      await expect(sendSms("5145550002", long)).rejects.toThrow();
      expect(sent).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      await db().delete(schema.integrations);
    }
  });
});
