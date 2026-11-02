import { describe, expect, it } from "vitest";
import { changedShare, ChangeWatcher, DEFAULT_WATCHER, GRID_H, GRID_W, toGray } from "../src/lib/sop/diff.ts";

const N = GRID_W * GRID_H;
/** A screen of one grey, with `n` cells of another */
const screen = (base: number, n = 0, other = 255) => {
  const g = new Uint8Array(N).fill(base);
  for (let i = 0; i < n; i++) g[i] = other;
  return g;
};

describe("noticing a change on the screen", () => {
  it("turns RGBA pixels into grey levels", () => {
    expect(Array.from(toGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255])))).toEqual([255, 0]);
  });

  it("counts the share of cells that really changed", () => {
    expect(changedShare(screen(10), screen(10))).toBe(0);
    expect(changedShare(screen(10), screen(10, N / 2))).toBeCloseTo(0.5);
    // a faint shade is not a change
    expect(changedShare(screen(10), screen(20))).toBe(0);
  });

  it("takes a step once the screen changed and then settled, never for a moving mouse", () => {
    const w = new ChangeWatcher();
    let t = 0;
    const look = (g: Uint8Array) => w.push(g, (t += 500));
    expect(look(screen(10))).toBe(false); // first look: nothing to compare with yet
    // the cursor moves over a cell or two: not a change
    for (let i = 0; i < 10; i++) expect(look(screen(10, 2))).toBe(false);
    // a page opens: a lot changes at once, but it is still moving, so not yet…
    expect(look(screen(10, N / 2))).toBe(false);
    expect(look(screen(10, N / 2 + 300))).toBe(false);
    // …then it stops moving: the step is taken once
    const taken: boolean[] = [];
    for (let i = 0; i < 6; i++) taken.push(look(screen(10, N / 2 + 300)));
    expect(taken.filter(Boolean)).toHaveLength(1);
    // the same screen afterwards is no new change
    for (let i = 0; i < 6; i++) expect(look(screen(10, N / 2 + 300))).toBe(false);
  });

  it("does not take two steps closer than the minimum gap", () => {
    const w = new ChangeWatcher({ ...DEFAULT_WATCHER, minGapMs: 5000 });
    let t = 0;
    const look = (g: Uint8Array) => w.push(g, (t += 500));
    look(screen(10));
    let firstAt = -1;
    let secondAt = -1;
    for (let i = 0; i < 40; i++) {
      // a different screen every four looks
      const fired = look(screen(10, N / 2 + (Math.floor(i / 4) % 2) * 400));
      if (fired && firstAt < 0) firstAt = t;
      else if (fired && secondAt < 0) secondAt = t;
    }
    expect(firstAt).toBeGreaterThan(0);
    expect(secondAt - firstAt).toBeGreaterThanOrEqual(5000);
  });

  it("a step taken by hand resets what the next change is compared with", () => {
    const w = new ChangeWatcher();
    let t = 0;
    w.reset(screen(10), 0);
    // the screen the person captured is now the reference: staying on it fires nothing
    for (let i = 0; i < 8; i++) expect(w.push(screen(10), (t += 500))).toBe(false);
  });
});
