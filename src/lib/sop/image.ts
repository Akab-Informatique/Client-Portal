/** Pictures of steps, prepared in the browser: always a JPEG of at most 1920 px wide (a 4K screenshot would be several MB as PNG) */
export const MAX_WIDTH = 1920;
const QUALITY = 0.85;

export type Shot = { blob: Blob; width: number; height: number };

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), type, quality));

/** Draw any picture source on a canvas no wider than MAX_WIDTH, on white (so a transparent PNG does not turn black) */
function drawn(src: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const scale = Math.min(1, MAX_WIDTH / w);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export async function shotFrom(src: CanvasImageSource, w: number, h: number): Promise<Shot> {
  const canvas = drawn(src, w, h);
  return { blob: await toBlob(canvas, "image/jpeg", QUALITY), width: canvas.width, height: canvas.height };
}

/** A pasted, dropped or chosen picture file */
export async function shotFromFile(file: Blob): Promise<Shot> {
  const bmp = await createImageBitmap(file);
  try {
    return await shotFrom(bmp, bmp.width, bmp.height);
  } finally {
    bmp.close();
  }
}

/** The bytes of a blob as base64 (what the API takes) */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * Hide a part of a picture for good (a password, a client's name): the area is pixelated in the picture itself, so
 * the original pixels are never kept. Rectangle in fractions (0–1) of the picture.
 */
export async function pixelate(blob: Blob, rect: { x: number; y: number; w: number; h: number }): Promise<Shot> {
  const bmp = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const x = Math.max(0, Math.floor(rect.x * bmp.width));
    const y = Math.max(0, Math.floor(rect.y * bmp.height));
    const w = Math.min(bmp.width - x, Math.ceil(rect.w * bmp.width));
    const h = Math.min(bmp.height - y, Math.ceil(rect.h * bmp.height));
    if (w < 1 || h < 1) return { blob, width: bmp.width, height: bmp.height };
    // blocks of about 1/8 of the area's height (at least 8 px): text becomes unreadable
    const block = Math.max(8, Math.round(Math.min(w, h) / 4));
    const small = document.createElement("canvas");
    small.width = Math.max(1, Math.ceil(w / block));
    small.height = Math.max(1, Math.ceil(h / block));
    small.getContext("2d")!.drawImage(canvas, x, y, w, h, 0, 0, small.width, small.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, small.width, small.height, x, y, w, h);
    return { blob: await toBlob(canvas, "image/jpeg", QUALITY), width: bmp.width, height: bmp.height };
  } finally {
    bmp.close();
  }
}
