import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

/** Grid + drifting gold glow + scan line — the akab.ca hero atmosphere. */
export function TechBackground({ className, intensity = 1 }: { className?: string; intensity?: number }) {
  const reduce = useReducedMotion();
  return (
    <div className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)} aria-hidden="true">
      <div className="absolute inset-0 bg-grid [mask-image:radial-gradient(ellipse_at_center,black_35%,transparent_80%)]" />
      <motion.div
        className="absolute -top-1/4 left-1/4 size-[42rem] rounded-full blur-3xl"
        style={{ background: "radial-gradient(circle, var(--glow), transparent 65%)", opacity: 0.9 * intensity }}
        animate={reduce ? undefined : { x: [0, 80, -40, 0], y: [0, 40, 90, 0] }}
        transition={{ duration: 26, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute -bottom-1/3 -right-1/4 size-[36rem] rounded-full blur-3xl"
        style={{ background: "radial-gradient(circle, rgba(245,148,16,0.16), transparent 65%)", opacity: intensity }}
        animate={reduce ? undefined : { x: [0, -60, 30, 0], y: [0, -50, -20, 0] }}
        transition={{ duration: 32, repeat: Infinity, ease: "easeInOut" }}
      />
      {!reduce && (
        <motion.div
          className="absolute inset-x-0 h-px bg-gradient-to-r from-transparent via-[color:var(--gold)]/40 to-transparent"
          initial={{ top: "-5%" }}
          animate={{ top: ["-5%", "105%"] }}
          transition={{ duration: 9, repeat: Infinity, ease: "linear", repeatDelay: 2 }}
        />
      )}
    </div>
  );
}

/** Pulsing status dot. */
export function LiveDot({ className, tone = "success" }: { className?: string; tone?: "success" | "gold" }) {
  const color = tone === "gold" ? "bg-gold" : "bg-success";
  return (
    <span className={cn("relative inline-flex size-2", className)}>
      <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", color)} />
      <span className={cn("relative inline-flex size-2 rounded-full", color)} />
    </span>
  );
}
