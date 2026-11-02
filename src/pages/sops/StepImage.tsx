import { useRef, useState, type PointerEvent } from "react";
import { cn } from "@/lib/utils";
import type { Mark } from "./shared";

export type Tool = "view" | "pin" | "box" | "blur" | "erase";

const GOLD = "#ffce1a";

/** The marks drawn over a picture, positioned in fractions of its size: the same look in the editor, the reader and the print */
export function MarkShape({ m, number }: { m: Mark; number?: number }) {
  if (m.kind === "box") {
    return <span className="absolute rounded-md border-[3px]" style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${(m.w ?? 0) * 100}%`, height: `${(m.h ?? 0) * 100}%`, borderColor: GOLD, background: "rgba(255,206,26,.12)", printColorAdjust: "exact" }} />;
  }
  return (
    <span className="absolute grid size-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-[3px] text-[13px] font-bold text-black shadow-lg" style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%`, borderColor: GOLD, background: "rgba(255,206,26,.35)", printColorAdjust: "exact" }}>
      {number ?? ""}
    </span>
  );
}

/**
 * A step's picture with its marks. With a tool picked it is drawn on: a click puts a pin (where to click), a drag draws a
 * frame, a drag with "blur" hides that part of the picture for good (`onBlur`), "erase" removes a mark.
 */
export function StepImage({ src, marks, tool = "view", onMarks, onBlur, className, alt }: { src: string; marks: Mark[]; tool?: Tool; onMarks?: (m: Mark[]) => void; onBlur?: (r: { x: number; y: number; w: number; h: number }) => void; className?: string; alt?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x: number; y: number } | null>(null);
  const drawing = tool === "pin" || tool === "box" || tool === "blur";
  const at = (e: PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const down = (e: PointerEvent) => {
    if (!drawing) return;
    const p = at(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === "pin") onMarks?.([...marks, { kind: "pin", x: p.x, y: p.y }]);
    else setDrag({ x0: p.x, y0: p.y, x: p.x, y: p.y });
  };
  const move = (e: PointerEvent) => drag && setDrag({ ...drag, ...at(e) });
  const up = () => {
    if (!drag) return;
    const r = { x: Math.min(drag.x0, drag.x), y: Math.min(drag.y0, drag.y), w: Math.abs(drag.x - drag.x0), h: Math.abs(drag.y - drag.y0) };
    setDrag(null);
    if (r.w < 0.01 || r.h < 0.01) return;
    if (tool === "box") onMarks?.([...marks, { kind: "box", ...r }]);
    else if (tool === "blur") onBlur?.(r);
  };
  let pins = 0;
  return (
    <div ref={box} className={cn("relative select-none overflow-hidden rounded-lg border bg-muted/30", className)}>
      <img src={src} alt={alt ?? ""} draggable={false} className="block w-full" loading="lazy" />
      <div className="absolute inset-0" style={{ cursor: drawing ? "crosshair" : "default", touchAction: drawing ? "none" : "auto" }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setDrag(null)}>
        {marks.map((m, i) => (
          <span key={i} className="contents" onClick={tool === "erase" ? () => onMarks?.(marks.filter((_, j) => j !== i)) : undefined}>
            <MarkShape m={m} number={m.kind === "pin" ? ++pins : undefined} />
            {tool === "erase" && <span className="absolute grid size-5 place-items-center rounded-full bg-red-600 text-[11px] font-bold text-white" style={{ left: `${(m.x + (m.w ?? 0)) * 100}%`, top: `${m.y * 100}%`, transform: "translate(-50%,-50%)", cursor: "pointer" }}>×</span>}
          </span>
        ))}
        {drag && <span className={cn("absolute rounded-md border-[3px] border-dashed", tool === "blur" ? "border-sky-400 bg-sky-400/20" : "border-[#ffce1a] bg-[#ffce1a]/10")} style={{ left: `${Math.min(drag.x0, drag.x) * 100}%`, top: `${Math.min(drag.y0, drag.y) * 100}%`, width: `${Math.abs(drag.x - drag.x0) * 100}%`, height: `${Math.abs(drag.y - drag.y0) * 100}%` }} />}
      </div>
    </div>
  );
}
