import { ChangeWatcher, GRID_H, GRID_W, toGray } from "./diff";
import { shotFrom, type Shot } from "./image";

/**
 * Records a screen, a window or a browser tab (the browser asks which) and takes the steps of a procedure from it:
 * one when asked (a button, in the portal or in a small window that floats above every other application), one by
 * itself each time the screen changes and settles. Nothing leaves the browser until the person saves.
 *
 * A web page cannot see the mouse clicks made outside of it. So a step is a picture of the screen at a chosen moment
 * or after a change, and the person puts the pin on the click afterwards, in the editor.
 */
export type Step = { id: string; shot: Shot; url: string; at: number; source: "manual" | "auto" };

export type RecorderEvents = {
  /** A step was taken */
  step: (s: Step) => void;
  /** The sharing stopped (the person pressed the browser's "Stop sharing") */
  ended: () => void;
  /** Anything else changed (paused, automatic on / off, a step removed): redraw */
  change: () => void;
};

type ImageCaptureLike = { grabFrame(): Promise<ImageBitmap> };
type Clock = Pick<Window, "setInterval" | "clearInterval">;

const SAMPLE_MS = 500;

export class ScreenRecorder {
  steps: Step[] = [];
  auto = false;
  paused = false;
  /** monitor (the whole screen) | window | browser (a tab) — the picture of a whole screen also shows the floating window */
  surface: string | undefined;
  running = false;

  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private grabber: ImageCaptureLike | null = null;
  private video: HTMLVideoElement | null = null;
  private watcher = new ChangeWatcher();
  private grid = document.createElement("canvas");
  private clock: Clock = window;
  private timer: number | null = null;
  private busy = false;
  private media: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  constructor(private on: RecorderEvents) {
    this.grid.width = GRID_W;
    this.grid.height = GRID_H;
  }

  static supported() {
    return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia && typeof createImageBitmap === "function";
  }

  /** Ask which screen / window / tab to record (needs a click just before) and start watching it */
  async start(opts: { video: boolean; auto: boolean }) {
    // Chrome-only hints are passed through; other browsers ignore what they do not know
    const constraints = { video: { frameRate: { ideal: opts.video ? 15 : 5, max: 30 } }, audio: false, selfBrowserSurface: "exclude", surfaceSwitching: "include", monitorTypeSurfaces: "include" } as unknown as DisplayMediaStreamOptions;
    this.stream = await navigator.mediaDevices.getDisplayMedia(constraints);
    this.track = this.stream.getVideoTracks()[0];
    this.surface = (this.track.getSettings() as { displaySurface?: string }).displaySurface;
    this.track.addEventListener("ended", () => this.on.ended());
    const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => ImageCaptureLike }).ImageCapture;
    if (IC) this.grabber = new IC(this.track);
    // a hidden video is the fallback (and a check) when ImageCapture is not there
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = this.stream;
    this.video.style.cssText = "position:fixed;left:-9999px;width:2px;height:2px;opacity:0;pointer-events:none";
    document.body.appendChild(this.video);
    await this.video.play().catch(() => undefined);
    if (opts.video && typeof MediaRecorder !== "undefined") {
      const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
      this.media = new MediaRecorder(this.stream, mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000 } : undefined);
      this.media.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
      this.media.start(2000);
    }
    this.running = true;
    this.auto = opts.auto;
    this.timer = this.clock.setInterval(() => void this.tick(), SAMPLE_MS);
    this.on.change();
  }

  /**
   * Drive the watching from another window: a page in the background is slowed down by the browser, but a small
   * window that floats on screen (the floating controls) keeps its timers running.
   */
  useClock(w: Window | null) {
    if (this.timer !== null) this.clock.clearInterval(this.timer);
    this.clock = w ?? window;
    if (this.running) this.timer = this.clock.setInterval(() => void this.tick(), SAMPLE_MS);
  }

  setAuto(on: boolean) {
    this.auto = on;
    this.on.change();
  }
  setPaused(on: boolean) {
    this.paused = on;
    if (this.media?.state === "recording" && on) this.media.pause();
    else if (this.media?.state === "paused" && !on) this.media.resume();
    this.on.change();
  }

  /** The screen as a picture right now (the caller closes it) */
  private async frame(): Promise<{ src: CanvasImageSource; w: number; h: number; close: () => void } | null> {
    if (!this.track || this.track.readyState !== "live") return null;
    if (this.grabber) {
      try {
        const b = await this.grabber.grabFrame();
        return { src: b, w: b.width, h: b.height, close: () => b.close() };
      } catch {
        this.grabber = null;
      }
    }
    const v = this.video;
    if (v && v.videoWidth > 0) return { src: v, w: v.videoWidth, h: v.videoHeight, close: () => undefined };
    return null;
  }

  private grayOf(src: CanvasImageSource) {
    const ctx = this.grid.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(src, 0, 0, GRID_W, GRID_H);
    return toGray(ctx.getImageData(0, 0, GRID_W, GRID_H).data);
  }

  /** One look at the screen, to decide whether a step should be taken by itself */
  private async tick() {
    if (this.busy || this.paused || !this.running) return;
    this.busy = true;
    try {
      const f = await this.frame();
      if (!f) return;
      try {
        const gray = this.grayOf(f.src);
        // when automatic is off the baseline still follows the screen, so turning it on does not fire at once
        if (!this.auto) this.watcher.reset(gray, performance.now());
        else if (this.watcher.push(gray, performance.now())) await this.take("auto", f);
      } finally {
        f.close();
      }
    } finally {
      this.busy = false;
    }
  }

  private async take(source: Step["source"], f: { src: CanvasImageSource; w: number; h: number }) {
    const shot = await shotFrom(f.src, f.w, f.h);
    const step: Step = { id: crypto.randomUUID(), shot, url: URL.createObjectURL(shot.blob), at: Date.now(), source };
    this.steps.push(step);
    this.on.step(step);
    this.on.change();
    return step;
  }

  /** Take a step now, by hand */
  async capture(): Promise<Step | null> {
    if (this.paused || !this.running) return null;
    const f = await this.frame();
    if (!f) return null;
    try {
      this.watcher.reset(this.grayOf(f.src), performance.now());
      return await this.take("manual", f);
    } finally {
      f.close();
    }
  }

  removeStep(id: string) {
    const s = this.steps.find((x) => x.id === id);
    if (s) URL.revokeObjectURL(s.url);
    this.steps = this.steps.filter((x) => x.id !== id);
    this.on.change();
  }

  /** Stop sharing. Gives the video when one was recorded; the steps stay in `steps` */
  async stop(): Promise<Blob | null> {
    this.running = false;
    if (this.timer !== null) this.clock.clearInterval(this.timer);
    this.timer = null;
    let video: Blob | null = null;
    if (this.media && this.media.state !== "inactive") {
      const m = this.media;
      video = await new Promise<Blob | null>((resolve) => {
        m.onstop = () => resolve(this.chunks.length ? new Blob(this.chunks, { type: m.mimeType || "video/webm" }) : null);
        m.stop();
      });
    }
    this.media = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.video?.remove();
    this.video = null;
    this.stream = null;
    this.track = null;
    this.grabber = null;
    this.on.change();
    return video;
  }

  /** Free the pictures kept for the thumbnails */
  dispose() {
    this.steps.forEach((s) => URL.revokeObjectURL(s.url));
    this.steps = [];
  }
}

/* ------------------------------------------------------------------ floating controls */

export type FloatLabels = { capture: string; pause: string; resume: string; stop: string; auto: string; steps: (n: number) => string; taken: (n: number) => string; paused: string; hint: string };

type PipApi = { requestWindow(o?: { width?: number; height?: number; disallowReturnToOpener?: boolean }): Promise<Window> };
const pipApi = () => (window as unknown as { documentPictureInPicture?: PipApi }).documentPictureInPicture;

export const floatingSupported = () => !!pipApi();

export type Floating = { win: Window; refresh(): void; flash(n: number): void; close(): void };

/**
 * A small window that stays above every other application (Chrome and Edge): the button to take a step, pause,
 * automatic on / off and stop. Plain DOM with its own inline styles, so it does not depend on the page's styles.
 */
export async function openFloating(rec: ScreenRecorder, L: FloatLabels, h: { stop: () => void; closed: () => void }): Promise<Floating | null> {
  const api = pipApi();
  if (!api) return null;
  const win = await api.requestWindow({ width: 330, height: 172, disallowReturnToOpener: true });
  const d = win.document;
  d.title = "AKAB";
  const style = d.createElement("style");
  style.textContent = `
    *{box-sizing:border-box;font-family:Instrument Sans,Segoe UI,system-ui,sans-serif}
    body{margin:0;background:#0a0a0b;color:#f4f4f1;padding:10px;display:flex;flex-direction:column;gap:8px;height:100vh}
    .row{display:flex;gap:6px;align-items:center}
    .rec{display:flex;align-items:center;gap:6px;font-size:12px;color:#c9c9c4;flex:1}
    .dot{width:9px;height:9px;border-radius:50%;background:#ef4444;animation:p 1.4s infinite}
    .paused .dot{animation:none;background:#a3a3a3}
    @keyframes p{50%{opacity:.35}}
    button{cursor:pointer;border:1px solid #3a3a3d;background:#1a1a1d;color:#f4f4f1;border-radius:8px;padding:6px 9px;font-size:12px}
    button:hover{background:#26262a}
    button.big{flex:1;padding:11px;font-size:15px;font-weight:700;border:0;color:#0a0a0b;background:linear-gradient(135deg,#ffe24a,#ffce1a 55%,#f59410)}
    button.big:disabled{opacity:.5;cursor:default}
    button.on{border-color:#ffce1a;color:#ffce1a}
    .hint{font-size:10.5px;color:#8d8d88;line-height:1.3}
    .flash{color:#4ade80;font-size:12px;height:14px}
  `;
  d.head.appendChild(style);
  const root = d.createElement("div");
  root.style.cssText = "display:contents";
  d.body.appendChild(root);

  let flashText = "";
  const el = (tag: string, cls?: string, text?: string) => {
    const e = d.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  };
  const draw = () => {
    root.replaceChildren();
    const top = el("div", `row rec${rec.paused ? " paused" : ""}`);
    top.append(el("span", "dot"), el("span", "", rec.paused ? L.paused : L.steps(rec.steps.length)));
    const grab = el("button", "big", L.capture) as HTMLButtonElement;
    grab.disabled = rec.paused;
    grab.onclick = () => void rec.capture();
    const bar = el("div", "row");
    const auto = el("button", rec.auto ? "on" : "", L.auto);
    auto.onclick = () => rec.setAuto(!rec.auto);
    const pause = el("button", "", rec.paused ? L.resume : L.pause);
    pause.onclick = () => rec.setPaused(!rec.paused);
    const stop = el("button", "", L.stop);
    stop.style.marginLeft = "auto";
    stop.onclick = h.stop;
    bar.append(auto, pause, stop);
    root.append(top, el("div", "row"), el("div", "flash", flashText), bar, el("div", "hint", L.hint));
    root.children[1].append(grab);
  };
  draw();
  // space takes a step while this window has the focus
  win.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !e.repeat) {
      e.preventDefault();
      void rec.capture();
    }
  });
  win.addEventListener("pagehide", h.closed);
  rec.useClock(win);

  return {
    win,
    refresh: draw,
    flash(n) {
      flashText = L.taken(n);
      draw();
      win.setTimeout(() => {
        flashText = "";
        draw();
      }, 1200);
    },
    close() {
      win.removeEventListener("pagehide", h.closed);
      rec.useClock(null);
      win.close();
    },
  };
}
