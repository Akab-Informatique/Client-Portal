import { describe, expect, it } from "vitest";
import { layout, planSms, byUrgency, type DayItem } from "../server/lib/pipeline.ts";

const S = { workStart: "08:00", workEnd: "17:00", lunchStart: "12:00", lunchEnd: "13:00" };
const item = (over: Partial<DayItem> & { key: string }): DayItem => ({ kind: "task", refId: over.key, title: over.key, priority: "normal", due: null, overdue: false, minutes: 60, ...over });

describe("pipeline: the day laid out in blocks", () => {
  it("fills the morning, skips lunch, splits what runs across it, and keeps what does not fit", () => {
    const lay = layout([item({ key: "a", minutes: 180 }), item({ key: "b", minutes: 120 }), item({ key: "c", minutes: 240 }), item({ key: "d", minutes: 120 })], S, []);
    expect(lay.capacityMinutes).toBe(480);
    const placed = lay.blocks.filter((b) => !b.overflow && b.kind === "task").map((b) => [b.refId, b.start, b.end]);
    expect(placed).toEqual([["a", "08:00", "11:00"], ["b", "11:00", "12:00"], ["b", "13:00", "14:00"], ["c", "14:00", "17:00"]]);
    // 60 min of c and all of d are left
    expect(lay.overflowMinutes).toBe(60 + 120);
    expect(lay.blocks.filter((b) => b.overflow).map((b) => b.refId)).toEqual(["c", "d"]);
    expect(lay.blocks.some((b) => b.kind === "break" && b.start === "12:00")).toBe(true);
  });

  it("replanning during the day lays the rest out from now on (the morning is not offered again)", () => {
    const lay = layout([item({ key: "a", minutes: 120 })], S, [], new Map(), 10 * 60 + 15);
    expect(lay.capacityMinutes).toBe(105 + 240);
    expect(lay.blocks.filter((b) => b.kind === "task").map((b) => [b.start, b.end])).toEqual([["10:15", "12:00"], ["13:00", "13:15"]]);
  });

  it("works around events", () => {
    const lay = layout([item({ key: "a", minutes: 120 })], S, [{ start: 9 * 60, end: 10 * 60, title: "Réunion" }]);
    expect(lay.capacityMinutes).toBe(420);
    expect(lay.blocks.filter((b) => b.kind === "task").map((b) => [b.start, b.end])).toEqual([["08:00", "09:00"], ["10:00", "11:00"]]);
    expect(lay.blocks.find((b) => b.kind === "event")).toMatchObject({ start: "09:00", end: "10:00", title: "Réunion" });
  });

  it("an item with a start time waits for it while the others fill the gap; all-day events take no hours", () => {
    const lay = layout([item({ key: "late-start", minutes: 60, notBefore: 10 * 60 }), item({ key: "b", minutes: 60 }), item({ key: "c", minutes: 120 })], S, [{ start: 0, end: 1440, title: "Congrès", allDay: true, o365: true }]);
    expect(lay.capacityMinutes).toBe(480);
    const placed = lay.blocks.filter((b) => b.kind === "task").map((b) => [b.refId, b.start, b.end]);
    // b fills 08:00–09:00, then c from 09:00 until the start time of the other, which starts at 10:00 or later
    expect(placed.find((p) => p[0] === "b")).toEqual(["b", "08:00", "09:00"]);
    const late = placed.find((p) => p[0] === "late-start")!;
    expect(String(late[1]) >= "10:00").toBe(true);
    expect(lay.blocks.find((b) => b.allDay)).toMatchObject({ title: "Congrès", o365: true, start: "" });
  });

  it("orders by lateness, then priority, then due date", () => {
    const list = [item({ key: "low", priority: "low" }), item({ key: "late", overdue: true, priority: "low", due: "2026-01-01" }), item({ key: "urgent", priority: "urgent" }), item({ key: "high", priority: "high" })];
    expect(list.sort(byUrgency).map((i) => i.key)).toEqual(["late", "urgent", "high", "low"]);
  });

  it("the morning text: counts, a few blocks, short", () => {
    const lay = layout([item({ key: "a", kind: "ticket", title: "Licence Adobe", ticketNumber: "T1", minutes: 45 }), item({ key: "b", title: "Appeler le fournisseur", minutes: 30 })], S, []);
    const sms = planSms("Jonathan Boisvert", { ...lay, plannedMinutes: lay.plannedMinutes }, "fr")!;
    expect(sms).toContain("Bonjour Jonathan");
    expect(sms).toContain("1 billet");
    expect(sms).toContain("1 tâche");
    expect(sms).toContain("08:00 Licence Adobe");
    expect(sms.length).toBeLessThan(320);
    expect(planSms("Jonathan", { blocks: [], capacityMinutes: 480, plannedMinutes: 0 }, "fr")).toBeNull();
    expect(planSms("Jonathan", lay, "en")).toContain("Good morning Jonathan");
  });
});
