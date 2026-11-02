/**
 * Noticing that "something happened on the screen": the picture is shrunk to a small grid of grey cells and compared
 * with the one before. A moving mouse or a blinking cursor touches a cell or two; a page that opens, a window that
 * appears or a menu that drops down touches many. Pure functions, so they are tested without a screen.
 */
export const GRID_W = 64;
export const GRID_H = 36;

/** The grey level of every cell from RGBA pixels of a GRID_W × GRID_H picture */
export function toGray(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.floor(rgba.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
  return out;
}

/** The share (0–1) of cells that differ by more than `threshold` grey levels */
export function changedShare(a: Uint8Array, b: Uint8Array, threshold = 24): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let changed = 0;
  for (let i = 0; i < n; i++) if (Math.abs(a[i] - b[i]) > threshold) changed++;
  return changed / n;
}

export type WatcherOptions = {
  /** Share of cells that must differ from the last step to count as a change (the mouse alone never does) */
  change: number;
  /** The screen counts as settled once it moved less than this between two looks… */
  still: number;
  /** …for this long (ms) */
  settleMs: number;
  /** Never two steps closer than this (ms) */
  minGapMs: number;
};
export const DEFAULT_WATCHER: WatcherOptions = { change: 0.02, still: 0.004, settleMs: 900, minGapMs: 1500 };

/**
 * Decides when to take a step by itself: when the screen changed from the last step and then stopped moving
 * (a page that finished loading, a dialog that is now open), not while it is still animating.
 */
export class ChangeWatcher {
  private baseline: Uint8Array | null = null;
  private previous: Uint8Array | null = null;
  private changing = false;
  private stillSince = 0;
  private lastCaptureAt = -Infinity;
  constructor(private o: WatcherOptions = DEFAULT_WATCHER) {}

  /** The screen as it is at the moment a step is taken (by hand or by itself): what the next change is compared with */
  reset(gray: Uint8Array, now: number) {
    this.baseline = gray;
    this.previous = gray;
    this.changing = false;
    this.lastCaptureAt = now;
  }

  /** One look at the screen: true when a step should be taken now */
  push(gray: Uint8Array, now: number): boolean {
    if (!this.baseline) {
      this.reset(gray, now - this.o.minGapMs);
      return false;
    }
    const prev = this.previous ?? gray;
    this.previous = gray;
    if (changedShare(gray, this.baseline) >= this.o.change) {
      if (!this.changing) {
        this.changing = true;
        this.stillSince = now;
      }
      if (changedShare(gray, prev) > this.o.still) this.stillSince = now;
      if (now - this.stillSince >= this.o.settleMs && now - this.lastCaptureAt >= this.o.minGapMs) {
        this.reset(gray, now);
        return true;
      }
    } else {
      this.changing = false;
    }
    return false;
  }
}
