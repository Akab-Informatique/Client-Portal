import { cn } from "@/lib/utils";

/**
 * Soft coloured light behind glass panels (gold, violet, sky), so the frosted
 * panels have something to blur. Purely decorative.
 */
export function GlassBackdrop({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0 -z-10 overflow-hidden", className)}>
      <div className="absolute -left-24 -top-32 size-[520px] rounded-full bg-[radial-gradient(circle,rgba(255,206,26,0.30),transparent_65%)] blur-3xl dark:opacity-80" />
      <div className="absolute -right-32 top-24 size-[560px] rounded-full bg-[radial-gradient(circle,rgba(139,92,246,0.26),transparent_65%)] blur-3xl" />
      <div className="absolute bottom-[-180px] left-1/3 size-[620px] rounded-full bg-[radial-gradient(circle,rgba(56,189,248,0.18),transparent_65%)] blur-3xl" />
    </div>
  );
}
