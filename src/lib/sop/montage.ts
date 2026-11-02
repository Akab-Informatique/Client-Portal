import logoUrl from "@/assets/akab-logo.webp";

/**
 * A quick automatic edit of a recording, made in the browser: the AKAB logo on black (with the procedure's name), a
 * cross-fade into the recording, a cross-fade out, then the logo and a thank-you. The recording is played into a canvas
 * and the canvas is filmed again, so it takes as long as the recording lasts (plus the intro and the end): the page has
 * to stay in front. Nothing is uploaded.
 */
export type MontageOptions = {
  title: string;
  thanks: string;
  /** Under the thank-you */
  site: string;
  onProgress?: (share: number) => void;
  signal?: AbortSignal;
};

const INTRO_S = 2.6;
const FADE_S = 0.7;
const OUTRO_S = 3.6;
const FPS = 30;

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("logo"));
    img.src = src;
  });

/** A webm made by MediaRecorder has no length written in it: ask for the end to learn it */
async function probe(v: HTMLVideoElement): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    v.onloadedmetadata = () => resolve();
    v.onerror = () => reject(new Error("video"));
  });
  if (Number.isFinite(v.duration) && v.duration > 0) return v.duration;
  await new Promise<void>((resolve) => {
    v.ontimeupdate = () => {
      v.ontimeupdate = null;
      resolve();
    };
    v.currentTime = 1e9;
  });
  const d = v.duration;
  v.currentTime = 0;
  await new Promise<void>((resolve) => {
    v.onseeked = () => resolve();
  });
  return Number.isFinite(d) && d > 0 ? d : 0;
}

const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export async function makeMontage(recording: Blob, o: MontageOptions): Promise<Blob> {
  const logo = await loadImage(logoUrl);
  const url = URL.createObjectURL(recording);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    const length = await probe(video);
    if (!length) throw new Error("video");
    const w = Math.max(320, (video.videoWidth || 1280) & ~1);
    const h = Math.max(180, (video.videoHeight || 720) & ~1);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d")!;

    // the timeline, in seconds: intro, then the recording starts while the intro fades, then the end
    const videoStart = INTRO_S - FADE_S;
    const videoEnd = videoStart + length;
    const outroStart = videoEnd - FADE_S;
    const total = outroStart + OUTRO_S;

    const drawLogo = (alpha: number, y: number, scale: number) => {
      const lw = Math.min(w * 0.5, 900) * scale;
      const lh = (lw * logo.height) / logo.width;
      g.globalAlpha = alpha;
      g.drawImage(logo, (w - lw) / 2, y - lh / 2, lw, lh);
      g.globalAlpha = 1;
    };
    const text = (s: string, y: number, size: number, alpha: number, color = "#f4f4f1") => {
      g.globalAlpha = alpha;
      g.fillStyle = color;
      g.font = `600 ${size}px "Instrument Sans", "Segoe UI", system-ui, sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      // a long name wraps on two lines at most
      const words = s.split(" ");
      const lines: string[] = [];
      let line = "";
      for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (g.measureText(next).width > w * 0.8 && line) {
          lines.push(line);
          line = word;
        } else line = next;
      }
      lines.push(line);
      lines.slice(0, 2).forEach((l, i) => g.fillText(l, w / 2, y + i * size * 1.25));
      g.globalAlpha = 1;
    };
    const black = () => {
      g.globalAlpha = 1;
      g.fillStyle = "#0a0a0b";
      g.fillRect(0, 0, w, h);
    };

    const frame = (t: number) => {
      black();
      // intro: logo grows slightly while it appears, the name comes after it
      if (t < INTRO_S) {
        const a = ease(t / 0.8) * (1 - ease((t - (INTRO_S - FADE_S)) / FADE_S));
        drawLogo(a, h * 0.42, 0.92 + 0.08 * ease(t / 1.6));
        text(o.title, h * 0.66, Math.round(h * 0.05), ease((t - 0.7) / 0.6) * (1 - ease((t - (INTRO_S - FADE_S)) / FADE_S)));
      }
      // the recording, cross-faded in and out
      if (t >= videoStart && t < videoEnd + 0.05 && video.readyState >= 2) {
        const a = ease((t - videoStart) / FADE_S) * (1 - ease((t - outroStart) / FADE_S));
        g.globalAlpha = a;
        g.drawImage(video, 0, 0, w, h);
        g.globalAlpha = 1;
      }
      // the end: logo, thank-you, the address
      if (t >= outroStart) {
        const k = t - outroStart;
        const a = ease((k - 0.15) / 0.8);
        drawLogo(a, h * 0.38, 0.92 + 0.08 * ease(k / 1.6));
        text(o.thanks, h * 0.6, Math.round(h * 0.075), ease((k - 0.6) / 0.7), "#ffce1a");
        text(o.site, h * 0.72, Math.round(h * 0.035), ease((k - 1.2) / 0.7), "#a8a8a3");
      }
    };

    const stream = canvas.captureStream(FPS);
    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 4_000_000 } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise<Blob>((resolve) => {
      rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || "video/webm" }));
    });

    frame(0);
    rec.start(1000);
    const t0 = performance.now();
    let started = false;
    await new Promise<void>((resolve, reject) => {
      // a worker keeps the beat when the page is in the background (a page timer would drop to once a second)
      let worker: Worker | null = null;
      let timer = 0;
      const stopTick = () => {
        worker?.terminate();
        window.clearInterval(timer);
      };
      const tick = () => {
        if (o.signal?.aborted) {
          stopTick();
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        const t = (performance.now() - t0) / 1000;
        if (!started && t >= videoStart) {
          started = true;
          video.currentTime = 0;
          void video.play().catch(() => undefined);
        }
        frame(Math.min(t, total));
        o.onProgress?.(Math.min(1, t / total));
        if (t >= total) {
          stopTick();
          resolve();
        }
      };
      try {
        worker = new Worker("/ticker.js");
        worker.onmessage = tick;
        worker.postMessage(Math.round(1000 / FPS));
      } catch {
        timer = window.setInterval(tick, 1000 / FPS);
      }
    }).catch((e) => {
      if (rec.state !== "inactive") rec.stop();
      throw e;
    });
    rec.stop();
    stream.getTracks().forEach((tr) => tr.stop());
    return await done;
  } finally {
    video.pause();
    video.removeAttribute("src");
    URL.revokeObjectURL(url);
  }
}
