import type { CSSProperties } from "react";
import logoUrl from "@/assets/akab-logo.webp";
import logoPillUrl from "@/assets/akab-logo-pill.png";
import { cn } from "@/lib/utils";

/**
 * Official AKAB logo (src/assets/akab-logo.webp, 2000 × 480): gold speed bars,
 * cursor in a white hexagon, the gold AKAB lettering and "INFORMATIQUE" in white
 * under it (made for a dark background). The lettering is always this image,
 * never typed in a font, to stay true to the brand.
 */
const W = 2000; // image height: 480

/** One part of the logo image, cropped (x, y, width, height in image pixels); height comes from className. */
function Crop({ x, y, w, h, className, style }: { x: number; y: number; w: number; h: number; className?: string; style?: CSSProperties }) {
  return (
    <span role="img" aria-label="AKAB" className={cn("relative inline-block shrink-0 overflow-hidden", className)} style={{ aspectRatio: `${w} / ${h}`, ...style }}>
      <img
        src={logoUrl}
        alt=""
        draggable={false}
        className="absolute max-w-none select-none"
        style={{ width: `${(W / w) * 100}%`, left: `${(-x / w) * 100}%`, top: `${(-y / h) * 100}%` }}
      />
    </span>
  );
}

/** The bars, cursor and hexagon only (collapsed menu, loading screen, sign-in). */
export function LogoMark({ className }: { className?: string }) {
  return <Crop x={0} y={0} w={848} h={480} className={cn("h-8", className)} />;
}

/** The AKAB lettering only, e.g. in a title next to other words. */
export function Wordmark({ className, style }: { className?: string; style?: CSSProperties }) {
  return <Crop x={872} y={45} w={1128} h={308} className={cn("h-6", className)} style={style} />;
}

// ── Lettering drawn in the AKAB style (same height as Wordmark) ──
// Measured on the logo: letters 305 px tall in a 308 px box, strokes 56 px,
// round outer corners (r 88), A with a flat top and no crossbar.
const S = 56;
const TOP = 1;
const BOTTOM = 306;
const rect = (x0: number, y0: number, x1: number, y1: number) => `M${x0},${y0}H${x1}V${y1}H${x0}Z`;
/** Rounded rectangle; radii top-left, top-right, bottom-right, bottom-left */
function rounded(x0: number, y0: number, x1: number, y1: number, [a, b, c, d]: [number, number, number, number]) {
  return (
    `M${x0 + a},${y0}H${x1 - b}A${b},${b} 0 0 1 ${x1},${y0 + b}V${y1 - c}A${c},${c} 0 0 1 ${x1 - c},${y1}` +
    `H${x0 + d}A${d},${d} 0 0 1 ${x0},${y1 - d}V${y0 + a}A${a},${a} 0 0 1 ${x0 + a},${y0}Z`
  );
}
/** P bowl, down to the middle bar (as the B of AKAB) */
const bowl = (w: number) => rounded(0, TOP, w, 177, [0, 88, 88, 0]) + rounded(S, TOP + S, w - S, 121, [0, 32, 32, 0]);
const GLYPHS: Record<string, { w: number; paths: string[] }> = {
  P: { w: 250, paths: [rect(0, TOP, S, BOTTOM), bowl(250)] },
  O: { w: 280, paths: [rounded(0, TOP, 280, BOTTOM, [88, 88, 88, 88]) + rounded(S, TOP + S, 280 - S, BOTTOM - S, [32, 32, 32, 32])] },
  R: { w: 265, paths: [rect(0, TOP, S, BOTTOM), bowl(250), `M105,170L175,170L265,${BOTTOM}L195,${BOTTOM}Z`] },
  T: { w: 240, paths: [rect(0, TOP, 240, TOP + S), rect(92, TOP, 92 + S, BOTTOM)] },
  // the A of AKAB, point for point
  A: { w: 308, paths: [`M114,${TOP}H196L303,${BOTTOM}H245L154,55L63,${BOTTOM}H5Z`] },
  I: { w: S, paths: [rect(0, TOP, S, BOTTOM)] },
  L: { w: 210, paths: [rect(0, TOP, S, BOTTOM), rect(0, BOTTOM - S, 210, BOTTOM)] },
};
/**
 * Space between two letter boxes, set by eye so the gaps look equal (as in
 * AKAB, where the closest points are 26-33 px): the A slides under the T bar,
 * the T sits close to the R leg, two straight stems (I L) get the most room.
 */
const SPACING: Record<string, number> = { PO: 30, OR: 44, RT: 12, TA: -64, AI: 21, AL: 21, IL: 48 };
const GAP = 40;

/** A word (P O R T A I L letters) drawn like the AKAB lettering, e.g. "Portail" next to the Wordmark. Same className height = same size. */
export function BrandWord({ word, className }: { word: string; className?: string }) {
  let x = 0;
  const letters = [...word.toUpperCase()].filter((ch) => GLYPHS[ch]).map((ch, i, all) => {
    if (i > 0) x += SPACING[all[i - 1] + ch] ?? GAP;
    const at = x;
    x += GLYPHS[ch].w;
    return { ch, at, i };
  });
  return (
    <svg viewBox={`0 0 ${x} 308`} role="img" aria-label={word} className={cn("h-6 w-auto shrink-0 fill-current", className)}>
      {letters.map((l) => (
        <g key={l.i} transform={`translate(${l.at} 0)`}>
          {GLYPHS[l.ch].paths.map((d, j) => (
            <path key={j} d={d} fillRule="evenodd" />
          ))}
        </g>
      ))}
    </svg>
  );
}

/**
 * The full logo in its black pill (src/assets/akab-logo-pill.png, 1000 × 290, the same image as the
 * invoice PDF's): the dark background is part of the image, so it prints right on white paper
 * even when the browser leaves backgrounds out (the white hexagon and INFORMATIQUE stay visible).
 */
export function LogoPill({ className }: { className?: string }) {
  return <img src={logoPillUrl} alt="AKAB Informatique" draggable={false} className={cn("h-12 w-auto shrink-0 select-none", className)} />;
}

/** The full logo, with INFORMATIQUE (top left of the portal). */
export function Logo({ className }: { className?: string }) {
  return <Crop x={0} y={0} w={W} h={480} className={cn("h-10 select-none", className)} />;
}
