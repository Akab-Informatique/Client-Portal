/** Colours of the client classifications (Admin › Classifications): token → classes. */
export const CLASS_COLORS = ["slate", "blue", "orange", "zinc", "yellow", "green", "red", "violet"] as const;
export type ClassColor = (typeof CLASS_COLORS)[number];

const STYLE: Record<ClassColor, { pill: string; dot: string; stroke: string }> = {
  slate: { pill: "border-slate-400/40 bg-slate-500/10 text-slate-300", dot: "bg-slate-400", stroke: "#94a3b8" },
  blue: { pill: "border-sky-400/40 bg-sky-500/10 text-sky-300", dot: "bg-sky-400", stroke: "#38bdf8" },
  orange: { pill: "border-orange-400/40 bg-orange-500/10 text-orange-300", dot: "bg-orange-400", stroke: "#fb923c" },
  zinc: { pill: "border-zinc-300/40 bg-zinc-300/10 text-zinc-200", dot: "bg-zinc-300", stroke: "#d4d4d8" },
  yellow: { pill: "border-yellow-400/50 bg-yellow-400/10 text-yellow-300", dot: "bg-yellow-400", stroke: "#facc15" },
  green: { pill: "border-emerald-400/40 bg-emerald-500/10 text-emerald-300", dot: "bg-emerald-400", stroke: "#34d399" },
  red: { pill: "border-red-400/40 bg-red-500/10 text-red-300", dot: "bg-red-400", stroke: "#f87171" },
  violet: { pill: "border-violet-400/40 bg-violet-500/10 text-violet-300", dot: "bg-violet-400", stroke: "#a78bfa" },
};
export const classStyle = (color: string | null | undefined) => STYLE[(color as ClassColor) in STYLE ? (color as ClassColor) : "slate"];
