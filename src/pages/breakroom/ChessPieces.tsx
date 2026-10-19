import { cn } from "@/lib/utils";

type Kind = "k" | "q" | "r" | "b" | "n" | "p";

/**
 * Modern chess pieces, drawn (no font glyphs: every piece the same size).
 * White: paper with an ink outline; black: ink with a gold outline (AKAB).
 */
const SHAPES: Record<Kind, React.ReactNode> = {
  p: (
    <>
      <circle cx="50" cy="31" r="13" />
      <path d="M37 76 C38 60 43 50 50 46 C57 50 62 60 63 76 Z" />
      <rect x="27" y="76" width="46" height="11" rx="4" />
    </>
  ),
  r: (
    <>
      <path d="M29 18 H39 V27 H45 V18 H55 V27 H61 V18 H71 V37 L65 43 V69 L71 76 H29 L35 69 V43 L29 37 Z" />
      <rect x="25" y="76" width="50" height="11" rx="4" />
    </>
  ),
  n: (
    <>
      <path d="M31 76 C31 61 37 52 47 45 L37 42 C33 38 34 31 39 28 L49 21 L51 12 L58 20 C70 24 76 37 74 52 C72 63 67 70 67 76 Z" />
      <circle cx="51" cy="29" r="2.8" className="pc-detail" />
      <rect x="25" y="76" width="50" height="11" rx="4" />
    </>
  ),
  b: (
    <>
      <circle cx="50" cy="13" r="5.5" />
      <path d="M50 19 C61 28 67 37 67 48 C67 58 60 64 50 66 C40 64 33 58 33 48 C33 37 39 28 50 19 Z" />
      <path d="M55 33 L45 47" className="pc-detail" fill="none" strokeLinecap="round" />
      <path d="M38 66 H62 L64 76 H36 Z" />
      <rect x="27" y="76" width="46" height="11" rx="4" />
    </>
  ),
  q: (
    <>
      <circle cx="22" cy="31" r="5" />
      <circle cx="38" cy="22" r="5" />
      <circle cx="62" cy="22" r="5" />
      <circle cx="78" cy="31" r="5" />
      <path d="M22 36 L33 64 H67 L78 36 L63 52 L60 27 L50 50 L40 27 L37 52 Z" />
      <path d="M33 64 H67 L70 76 H30 Z" />
      <rect x="25" y="76" width="50" height="11" rx="4" />
    </>
  ),
  k: (
    <>
      <rect x="46.5" y="6" width="7" height="22" rx="2" />
      <rect x="39" y="12" width="22" height="7" rx="2" />
      <path d="M28 40 C28 30 40 27 50 34 C60 27 72 30 72 40 C72 52 63 58 63 65 H37 C37 58 28 52 28 40 Z" />
      <path d="M36 65 H64 L67 76 H33 Z" />
      <rect x="25" y="76" width="50" height="11" rx="4" />
    </>
  ),
};

export function ChessPiece({ type, color, className }: { type: Kind; color: "w" | "b"; className?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      aria-hidden
      className={cn(
        "pointer-events-none select-none",
        color === "w"
          ? "fill-[#f4f4f1] stroke-[#0a0a0b] [&_.pc-detail]:fill-[#0a0a0b] [&_.pc-detail]:stroke-[#0a0a0b] drop-shadow-[0_3px_3px_rgba(0,0,0,0.45)]"
          : "fill-[#141418] stroke-[#ffce1a] [&_.pc-detail]:fill-[#ffce1a] [&_.pc-detail]:stroke-[#ffce1a] drop-shadow-[0_3px_4px_rgba(0,0,0,0.6)]",
        className,
      )}
      strokeWidth={3.2}
      strokeLinejoin="round"
    >
      {SHAPES[type]}
    </svg>
  );
}

/** The board's colours: dark squares, a soft gold sheen */
export const SQUARE_LIGHT = "bg-[#3a3e4a]";
export const SQUARE_DARK = "bg-[#22252d]";
