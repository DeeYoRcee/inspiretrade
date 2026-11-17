/**
 * Chart drawing tools — types, geometry and hit-testing.
 *
 * Anchors are stored in MARKET coordinates (time in seconds, price) so a
 * drawing survives timeframe switches, historical prepends and resize; pixel
 * conversion happens at render time via the chart's time/price scales.
 * This module is pure — the canvas layer (DrawingCanvas) renders and
 * interacts, and tests exercise the geometry directly.
 */

export type DrawingType =
  | "trend" | "hline" | "vline" | "rect" | "ray" | "extended"
  | "fib-retracement" | "fib-extension" | "channel" | "text" | "measure" | "brush";

export interface DrawingPoint { time: number; price: number }

export interface DrawingStyle {
  color: string;
  width: number;
  dash: "solid" | "dashed" | "dotted";
  fontSize: number;
}

export interface Drawing {
  id: string;
  type: DrawingType;
  /** 1 point: hline/vline/text · 2: trend/rect/ray/extended/measure/fib-retr · 3: fib-ext/channel · freehand: brush (N points) */
  points: DrawingPoint[];
  style: DrawingStyle;
  text?: string;
  /** true → ignored by hit-testing (interactive drag in progress) */
  locked?: boolean;
  /** true → not rendered and not hit-tested (visibility toggle) */
  hidden?: boolean;
}

export const FIB_RETRACEMENT_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
export const FIB_EXTENSION_LEVELS = [0, 0.618, 1, 1.618, 2.618];

export const DEFAULT_STYLE: DrawingStyle = {
  color: "#38bdf8",
  width: 2,
  dash: "solid",
  fontSize: 12,
};

export function makeDrawing(type: DrawingType, points: DrawingPoint[], text?: string): Drawing {
  return { id: `d${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`, type, points, style: { ...DEFAULT_STYLE }, text };
}

/** Points required by each tool (clicked before the drawing commits). */
export const TOOL_POINT_COUNT: Record<DrawingType, number> = {
  trend: 2, hline: 1, vline: 1, rect: 2, ray: 2, extended: 2,
  "fib-retracement": 2, "fib-extension": 3, channel: 3, text: 1, measure: 2,
  /** freehand: points collected until the pointer is released */
  brush: -1,
};

// ---------------------------------------------------------------------------
// Geometry helpers (canvas-space)
// ---------------------------------------------------------------------------

export interface XY { x: number; y: number }

/** Squared distance from point P to segment AB. */
export function distToSegmentSq(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return (p.x - a.x) ** 2 + (p.y - a.y) ** 2;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return (p.x - (a.x + t * dx)) ** 2 + (p.y - (a.y + t * dy)) ** 2;
}

/** Ray AB extended through B to the edge; returns the segment clipped to [0,w]×[0,h]. */
export function rayToEdge(a: XY, b: XY, w: number, h: number): { a: XY; b: XY } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return { a, b };
  let tMax = Infinity;
  if (dx !== 0) tMax = Math.min(tMax, dx > 0 ? (w - a.x) / dx : (0 - a.x) / dx);
  if (dy !== 0) tMax = Math.min(tMax, dy > 0 ? (h - a.y) / dy : (0 - a.y) / dy);
  if (!Number.isFinite(tMax)) tMax = 1;
  return { a, b: { x: a.x + dx * tMax, y: a.y + dy * tMax } };
}

/**
 * Extended line AB — infinite in BOTH directions, clipped to the canvas.
 * Returns the visible segment as { a, b }.
 */
export function extendedToEdge(a: XY, b: XY, w: number, h: number): { a: XY; b: XY } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return { a, b };
  // parametrize P(t) = a + t·d; find the t-interval that stays inside the box
  let tMin = -Infinity;
  let tMax = Infinity;
  const clip = (num: number, den: number) => {
    if (den === 0) return;
    const t = num / den;
    if (den > 0) tMax = Math.min(tMax, t);
    else tMin = Math.max(tMin, t);
  };
  clip(0 - a.x, dx); clip(w - a.x, dx);
  clip(0 - a.y, dy); clip(h - a.y, dy);
  if (tMin > tMax) return { a, b };
  return {
    a: { x: a.x + dx * tMin, y: a.y + dy * tMin },
    b: { x: a.x + dx * tMax, y: a.y + dy * tMax },
  };
}

/** Third anchor of a parallel channel: the line through A′B′ translated by C−P (projection). */
export function channelOffset(a: XY, b: XY, c: XY): { from: XY; to: XY } {
  // project C onto line AB, then translate the segment by (C − projection)
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy || 1;
  const t = ((c.x - a.x) * dx + (c.y - a.y) * dy) / lenSq;
  const proj = { x: a.x + dx * t, y: a.y + dy * t };
  const ox = c.x - proj.x;
  const oy = c.y - proj.y;
  return { from: { x: a.x + ox, y: a.y + oy }, to: { x: b.x + ox, y: b.y + oy } };
}

export function pointInRect(p: XY, a: XY, b: XY, pad = 0): boolean {
  const x1 = Math.min(a.x, b.x) - pad;
  const x2 = Math.max(a.x, b.x) + pad;
  const y1 = Math.min(a.y, b.y) - pad;
  const y2 = Math.max(a.y, b.y) + pad;
  return p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
}

// ---------------------------------------------------------------------------
// Hit-testing
// ---------------------------------------------------------------------------

/** What a click at canvas position `p` may interact with. */
export interface HitResult {
  /** drawing index in the provided array */
  index: number;
  /** endpoint handle (0-based point index) if the click is on a handle */
  handle?: number;
}

const HANDLE_HIT = 8;   // px radius around endpoints
const LINE_HIT = 5;     // px distance to a line body
const TEXT_HIT = 6;     // pad around text box edges

/** Text box approximation used for hit-testing text drawings. */
export function textBounds(text: string, fontSize: number, at: XY): { x: number; y: number; w: number; h: number } {
  const w = Math.max(24, text.length * fontSize * 0.62);
  return { x: at.x, y: at.y - fontSize, w, h: fontSize * 1.6 };
}

/**
 * Top-most drawing hit at `p`. Canvas-space points per drawing are supplied
 * by the caller via `toCanvas(drawing) → XY[]`.
 */
export function hitTest(
  p: XY,
  drawings: Drawing[],
  toCanvas: (d: Drawing) => XY[],
  canvasW: number,
  canvasH: number,
): HitResult | null {
  for (let i = drawings.length - 1; i >= 0; i--) {
    const d = drawings[i];
    if (d.locked || d.hidden) continue;
    const pts = toCanvas(d);
    if (!pts.length) continue;

    // endpoint handles first — they win over the body
    for (let h = 0; h < pts.length; h++) {
      if ((p.x - pts[h].x) ** 2 + (p.y - pts[h].y) ** 2 <= HANDLE_HIT * HANDLE_HIT) {
        return { index: i, handle: h };
      }
    }

    switch (d.type) {
      case "trend":
        if (distToSegmentSq(p, pts[0], pts[1]) <= LINE_HIT * LINE_HIT) return { index: i };
        break;
      case "ray": {
        const ext = rayToEdge(pts[0], pts[1], canvasW, canvasH);
        if (distToSegmentSq(p, ext.a, ext.b) <= LINE_HIT * LINE_HIT) return { index: i };
        break;
      }
      case "extended": {
        const ext = extendedToEdge(pts[0], pts[1], canvasW, canvasH);
        if (distToSegmentSq(p, ext.a, ext.b) <= LINE_HIT * LINE_HIT) return { index: i };
        break;
      }
      case "hline":
        if (Math.abs(p.y - pts[0].y) <= LINE_HIT) return { index: i };
        break;
      case "vline":
        if (Math.abs(p.x - pts[0].x) <= LINE_HIT) return { index: i };
        break;
      case "rect":
        // inside the rect or on one of its edges
        if (pointInRect(p, pts[0], pts[1], LINE_HIT)) return { index: i };
        break;
      case "measure":
        if (pointInRect(p, pts[0], pts[1], LINE_HIT)) return { index: i };
        break;
      case "brush": {
        for (let k = 1; k < pts.length; k++) {
          if (distToSegmentSq(p, pts[k - 1], pts[k]) <= LINE_HIT * LINE_HIT) return { index: i };
        }
        break;
      }
      case "channel": {
        const off = channelOffset(pts[0], pts[1], pts[2]);
        if (distToSegmentSq(p, pts[0], pts[1]) <= LINE_HIT * LINE_HIT) return { index: i };
        if (distToSegmentSq(p, off.from, off.to) <= LINE_HIT * LINE_HIT) return { index: i };
        break;
      }
      case "fib-retracement": {
        const lo = Math.min(pts[0].y, pts[1].y);
        const hi = Math.max(pts[0].y, pts[1].y);
        const x1 = Math.min(pts[0].x, pts[1].x);
        const x2 = Math.max(pts[0].x, pts[1].x);
        const inX = p.x >= x1 - LINE_HIT && p.x <= x2 + LINE_HIT;
        if (inX && p.y >= lo - LINE_HIT && p.y <= hi + LINE_HIT) return { index: i };
        break;
      }
      case "fib-extension": {
        // bounding box of the three anchors (generous — the fan spans it)
        const xs = pts.map((q) => q.x);
        const ys = pts.map((q) => q.y);
        const inX = p.x >= Math.min(...xs) - LINE_HIT && p.x <= Math.max(...xs) + LINE_HIT;
        const inY = p.y >= Math.min(...ys) - LINE_HIT && p.y <= Math.max(...ys) + LINE_HIT;
        if (inX && inY) return { index: i };
        break;
      }
      case "text": {
        const bnd = textBounds(d.text || "Text", d.style.fontSize, pts[0]);
        if (p.x >= bnd.x - TEXT_HIT && p.x <= bnd.x + bnd.w + TEXT_HIT && p.y >= bnd.y - TEXT_HIT && p.y <= bnd.y + bnd.h + TEXT_HIT) {
          return { index: i };
        }
        break;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Canvas rendering (shared by the overlay layer)
// ---------------------------------------------------------------------------

export function dashPattern(dash: DrawingStyle["dash"]): number[] {
  return dash === "dashed" ? [6, 4] : dash === "dotted" ? [2, 3] : [];
}

export function setupCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

export function applyStyle(ctx: CanvasRenderingContext2D, style: DrawingStyle, alpha = 1): void {
  ctx.strokeStyle = style.color;
  ctx.fillStyle = style.color;
  ctx.lineWidth = style.width;
  ctx.globalAlpha = alpha;
  ctx.setLineDash(dashPattern(style.dash));
}

export function drawSegment(ctx: CanvasRenderingContext2D, a: XY, b: XY): void {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

export function drawHandle(ctx: CanvasRenderingContext2D, p: XY, active: boolean): void {
  ctx.save();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.fillStyle = active ? "#f59e0b" : "#0f172a";
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** Draw one committed drawing (interactive tools draw their own preview). */
export function renderDrawing(
  ctx: CanvasRenderingContext2D,
  d: Drawing,
  pts: XY[],
  canvasW: number,
  canvasH: number,
  selected: boolean,
): void {
  if (!pts.length || d.hidden) return;
  applyStyle(ctx, d.style, selected ? 1 : 0.92);

  switch (d.type) {
    case "trend":
      drawSegment(ctx, pts[0], pts[1]);
      break;
    case "ray": {
      const ext = rayToEdge(pts[0], pts[1], canvasW, canvasH);
      drawSegment(ctx, ext.a, ext.b);
      break;
    }
    case "extended": {
      const ext = extendedToEdge(pts[0], pts[1], canvasW, canvasH);
      drawSegment(ctx, ext.a, ext.b);
      break;
    }
    case "hline":
      drawSegment(ctx, { x: 0, y: pts[0].y }, { x: canvasW, y: pts[0].y });
      break;
    case "vline":
      drawSegment(ctx, { x: pts[0].x, y: 0 }, { x: pts[0].x, y: canvasH });
      break;
    case "rect": {
      const x = Math.min(pts[0].x, pts[1].x);
      const y = Math.min(pts[0].y, pts[1].y);
      const w = Math.abs(pts[1].x - pts[0].x);
      const h = Math.abs(pts[1].y - pts[0].y);
      ctx.save();
      ctx.globalAlpha = 0.12;
      ctx.fillRect(x, y, w, h);
      ctx.restore();
      ctx.strokeRect(x, y, w, h);
      break;
    }
    case "channel": {
      const off = channelOffset(pts[0], pts[1], pts[2]);
      drawSegment(ctx, pts[0], pts[1]);
      drawSegment(ctx, off.from, off.to);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.globalAlpha = 0.45;
      // guide line connecting the midpoints
      drawSegment(ctx, { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }, { x: (off.from.x + off.to.x) / 2, y: (off.from.y + off.to.y) / 2 });
      ctx.restore();
      break;
    }
    case "fib-retracement": {
      const [p0, p1] = pts;
      const x1 = Math.min(p0.x, p1.x);
      const x2 = Math.max(p0.x, p1.x);
      for (const lvl of FIB_RETRACEMENT_LEVELS) {
        const y = p0.y + (p1.y - p0.y) * lvl;
        ctx.save();
        ctx.globalAlpha = lvl === 0 || lvl === 1 ? 0.9 : 0.7;
        drawSegment(ctx, { x: x1, y }, { x: x2, y });
        ctx.setLineDash([]);
        ctx.globalAlpha = 0.9;
        ctx.font = `${d.style.fontSize}px ui-sans-serif, system-ui`;
        ctx.fillText(`${(lvl * 100).toFixed(1)}%`, x1 + 4, y - 3);
        ctx.restore();
      }
      break;
    }
    case "fib-extension": {
      const [p0, p1, p2] = pts;
      drawSegment(ctx, p0, p1);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.globalAlpha = 0.5;
      drawSegment(ctx, p1, p2);
      ctx.restore();
      const x2 = Math.max(p0.x, p1.x, p2.x);
      for (const lvl of FIB_EXTENSION_LEVELS) {
        const y = p2.y + (p1.y - p0.y) * lvl;
        ctx.save();
        ctx.globalAlpha = 0.7;
        drawSegment(ctx, { x: Math.min(p2.x, x2 - 40), y }, { x: x2, y });
        ctx.setLineDash([]);
        ctx.globalAlpha = 0.9;
        ctx.font = `${d.style.fontSize}px ui-sans-serif, system-ui`;
        ctx.fillText(`${(lvl * 100).toFixed(1)}%`, x2 - 58, y - 3);
        ctx.restore();
      }
      break;
    }
    case "brush": {
      for (let k = 1; k < pts.length; k++) drawSegment(ctx, pts[k - 1], pts[k]);
      break;
    }
    case "measure": {
      const x = Math.min(pts[0].x, pts[1].x);
      const y = Math.min(pts[0].y, pts[1].y);
      const w = Math.abs(pts[1].x - pts[0].x);
      const h = Math.abs(pts[1].y - pts[0].y);
      ctx.save();
      ctx.globalAlpha = 0.14;
      ctx.fillRect(x, y, w, h);
      ctx.restore();
      ctx.strokeRect(x, y, w, h);
      // committed measure text (market-space summary, set by the canvas layer)
      if (d.text) {
        ctx.save();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.font = `bold ${d.style.fontSize}px ui-sans-serif, system-ui`;
        const tw = ctx.measureText(d.text).width + 10;
        const lx = Math.min(x + w / 2 - tw / 2, canvasW - tw - 4);
        const ly = Math.max(4, y + h / 2 - d.style.fontSize);
        ctx.fillStyle = "rgba(15,23,42,0.9)";
        ctx.fillRect(lx, ly, tw, d.style.fontSize + 8);
        ctx.fillStyle = d.style.color;
        ctx.fillText(d.text, lx + 5, ly + d.style.fontSize + 2);
        ctx.restore();
      }
      break;
    }
    case "text": {
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      ctx.font = `${d.style.fontSize}px ui-sans-serif, system-ui`;
      ctx.fillText(d.text || "Text", pts[0].x, pts[0].y);
      ctx.restore();
      break;
    }
  }

  if (selected) {
    for (const p of pts) drawHandle(ctx, p, false);
  }
}
