import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";

/**
 * Full-screen "monitored network" backdrop in the akab.ca palette:
 * - gold node network; larger hexagon "servers" emit a slow monitoring pulse
 * - small gold data packets travel along links (monitored traffic)
 * - cursor: spotlight, brighter grid, nodes drawn toward and linked to it
 * Deliberately subtle — the sign-in card stays the focus.
 * Pauses when the tab is hidden; a still frame with reduced motion.
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
    const mouse = { x: -9999, y: -9999, tx: -9999, ty: -9999, active: false };

    type Node = { x: number; y: number; vx: number; vy: number; r: number; hub: boolean; phase: number };
    type Packet = { a: Node; b: Node; t: number; speed: number };

    let nodes: Node[] = [];
    let packets: Packet[] = [];
    let nextPacket = 0;
    let last = performance.now();
    let clock = 0;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = root.clientWidth;
      h = root.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round(Math.min(120, Math.max(34, (w * h) / 14000)));
      nodes = Array.from({ length: count }, (_, i) => {
        const hub = i % 10 === 0;
        return {
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * (hub ? 0.06 : 0.18),
          vy: (Math.random() - 0.5) * (hub ? 0.06 : 0.18),
          r: hub ? 2.8 : Math.random() * 1.2 + 1,
          hub,
          phase: Math.random() * 5,
        };
      });
      packets = [];
    }

    const LINK = 135;
    const MOUSE_R = 200;

    function spawnPacket() {
      const a = nodes[(Math.random() * nodes.length) | 0];
      const near = nodes.filter((m) => m !== a && Math.hypot(m.x - a.x, m.y - a.y) < LINK);
      if (near.length) packets.push({ a, b: near[(Math.random() * near.length) | 0], t: 0, speed: 0.5 + Math.random() * 0.5 });
    }

    function hexPath(x: number, y: number, r: number) {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const ang = (Math.PI / 3) * i;
        const px = x + r * Math.cos(ang);
        const py = y + r * Math.sin(ang);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
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
    const onLeave = () => (mouse.active = false);

    let raf = 0;
    function frame(now: number) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      clock += dt;

      mouse.x += (mouse.tx - mouse.x) * 0.12;
      mouse.y += (mouse.ty - mouse.y) * 0.12;
      root.style.setProperty("--mx", `${mouse.active ? mouse.x : w / 2}px`);
      root.style.setProperty("--my", `${mouse.active ? mouse.y : h * 0.35}px`);

      for (const n of nodes) {
        if (mouse.active) {
          const dx = mouse.x - n.x;
          const dy = mouse.y - n.y;
          const d = Math.hypot(dx, dy);
          if (d < MOUSE_R && d > 1) {
            n.vx += (dx / d) * (n.hub ? 0.004 : 0.011);
            n.vy += (dy / d) * (n.hub ? 0.004 : 0.011);
          }
        }
        n.vx = n.vx * 0.985 + (Math.random() - 0.5) * 0.008;
        n.vy = n.vy * 0.985 + (Math.random() - 0.5) * 0.008;
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < -20) n.x = w + 20;
        if (n.x > w + 20) n.x = -20;
        if (n.y < -20) n.y = h + 20;
        if (n.y > h + 20) n.y = -20;
      }

      nextPacket -= dt;
      if (nextPacket <= 0) {
        spawnPacket();
        nextPacket = 0.18 + Math.random() * 0.3;
      }
      packets = packets.filter((p) => (p.t += dt * p.speed) < 1 && Math.hypot(p.a.x - p.b.x, p.a.y - p.b.y) < LINK * 1.3);

      ctx.clearRect(0, 0, w, h);
      const nearMouse = (x: number, y: number) => (mouse.active ? Math.max(0, 1 - Math.hypot(x - mouse.x, y - mouse.y) / MOUSE_R) : 0);

      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < LINK) {
            const near = nearMouse((a.x + b.x) / 2, (a.y + b.y) / 2);
            ctx.strokeStyle = `rgba(255, 206, 26, ${(1 - d / LINK) * (0.13 + near * 0.42)})`;
            ctx.lineWidth = 0.7 + near * 0.6;
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
            ctx.lineWidth = 0.9;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(mouse.x, mouse.y);
            ctx.stroke();
          }
        }
      }

      ctx.fillStyle = "rgba(255, 226, 74, 0.85)";
      for (const p of packets) {
        ctx.beginPath();
        ctx.arc(p.a.x + (p.b.x - p.a.x) * p.t, p.a.y + (p.b.y - p.a.y) * p.t, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }

      for (const n of nodes) {
        const near = nearMouse(n.x, n.y);
        if (n.hub) {
          const cycle = ((clock + n.phase) % 4) / 4;
          ctx.strokeStyle = `rgba(255, 206, 26, ${(1 - cycle) * 0.25})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(n.x, n.y, 6 + cycle * 22, 0, Math.PI * 2);
          ctx.stroke();
          hexPath(n.x, n.y, 7 + near * 2);
          ctx.strokeStyle = `rgba(255, 206, 26, ${0.45 + near * 0.5})`;
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
        ctx.fillStyle = `rgba(255, 226, 74, ${0.42 + near * 0.55})`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + near * 1.4, 0, Math.PI * 2);
        ctx.fill();
      }

      if (!reduce) raf = requestAnimationFrame(frame);
    }

    function onVisibility() {
      cancelAnimationFrame(raf);
      last = performance.now();
      if (!document.hidden && !reduce) raf = requestAnimationFrame(frame);
    }

    resize();
    frame(performance.now());
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
      <div className="absolute inset-0 bg-grid opacity-70 [mask-image:radial-gradient(ellipse_at_center,black_40%,transparent_85%)]" />
      <div
        className="absolute inset-0 [background-size:48px_48px] [background-image:linear-gradient(rgba(255,206,26,0.2)_1px,transparent_1px),linear-gradient(90deg,rgba(255,206,26,0.2)_1px,transparent_1px)]"
        style={{
          maskImage: "radial-gradient(240px circle at var(--mx) var(--my), black, transparent 75%)",
          WebkitMaskImage: "radial-gradient(240px circle at var(--mx) var(--my), black, transparent 75%)",
        }}
      />
      <div className="absolute -left-40 -top-40 size-[44rem] animate-[pulse_9s_ease-in-out_infinite] rounded-full bg-[radial-gradient(circle,rgba(255,206,26,0.10),transparent_65%)] blur-2xl" />
      <div className="absolute -bottom-48 -right-40 size-[40rem] animate-[pulse_11s_ease-in-out_infinite] rounded-full bg-[radial-gradient(circle,rgba(245,148,16,0.12),transparent_65%)] blur-2xl" />
      <div className="absolute inset-0" style={{ background: "radial-gradient(520px circle at var(--mx) var(--my), rgba(255,206,26,0.09), transparent 60%)" }} />
      <canvas ref={canvasRef} className="absolute inset-0 opacity-60" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_50%,rgba(10,10,11,0.8)_100%)]" />
    </div>
  );
}
