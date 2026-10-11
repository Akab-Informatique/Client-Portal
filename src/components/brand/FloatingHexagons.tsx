import { useEffect, type ReactNode } from "react";
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform, type MotionValue } from "motion/react";

/**
 * Calm, premium backdrop shapes: hexagons (the AKAB mark's shape) floating at
 * different depths. Near ones are larger and follow the mouse more (parallax).
 * Suitable for clients and staff alike; decorative only.
 */
type Hex = { x: number; y: number; size: number; depth: number; kind: "line" | "glass" | "glow"; rotate: number; float: number };

// Fixed layout (percent of the viewport) — balanced around the centred card.
const HEXES: Hex[] = [
  { x: 9, y: 16, size: 150, depth: 0.9, kind: "glass", rotate: 8, float: 9 },
  { x: 20, y: 70, size: 230, depth: 1, kind: "line", rotate: -6, float: 12 },
  { x: 4, y: 48, size: 70, depth: 0.4, kind: "glow", rotate: 20, float: 7 },
  { x: 30, y: 10, size: 46, depth: 0.3, kind: "line", rotate: 12, float: 8 },
  { x: 33, y: 88, size: 60, depth: 0.45, kind: "glass", rotate: -15, float: 10 },
  { x: 84, y: 20, size: 210, depth: 1, kind: "line", rotate: 10, float: 13 },
  { x: 92, y: 62, size: 130, depth: 0.8, kind: "glass", rotate: -10, float: 11 },
  { x: 72, y: 84, size: 90, depth: 0.55, kind: "glow", rotate: 5, float: 9 },
  { x: 68, y: 8, size: 54, depth: 0.35, kind: "glass", rotate: -20, float: 8 },
  { x: 97, y: 92, size: 40, depth: 0.25, kind: "line", rotate: 0, float: 7 },
  { x: 58, y: 95, size: 36, depth: 0.3, kind: "line", rotate: 18, float: 6 },
  { x: 45, y: 4, size: 34, depth: 0.25, kind: "glow", rotate: -8, float: 6 },
];

const POINTS = "50,3 93,27 93,73 50,97 7,73 7,27";

export function FloatingHexagons() {
  const reduce = useReducedMotion();
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const sx = useSpring(mx, { stiffness: 40, damping: 18 });
  const sy = useSpring(my, { stiffness: 40, damping: 18 });

  useEffect(() => {
    if (reduce) return;
    const onMove = (e: PointerEvent) => {
      mx.set(e.clientX / window.innerWidth - 0.5);
      my.set(e.clientY / window.innerHeight - 0.5);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [mx, my, reduce]);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {HEXES.map((h, i) => (
        <Parallax key={i} hex={h} sx={sx} sy={sy} index={i} reduce={Boolean(reduce)}>
          <HexShape kind={h.kind} id={i} />
        </Parallax>
      ))}
    </div>
  );
}

function Parallax({
  hex,
  sx,
  sy,
  index,
  reduce,
  children,
}: {
  hex: Hex;
  sx: MotionValue<number>;
  sy: MotionValue<number>;
  index: number;
  reduce: boolean;
  children: ReactNode;
}) {
  const range = 60 * hex.depth;
  const x = useTransform(sx, [-0.5, 0.5], [range, -range]);
  const y = useTransform(sy, [-0.5, 0.5], [range, -range]);
  return (
    <motion.div
      className="absolute"
      style={{
        left: `${hex.x}%`,
        top: `${hex.y}%`,
        width: hex.size,
        height: hex.size,
        marginLeft: -hex.size / 2,
        marginTop: -hex.size / 2,
        x,
        y,
        filter: hex.depth < 0.4 ? "blur(1px)" : undefined,
      }}
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 0.35 + hex.depth * 0.55, scale: 1 }}
      transition={{ delay: 0.1 + index * 0.06, duration: 1.4, ease: [0.22, 1, 0.36, 1] }}
    >
      <motion.div
        className="size-full"
        animate={reduce ? undefined : { y: [0, -hex.float, 0], rotate: [hex.rotate, hex.rotate + 6, hex.rotate] }}
        transition={{ duration: 9 + (index % 5) * 2, repeat: Infinity, ease: "easeInOut" }}
        style={{ rotate: hex.rotate }}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

function HexShape({ kind, id }: { kind: Hex["kind"]; id: number }) {
  const g = `hex-g-${id}`;
  return (
    <svg viewBox="0 0 100 100" className="size-full overflow-visible">
      <defs>
        <linearGradient id={g} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffe24a" />
          <stop offset="0.5" stopColor="#ffce1a" />
          <stop offset="1" stopColor="#f59410" />
        </linearGradient>
      </defs>
      {kind === "line" && <polygon points={POINTS} fill="none" stroke={`url(#${g})`} strokeOpacity="0.45" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />}
      {kind === "glass" && (
        <>
          <polygon points={POINTS} fill="rgba(255,255,255,0.025)" stroke="rgba(255,255,255,0.10)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <polygon points={POINTS} fill="none" stroke={`url(#${g})`} strokeOpacity="0.35" strokeWidth="1" strokeDasharray="2 10" vectorEffect="non-scaling-stroke" />
        </>
      )}
      {kind === "glow" && (
        <polygon
          points={POINTS}
          fill={`url(#${g})`}
          fillOpacity="0.10"
          stroke={`url(#${g})`}
          strokeOpacity="0.6"
          strokeWidth="1.2"
          vectorEffect="non-scaling-stroke"
          style={{ filter: "drop-shadow(0 0 10px rgba(255,206,26,0.35))" }}
        />
      )}
    </svg>
  );
}
