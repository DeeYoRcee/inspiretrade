import { useEffect, useRef } from "react";
import { useTheme } from "@/lib/theme-context";
import { useTerminalSettings } from "@/lib/terminal-settings";

/**
 * Steam-style animated theme backdrop. Two kinds of scene:
 *  - video themes (f1) play their looping mp4 behind the whole app,
 *    dimmed by a readability veil so every text layer stays crisp;
 *  - the money theme is a CANVAS scene (Phase 29-UI): the old money.mp4 mixed
 *    flipping gold coins into the falling bills and the veil washed both out.
 *    The new scene draws ONLY falling $ bills — larger, brighter, sharper —
 *    and keeps a much lighter veil. requestAnimationFrame pauses when the
 *    document is hidden so a background tab never burns battery.
 */
const THEME_VIDEOS: Record<string, { src: string; opacity: number; veil: string }> = {
  f1: { src: "/videos/f1.mp4", opacity: 0.55, veil: "linear-gradient(180deg, rgba(18,4,4,0.62), rgba(60,8,8,0.30) 45%, rgba(18,4,4,0.66))" },
};
const MONEY_VEIL = "linear-gradient(180deg, rgba(4,20,13,0.42), rgba(10,50,32,0.16) 45%, rgba(4,20,13,0.46))";

interface Bill {
  x: number; // center x
  y: number; // center y
  vy: number; // fall speed px/s
  size: number; // bill width px
  angle: number; // current rotation
  spin: number; // rad/s
  sway: number; // horizontal sway amplitude
  phase: number; // sway phase
  flip: number; // 3d flip phase
  flipSpeed: number;
  bright: number; // per-bill brightness 0.75..1
}

function drawBill(ctx: CanvasRenderingContext2D, b: Bill, w: number) {
  const halfW = b.size / 2;
  const halfH = b.size * 0.46;
  // 3d flip: scale the bill's height like a spinning sheet
  const squash = Math.abs(Math.cos(b.flip));
  ctx.save();
  ctx.translate(b.x + Math.sin(b.phase) * b.sway, b.y);
  ctx.rotate(b.angle);
  ctx.scale(1, Math.max(squash, 0.12));
  ctx.globalAlpha = 0.92 * b.bright;
  // glow — the crispness the old video lacked
  ctx.shadowColor = "rgba(80, 220, 140, 0.55)";
  ctx.shadowBlur = 14;
  // bill body — bright banknote green
  const grad = ctx.createLinearGradient(-halfW, -halfH, halfW, halfH);
  grad.addColorStop(0, "#e8fff2");
  grad.addColorStop(0.18, "#8ee6a8");
  grad.addColorStop(0.5, "#3ec46d");
  grad.addColorStop(0.85, "#1e9e52");
  grad.addColorStop(1, "#eafff3");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(-halfW, -halfH, b.size, halfH * 2, halfW * 0.12);
  ctx.fill();
  ctx.shadowBlur = 0;
  // border + inner frame
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = Math.max(1.2, b.size * 0.035);
  ctx.stroke();
  ctx.strokeStyle = "rgba(12,74,38,0.6)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(-halfW * 0.82, -halfH * 0.7, b.size * 0.82, halfH * 1.4, halfW * 0.1);
  ctx.stroke();
  // center seal + denomination
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.beginPath();
  ctx.ellipse(0, 0, halfW * 0.3, halfH * 0.52, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#0c4a26";
  ctx.font = `bold ${Math.max(9, b.size * 0.34)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("$", 0, b.size * 0.02);
  // corner marks
  ctx.fillStyle = "rgba(12,74,38,0.75)";
  ctx.font = `bold ${Math.max(6, b.size * 0.16)}px system-ui, sans-serif`;
  ctx.fillText("100", -halfW * 0.55, -halfH * 0.42);
  ctx.fillText("100", halfW * 0.55, halfH * 0.42);
  ctx.restore();
}

function MoneyRainCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let last = performance.now();
    let bills: Bill[] = [];
    const spawn = (w: number, h: number, initial: boolean): Bill => ({
      x: Math.random() * w,
      y: initial ? Math.random() * h : -60,
      vy: 90 + Math.random() * 120,
      size: 34 + Math.random() * 30,
      angle: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 1.6,
      sway: 14 + Math.random() * 30,
      phase: Math.random() * Math.PI * 2,
      flip: Math.random() * Math.PI * 2,
      flipSpeed: 0.8 + Math.random() * 1.6,
      bright: 0.75 + Math.random() * 0.25,
    });
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(canvas.clientWidth * dpr);
      canvas.height = Math.floor(canvas.clientHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.max(18, Math.min(34, Math.floor(canvas.clientWidth / 52)));
      bills = Array.from({ length: count }, () => spawn(canvas.clientWidth, canvas.clientHeight, true));
    };
    resize();
    window.addEventListener("resize", resize);
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      for (const b of bills) {
        b.y += b.vy * dt;
        b.angle += b.spin * dt;
        b.flip += b.flipSpeed * dt;
        b.phase += dt * 1.2;
        if (b.y - b.size > h) Object.assign(b, spawn(w, h, false));
        drawBill(ctx, b, w);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
      } else {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return (
    <div className="pointer-events-none fixed inset-0 z-[-2] overflow-hidden" aria-hidden>
      <canvas ref={canvasRef} className="h-full w-full" />
      <div className="absolute inset-0" style={{ background: MONEY_VEIL }} />
    </div>
  );
}

export function ThemeBackdrop() {
  const { theme } = useTheme();
  const { themeBackdrop } = useTerminalSettings().appearance;
  if (theme === "money") {
    return themeBackdrop ? <MoneyRainCanvas /> : null;
  }
  const conf = THEME_VIDEOS[theme];
  if (!conf || !themeBackdrop) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[-2] overflow-hidden" aria-hidden>
      <video
        src={conf.src}
        autoPlay
        loop
        muted
        playsInline
        preload="metadata"
        className="h-full w-full object-cover"
        style={{ opacity: conf.opacity }}
      />
      {/* readability veil — keeps the theme mood while text stays crisp */}
      <div className="absolute inset-0" style={{ background: conf.veil }} />
    </div>
  );
}
