import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";

/**
 * Full-screen "monitored network" backdrop in the akab.ca palette:
 * - gold node network; larger hexagon "servers" emit a monitoring pulse
 * - gold data packets travel along links (monitored traffic)
 * - red threats fly in from the edges and are stopped by a gold shield
 *   flash before reaching a server (protected)
 * - cursor: spotlight, brighter grid, nodes drawn toward and linked to it
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

    type Node = { x: number; y: number; vx: number; vy: number; r: number; hub: boolean; phase: number; hit: number };
    type Packet = { a: Node; b: Node; t: number; speed: number };
    type Threat = { x: number; y: number; target: Node; speed: number; trail: { x: number; y: number }[] };
    type Shield = { x: number; y: number; t: number };
    type Spark = { x: number; y: number; vx: number; vy: number; life: number };

    let nodes: Node[] = [];
    let packets: Packet[] = [];
    let threats: Threat[] = [];
    let shields: Shield[] = [];
    let sparks: Spark[] = [];
    let nextPacket = 0;
    let nextThreat = 1.2;
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
      const count = Math.round(Math.min(130, Math.max(36, (w * h) / 13000)));
      nodes = Array.from({ length: count }, (_, i) => {
        const hub = i % 9 === 0;
        return {
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * (hub ? 0.08 : 0.22),
          vy: (Math.random() - 0.5) * (hub ? 0.08 : 0.22),
          r: hub ? 3.2 : Math.random() * 1.3 + 1.1,
          hub,
          phase: Math.random() * 5,
          hit: 0,
        };
      });
      packets = [];
      threats = [];
      shields = [];
      sparks = [];
    }

    const LINK = 135;
    const MOUSE_R = 200;

    function neighbours(n: Node) {
      return nodes.filter((m) => m !== n && Math.hypot(m.x - n.x, m.y - n.y) < LINK);
    }

    function spawnPacket() {
      const a = nodes[(Math.random() * nodes.length) | 0];
      const near = neighbours(a);
      if (near.length) packets.push({ a, b: near[(Math.random() * near.length) | 0], t: 0, speed: 0.6 + Math.random() * 0.6 });
    }

    function spawnThreat() {
      const hubs = nodes.filter((n) => n.hub);
      if (!hubs.length) return;
      const target = hubs[(Math.random() * hubs.length) | 0];
      const side = (Math.random() * 4) | 0;
      const x = side === 0 ? -20 : side === 1 ? w + 20 : Math.random() * w;
      const y = side === 2 ? -20 : side === 3 ? h + 20 : Math.random() * h;
      threats.push({ x, y, target, speed: 150 + Math.random() * 90, trail: [] });
    }

    function hexPath(x: number, y: number, r: number) {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i;
        const px = x + r * Math.cos(a);
        const py = y + r * Math.sin(a);
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

      // ── simulate ──
      for (const n of nodes) {
        if (mouse.active) {
          const dx = mouse.x - n.x;
          const dy = mouse.y - n.y;
          const d = Math.hypot(dx, dy);
          if (d < MOUSE_R && d > 1) {
            n.vx += (dx / d) * (n.hub ? 0.004 : 0.012);
            n.vy += (dy / d) * (n.hub ? 0.004 : 0.012);
          }
        }
        n.vx = n.vx * 0.985 + (Math.random() - 0.5) * 0.01;
        n.vy = n.vy * 0.985 + (Math.random() - 0.5) * 0.01;
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < -20) n.x = w + 20;
        if (n.x > w + 20) n.x = -20;
        if (n.y < -20) n.y = h + 20;
        if (n.y > h + 20) n.y = -20;
        n.hit = Math.max(0, n.hit - dt * 1.6);
      }

      nextPacket -= dt;
      if (nextPacket <= 0) {
        spawnPacket();
        nextPacket = 0.12 + Math.random() * 0.2;
      }
      nextThreat -= dt;
      if (nextThreat <= 0) {
        spawnThreat();
        nextThreat = 1.4 + Math.random() * 1.8;
      }
      packets = packets.filter((p) => (p.t += dt * p.speed) < 1 && Math.hypot(p.a.x - p.b.x, p.a.y - p.b.y) < LINK * 1.3);

      for (const th of threats) {
        const dx = th.target.x - th.x;
        const dy = th.target.y - th.y;
        const d = Math.hypot(dx, dy);
        th.trail.push({ x: th.x, y: th.y });
        if (th.trail.length > 22) th.trail.shift();
        th.x += (dx / d) * th.speed * dt;
        th.y += (dy / d) * th.speed * dt;
        if (d < 26) {
          // blocked by the shield before reaching the server
          shields.push({ x: th.target.x, y: th.target.y, t: 0 });
          th.target.hit = 1;
          for (let i = 0; i < 8; i++) {
            const a = Math.random() * Math.PI * 2;
            sparks.push({ x: th.x, y: th.y, vx: Math.cos(a) * 60, vy: Math.sin(a) * 60, life: 1 });
          }
          th.speed = -1;
        }
      }
      threats = threats.filter((th) => th.speed > 0);
      shields = shields.filter((s) => (s.t += dt * 1.4) < 1);
      sparks = sparks.filter((s) => {
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.life -= dt * 2.2;
        return s.life > 0;
      });

      // ── draw ──
      ctx.clearRect(0, 0, w, h);
      const nearMouse = (x: number, y: number) => (mouse.active ? Math.max(0, 1 - Math.hypot(x - mouse.x, y - mouse.y) / MOUSE_R) : 0);

      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < LINK) {
            const near = nearMouse((a.x + b.x) / 2, (a.y + b.y) / 2);
            ctx.strokeStyle = `rgba(255, 206, 26, ${(1 - d / LINK) * (0.16 + near * 0.45)})`;
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
            ctx.strokeStyle = `rgba(245, 148, 16, ${(1 - dm / MOUSE_R) * 0.55})`;
            ctx.lineWidth = 0.9;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(mouse.x, mouse.y);
            ctx.stroke();
          }
        }
      }

      // monitored traffic
      for (const p of packets) {
        const x = p.a.x + (p.b.x - p.a.x) * p.t;
        const y = p.a.y + (p.b.y - p.a.y) * p.t;
        ctx.fillStyle = "rgba(255, 226, 74, 0.95)";
        ctx.shadowColor = "rgba(255, 206, 26, 0.9)";
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.arc(x, y, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;

      // nodes and servers
      for (const n of nodes) {
        const near = nearMouse(n.x, n.y);
        if (n.hub) {
          // monitoring pulse
          const cycle = ((clock + n.phase) % 3.2) / 3.2;
          ctx.strokeStyle = `rgba(255, 206, 26, ${(1 - cycle) * 0.35})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(n.x, n.y, 6 + cycle * 26, 0, Math.PI * 2);
          ctx.stroke();
          hexPath(n.x, n.y, 7.5 + near * 2);
          ctx.strokeStyle = n.hit > 0 ? `rgba(255, 255, 255, ${0.6 + n.hit * 0.4})` : `rgba(255, 206, 26, ${0.6 + near * 0.4})`;
          ctx.lineWidth = 1.4;
          ctx.stroke();
        }
        ctx.fillStyle = `rgba(255, 226, 74, ${0.5 + near * 0.5})`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + near * 1.4, 0, Math.PI * 2);
        ctx.fill();
      }

      // incoming threats (red) with a fading trail
      for (const th of threats) {
        for (let i = 1; i < th.trail.length; i++) {
          const a = th.trail[i - 1];
          const b = th.trail[i];
          ctx.strokeStyle = `rgba(239, 68, 68, ${(i / th.trail.length) * 0.7})`;
          ctx.lineWidth = 2.2;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
        ctx.fillStyle = "rgba(248, 113, 113, 1)";
        ctx.shadowColor = "rgba(239, 68, 68, 0.9)";
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(th.x, th.y, 3.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // protection: gold hexagonal shield flash
      for (const s of shields) {
        hexPath(s.x, s.y, 12 + s.t * 22);
        ctx.strokeStyle = `rgba(255, 206, 26, ${(1 - s.t) * 0.9})`;
        ctx.lineWidth = 2 * (1 - s.t) + 0.5;
        ctx.shadowColor = "rgba(255, 206, 26, 0.8)";
        ctx.shadowBlur = 14 * (1 - s.t);
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
      for (const sp of sparks) {
        ctx.fillStyle = `rgba(248, 113, 113, ${sp.life})`;
        ctx.fillRect(sp.x - 1, sp.y - 1, 2, 2);
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
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_50%,rgba(10,10,11,0.8)_100%)]" />
    </div>
  );
}
