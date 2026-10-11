import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";

/**
 * Full-screen high-tech backdrop in the akab.ca palette:
 * - gold node network (canvas) that is drawn toward the mouse and links to it
 * - spotlight glow and a brighter grid that follow the cursor
 * Pauses when the tab is hidden; static when the user prefers reduced motion.
 */
export function InteractiveBackground() {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    const root = rootRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let w = 0;
    let h = 0;
    let dpr = 1;
    const mouse = { x: -9999, y: -9999, tx: -9999, ty: -9999, active: false };

    type Node = { x: number; y: number; vx: number; vy: number; r: number };
    let nodes: Node[] = [];

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = root.clientWidth;
      h = root.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round(Math.min(140, Math.max(40, (w * h) / 12000)));
      nodes = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        r: Math.random() * 1.4 + 0.6,
      }));
    }

    function onMove(e: PointerEvent) {
      const rect = root.getBoundingClientRect();
      mouse.tx = e.clientX - rect.left;
      mouse.ty = e.clientY - rect.top;
      if (!mouse.active) {
        mouse.x = mouse.tx;
        mouse.y = mouse.ty;
        mouse.active = true;
      }
    }
    function onLeave() {
      mouse.active = false;
    }

    const LINK = 130;
    const MOUSE_R = 190;
    let raf = 0;

    function frame() {
      // smooth cursor follow
      mouse.x += (mouse.tx - mouse.x) * 0.12;
      mouse.y += (mouse.ty - mouse.y) * 0.12;
      root.style.setProperty("--mx", `${mouse.active ? mouse.x : w / 2}px`);
      root.style.setProperty("--my", `${mouse.active ? mouse.y : h * 0.35}px`);

      ctx.clearRect(0, 0, w, h);
      for (const n of nodes) {
        if (mouse.active) {
          const dx = mouse.x - n.x;
          const dy = mouse.y - n.y;
          const d = Math.hypot(dx, dy);
          if (d < MOUSE_R && d > 1) {
            // gentle pull toward the cursor
            n.vx += (dx / d) * 0.012;
            n.vy += (dy / d) * 0.012;
          }
        }
        n.vx *= 0.985;
        n.vy *= 0.985;
        n.vx += (Math.random() - 0.5) * 0.01;
        n.vy += (Math.random() - 0.5) * 0.01;
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < -20) n.x = w + 20;
        if (n.x > w + 20) n.x = -20;
        if (n.y < -20) n.y = h + 20;
        if (n.y > h + 20) n.y = -20;
      }

      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < LINK) {
            const near = mouse.active ? Math.max(0, 1 - Math.hypot((a.x + b.x) / 2 - mouse.x, (a.y + b.y) / 2 - mouse.y) / MOUSE_R) : 0;
            ctx.strokeStyle = `rgba(255, 206, 26, ${(1 - d / LINK) * (0.13 + near * 0.45)})`;
            ctx.lineWidth = 0.6 + near * 0.6;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
        if (mouse.active) {
          const dm = Math.hypot(a.x - mouse.x, a.y - mouse.y);
          if (dm < MOUSE_R) {
            ctx.strokeStyle = `rgba(245, 148, 16, ${(1 - dm / MOUSE_R) * 0.5})`;
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(mouse.x, mouse.y);
            ctx.stroke();
          }
        }
      }

      for (const n of nodes) {
        const near = mouse.active ? Math.max(0, 1 - Math.hypot(n.x - mouse.x, n.y - mouse.y) / MOUSE_R) : 0;
        ctx.fillStyle = `rgba(255, 226, 74, ${0.35 + near * 0.65})`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + near * 1.6, 0, Math.PI * 2);
        ctx.fill();
      }

      if (!reduce) raf = requestAnimationFrame(frame);
    }

    function onVisibility() {
      cancelAnimationFrame(raf);
      if (!document.hidden && !reduce) raf = requestAnimationFrame(frame);
    }

    resize();
    frame();
    const ro = new ResizeObserver(resize);
    ro.observe(root);
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reduce]);

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 overflow-hidden bg-[#0a0a0b]" aria-hidden="true">
      {/* base grid */}
      <div className="absolute inset-0 bg-grid opacity-70 [mask-image:radial-gradient(ellipse_at_center,black_40%,transparent_85%)]" />
      {/* grid lit up around the cursor */}
      <div
        className="absolute inset-0 [background-size:48px_48px] [background-image:linear-gradient(rgba(255,206,26,0.22)_1px,transparent_1px),linear-gradient(90deg,rgba(255,206,26,0.22)_1px,transparent_1px)]"
        style={{
          maskImage: "radial-gradient(240px circle at var(--mx) var(--my), black, transparent 75%)",
          WebkitMaskImage: "radial-gradient(240px circle at var(--mx) var(--my), black, transparent 75%)",
        }}
      />
      {/* ambient glows */}
      <div className="absolute -left-40 -top-40 size-[44rem] rounded-full bg-[radial-gradient(circle,rgba(255,206,26,0.10),transparent_65%)] blur-2xl" />
      <div className="absolute -bottom-48 -right-40 size-[40rem] rounded-full bg-[radial-gradient(circle,rgba(245,148,16,0.12),transparent_65%)] blur-2xl" />
      {/* cursor spotlight */}
      <div
        className="absolute inset-0"
        style={{ background: "radial-gradient(520px circle at var(--mx) var(--my), rgba(255,206,26,0.10), transparent 60%)" }}
      />
      <canvas ref={canvasRef} className="absolute inset-0" />
      {/* vignette */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_45%,rgba(10,10,11,0.85)_100%)]" />
    </div>
  );
}
