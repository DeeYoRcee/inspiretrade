/**
 * Chart drawing tools — types, geometry and hit-testing.
 *
 * Anchors are stored in MARKET coordinates (time in seconds, price) so a
 * drawing survives timeframe switches, historical prepends and resize; pixel
 * conversion happens at render time via the chart's time/price scales.
 * This module is pure — the canvas layer (DrawingCanvas) renders and
 * interacts, and tests exercise the geometry directly.
 */
import type { Timeframe } from "@shared/terminal";

export type DrawingType =
  // trend lines
  | "trend" | "hline" | "vline" | "ray" | "extended" | "info-line" | "trend-angle"
  | "hray" | "hchannel" | "channel" | "regression" | "dchannel" | "pitchfork"
  // fibonaccis
  | "fib-retracement" | "fib-extension" | "fib-trend-ext" | "fib-channel"
  | "fib-timezone" | "fib-fan" | "fib-arc" | "fib-circle" | "fib-spiral" | "fib-wedge"
  // shapes & freehand
  | "rect" | "rrect" | "triangle" | "circle" | "ellipse" | "path" | "polyline"
  | "curve" | "double-curve" | "arc" | "brush" | "highlighter" | "arrow"
  | "arrow-marker" | "callout" | "price-label"
  // annotations
  | "text" | "anchored-text" | "note" | "price-note" | "signpost" | "comment"
  | "flag" | "price-range" | "date-range" | "datetime-range"
  // measurement & positions
  | "measure" | "long-position" | "short-position" | "forecast"
  // patterns
  | "elliott-impulse" | "elliott-correction" | "head-shoulders" | "xabcd" | "abcd" | "three-drives";

export interface DrawingPoint { time: number; price: number }

export interface DrawingStyle {
  color: string;
  width: number;
  dash: "solid" | "dashed" | "dotted";
  fontSize: number;
  /** shape fill — undefined = no fill (outline only) */
  fill?: { color: string; opacity: number };
  /** attached-text color (defaults to the line color) */
  textColor?: string;
  /** where the attached text sits relative to the anchors */
  textPos?: "start" | "end" | "above" | "below";
  /** trend-line extension: none = segment · left = backward ray · right = ray · both = infinite */
  extend?: "none" | "right" | "left" | "both";
  /** endpoint price labels on line tools */
  showLabels?: boolean;
  /** endpoint time labels on line tools */
  showTimeLabels?: boolean;
  /** Phase 37 §2 — print the level PRICE next to the % label (fib tools) */
  showPrices?: boolean;
  /** Phase 37 §2 — measure fib levels from the second anchor (reversed) */
  reverse?: boolean;
  /** P39 §1 — per-drawing transparency (1 = full). Multiplied with the
   *  selection alpha at render time, so EVERY tool honors it. */
  opacity?: number;
  /** P39 §7 — text formatting for attached text and text tools */
  fontWeight?: "normal" | "bold";
  textAlign?: "left" | "center" | "right";
  /** background chip behind text (color string) */
  textBg?: string;
}

/** one configurable Fibonacci level (ratio is the multiple of the measured span).
 *  Phase 37 §2: custom levels are addable/removable; per-level width/dash. */
export interface FibLevel {
  ratio: number;
  show: boolean;
  color?: string;
  width?: number;
  dash?: "solid" | "dashed" | "dotted";
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
  /** Fibonacci tools: per-level overrides — falls back to the tool defaults */
  levels?: FibLevel[];
  /** user-visible name (object tree); defaults to the tool type */
  name?: string;
  /** timeframe visibility — undefined/empty = visible on EVERY timeframe */
  tfs?: Timeframe[];
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

/**
 * Points required by each tool (clicked before the drawing commits).
 * -1 = collected while dragging (brush family) — commit on pointer-up.
 * -2 = click-collected — commit on double-click / Enter, cancel on Escape.
 */
export const TOOL_POINT_COUNT: Record<DrawingType, number> = {
  trend: 2, hline: 1, vline: 1, ray: 2, extended: 2,
  "info-line": 2, "trend-angle": 2, hray: 2, hchannel: 3, channel: 3, regression: 2, dchannel: 4,
  pitchfork: 3,
  "fib-retracement": 2, "fib-extension": 3, "fib-trend-ext": 3, "fib-channel": 3,
  "fib-timezone": 2, "fib-fan": 2, "fib-arc": 2, "fib-circle": 2, "fib-spiral": 2, "fib-wedge": 3,
  rect: 2, rrect: 3, triangle: 3, circle: 2, ellipse: 2,
  path: -2, polyline: -2, curve: 3, "double-curve": 4, arc: 3,
  brush: -1, highlighter: -1, arrow: 2, "arrow-marker": 2, callout: 2, "price-label": 1,
  text: 1, "anchored-text": 1, note: 1, "price-note": 1, signpost: 1, comment: 1, flag: 1,
  "price-range": 2, "date-range": 2, "datetime-range": 2,
  measure: 2, "long-position": 3, "short-position": 3, forecast: 3,
  "elliott-impulse": 6, "elliott-correction": 4, "head-shoulders": 7,
  xabcd: 5, abcd: 4, "three-drives": 6,
};

/** Per-point labels for pattern/fib/position tools (rendered at every anchor). */
export const TOOL_LABELS: Partial<Record<DrawingType, string[]>> = {
  "elliott-impulse": ["0", "1", "2", "3", "4", "5"],
  "elliott-correction": ["0", "A", "B", "C"],
  "head-shoulders": ["LS", "", "H", "", "RS", "", ""],
  xabcd: ["X", "A", "B", "C", "D"],
  abcd: ["A", "B", "C", "D"],
  "three-drives": ["1", "A", "2", "B", "3", "C"],
  "long-position": ["Entry", "Stop", "Target"],
  "short-position": ["Entry", "Stop", "Target"],
  pitchfork: ["P0", "P1", "P2"],
};

/** Tools that ask for their text content on commit (single prompt, like TV). */
export const TEXT_TOOLS: ReadonlySet<DrawingType> = new Set<DrawingType>([
  "text", "anchored-text", "note", "price-note", "signpost", "comment", "flag", "callout",
]);

/** Click-collected multi-point tools — commit on double-click / Enter. */
export const CLICK_COLLECT_TOOLS: ReadonlySet<DrawingType> = new Set<DrawingType>(["path", "polyline"]);

/** Fib tools whose defaults can be customized per level. */
export const FIB_TOOLS: ReadonlySet<DrawingType> = new Set<DrawingType>([
  "fib-retracement", "fib-extension", "fib-trend-ext", "fib-channel",
  "fib-timezone", "fib-fan", "fib-arc", "fib-circle", "fib-spiral", "fib-wedge",
]);

/** Default Fibonacci level sets per tool (multiples of the measured span). */
export const FIB_DEFAULT_LEVELS: Partial<Record<DrawingType, number[]>> = {
  // Phase 27 §5: the full standard level set — the props bar lets users
  // toggle individual levels off, so showing the complete list is safe
  "fib-retracement": [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2, 2.618],
  "fib-extension": [0, 0.618, 1, 1.618, 2.618],
  "fib-trend-ext": [0, 0.618, 1, 1.618, 2.618],
  "fib-channel": [0.382, 0.5, 0.618, 1, 1.618],
  "fib-timezone": [0, 1, 1.618, 2.618, 4.236],
  "fib-fan": [0.236, 0.382, 0.5, 0.618, 0.786],
  "fib-arc": [0.236, 0.382, 0.5, 0.618, 1],
  "fib-circle": [0.236, 0.382, 0.5, 0.618, 1],
  "fib-spiral": [0.618, 1, 1.618, 2.618],
  "fib-wedge": [0.382, 0.5, 0.618],
};

/** Effective levels for a drawing: per-drawing overrides or the tool defaults. */
export function levelsFor(d: Drawing): FibLevel[] {
  if (d.levels?.length) return d.levels;
  const defaults = FIB_DEFAULT_LEVELS[d.type];
  return defaults ? defaults.map((ratio) => ({ ratio, show: true })) : [];
}

/** Phase 37 §2 — pure Fibonacci level-price math (retracement & extension
 *  families), independent of canvas code so it can be unit-tested.
 *  retracement: price = from + (to − from) × ratio, measured p0→p1
 *  (reverse: measured p1→p0, levels project beyond p0).
 *  extension: the p0→p1 swing projected from p2:
 *  price = p2 + (p1 − p0) × ratio (reverse projects p0−p1). */
export function fibLevelPrice(
  kind: "retracement" | "extension",
  p0: number, p1: number, p2: number,
  ratio: number, reverse = false,
): number {
  if (kind === "extension") return reverse ? p2 + (p0 - p1) * ratio : p2 + (p1 - p0) * ratio;
  const a = reverse ? p1 : p0;
  const b = reverse ? p0 : p1;
  return a + (b - a) * ratio;
}

export interface LineSeg { from: XY; to: XY }

/** Phase 37 §1 — Andrews pitchfork tines (pure): median from P0 through the
 *  P1/P2 midpoint, upper/lower prongs through P1/P2 parallel to the median,
 *  all extended to `edgeX`. Caller picks the edge side from the direction. */
export function pitchforkLines(p0: XY, p1: XY, p2: XY, edgeX: number): {
  median: LineSeg; upper: LineSeg; lower: LineSeg;
} {
  const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const dir = { x: mid.x - p0.x, y: mid.y - p0.y };
  const toEdge = (from: XY): XY => {
    if (Math.abs(dir.x) < 1e-9) return { x: from.x, y: from.y + (dir.y >= 0 ? 1 : -1) * 1e4 };
    const t = (edgeX - from.x) / dir.x;
    if (t <= 0) return { x: from.x, y: from.y };
    return { x: edgeX, y: from.y + dir.y * t };
  };
  return {
    median: { from: p0, to: toEdge(p0) },
    upper: { from: p1, to: toEdge(p1) },
    lower: { from: p2, to: toEdge(p2) },
  };
}

/** Phase 37 §5 — validate a level list from persistence/presets (used by
 *  __sanitizeDrawingList and the fib-preset store). */
export function sanitizeFibLevels(raw: unknown): FibLevel[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: FibLevel[] = [];
  for (const l of raw) {
    if (!l || typeof l !== "object") continue;
    const o = l as Record<string, unknown>;
    const ratio = Number(o.ratio);
    if (!Number.isFinite(ratio) || ratio < -10 || ratio > 100) continue;
    const lv: FibLevel = { ratio, show: o.show !== false };
    if (typeof o.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(o.color)) lv.color = o.color;
    const w = Number(o.width);
    if (Number.isFinite(w)) lv.width = Math.min(6, Math.max(1, Math.round(w)));
    if (o.dash === "dashed" || o.dash === "dotted" || o.dash === "solid") lv.dash = o.dash;
    out.push(lv);
  }
  return out.length ? out.slice(0, 64) : undefined;
}

/** Market-price formatter for drawing labels — Phase 26 D1: measurement
 * labels used to print CANVAS PIXEL deltas (`pts[].y`) as if they were
 * prices. Anchors are market coordinates, so the real values come from
 * d.points[].price; this renders them with sensible precision and no
 * trailing zeros. */
export function fmtDrawingPrice(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const digits = a >= 1000 ? 1 : a >= 10 ? 2 : 4;
  return v.toFixed(digits).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/**
 * Timeframe visibility — undefined/empty list = every timeframe. Hiding a
 * drawing on one timeframe NEVER deletes it: the anchors stay in market
 * coordinates and the setting lives on the drawing itself.
 */
export function isVisibleOnTf(d: Drawing, tf: Timeframe): boolean {
  return !d.tfs || d.tfs.length === 0 || d.tfs.includes(tf);
}

/** Object-tree label: the user's rename wins over the tool type. */
export function effectiveName(d: Drawing): string {
  return d.name?.trim() || d.type;
}

/** Risk/reward for the position tools: (target − entry) / (entry − stop). */
export function riskReward(entry: number, stop: number, target: number): { rr: number; risk: number; reward: number } {
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  return { rr: risk > 0 ? reward / risk : 0, risk, reward };
}

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
  // axis-aligned lines never intersect one of the clip axes — handle them
  // directly (the general clip below left tMin at −Infinity → NaN hit-tests)
  if (dx === 0) return { a: { x: a.x, y: 0 }, b: { x: a.x, y: h } };
  if (dy === 0) return { a: { x: 0, y: a.y }, b: { x: w, y: a.y } };
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

/** Arrowhead at the END of segment a→b (returns the two wing points). */
export function arrowHead(a: XY, b: XY, size = 10): { w1: XY; w2: XY } {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const spread = Math.PI / 7;
  return {
    w1: { x: b.x - size * Math.cos(ang - spread), y: b.y - size * Math.sin(ang - spread) },
    w2: { x: b.x - size * Math.cos(ang + spread), y: b.y - size * Math.sin(ang + spread) },
  };
}

/** Least-squares regression line (slope/intercept in canvas space) over bars. */
export function regressionLine(points: XY[]): { m: number; b: number } | null {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const q of points) { sx += q.x; sy += q.y; sxx += q.x * q.x; sxy += q.x * q.y; }
  const den = n * sxx - sx * sx;
  if (den === 0) return null;
  const m = (n * sxy - sx * sy) / den;
  return { m, b: (sy - m * sx) / n };
}

/** Quadratic bezier point at t (P0, control C, P1). */
export function bezierPoint(p0: XY, c: XY, p1: XY, t: number): XY {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
  };
}

/** Polygon polyline of a quadratic bezier (P0 → control C → P1). */
export function bezierPolyline(p0: XY, c: XY, p1: XY, steps = 24): XY[] {
  const out: XY[] = [];
  for (let i = 0; i <= steps; i++) out.push(bezierPoint(p0, c, p1, i / steps));
  return out;
}

/** Circumcenter of three points (for the 3-point arc tool); null if colinear. */
export function circumcenter(a: XY, b: XY, c: XY): { x: number; y: number; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const ux = ((a.x ** 2 + a.y ** 2) * (b.y - c.y) + (b.x ** 2 + b.y ** 2) * (c.y - a.y) + (c.x ** 2 + c.y ** 2) * (a.y - b.y)) / d;
  const uy = ((a.x ** 2 + a.y ** 2) * (c.x - b.x) + (b.x ** 2 + b.y ** 2) * (a.x - c.x) + (c.x ** 2 + c.y ** 2) * (b.x - a.x)) / d;
  return { x: ux, y: uy, r: Math.hypot(a.x - ux, a.y - uy) };
}

/** Inside test for an axis-aligned ellipse defined by corner points a, b. */
export function pointInEllipse(p: XY, a: XY, b: XY, pad = 0): boolean {
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const rx = Math.abs(b.x - a.x) / 2 + pad, ry = Math.abs(b.y - a.y) / 2 + pad;
  if (rx <= 0 || ry <= 0) return false;
  return ((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2 <= 1;
}

/** Barycentric inside test for a triangle. */
export function pointInTri(p: XY, a: XY, b: XY, c: XY): boolean {
  const s1 = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const s2 = (c.x - b.x) * (p.y - b.y) - (c.y - b.y) * (p.x - b.x);
  const s3 = (a.x - c.x) * (p.y - c.y) - (a.y - c.y) * (p.x - c.x);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
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
      case "trend": {
        // P38 §6 — the hit zone follows the extension mode, so clicking the
        // extended part of a ray still selects the drawing
        const mode = d.style.extend || "none";
        if (mode === "right" || mode === "left") {
          const ext = mode === "right"
            ? rayToEdge(pts[0], pts[1], canvasW, canvasH)
            : rayToEdge(pts[1], pts[0], canvasW, canvasH);
          if (distToSegmentSq(p, ext.a, ext.b) <= LINE_HIT * LINE_HIT) return { index: i };
        } else if (mode === "both") {
          const ext = extendedToEdge(pts[0], pts[1], canvasW, canvasH);
          if (distToSegmentSq(p, ext.a, ext.b) <= LINE_HIT * LINE_HIT) return { index: i };
        } else if (distToSegmentSq(p, pts[0], pts[1]) <= LINE_HIT * LINE_HIT) return { index: i };
        break;
      }
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
      if (pts.length < 3) break; // P39b: mid-creation preview may be short
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
      if (pts.length < 3) break; // P39b: mid-creation preview may be short
        // bounding box of the three anchors (generous — the fan spans it)
        const xs = pts.map((q) => q.x);
        const ys = pts.map((q) => q.y);
        const inX = p.x >= Math.min(...xs) - LINE_HIT && p.x <= Math.max(...xs) + LINE_HIT;
        const inY = p.y >= Math.min(...ys) - LINE_HIT && p.y <= Math.max(...ys) + LINE_HIT;
        if (inX && inY) return { index: i };
        break;
      }
      case "hchannel": {
      if (pts.length < 3) break; // P39b: mid-creation preview may be short
        const y1 = pts[0].y;
        const y2 = pts[2].y;
        const inX = p.x >= Math.min(pts[0].x, pts[1].x) - LINE_HIT && p.x <= Math.max(pts[0].x, pts[1].x) + LINE_HIT;
        if (inX && p.y >= Math.min(y1, y2) - LINE_HIT && p.y <= Math.max(y1, y2) + LINE_HIT) return { index: i };
        break;
      }
      case "hray": {
        const dir = pts[1].x >= pts[0].x ? 1 : -1;
        const seg = rayToEdge(pts[0], { x: pts[0].x + dir * canvasW, y: pts[0].y }, canvasW, canvasH);
        if (distToSegmentSq(p, seg.a, seg.b) <= LINE_HIT * LINE_HIT) return { index: i };
        break;
      }
      case "triangle": {
      if (pts.length < 3) break; // P39b: mid-creation preview may be short
        if (pointInTri(p, pts[0], pts[1], pts[2])) return { index: i };
        break;
      }
      case "circle": {
        const r = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        const dist = Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
        if (dist <= r + LINE_HIT) return { index: i };
        break;
      }
      case "ellipse": {
        if (pointInEllipse(p, pts[0], pts[1], LINE_HIT)) return { index: i };
        break;
      }
      case "rrect":
      case "price-range":
      case "date-range":
      case "datetime-range":
      case "long-position":
      case "short-position":
      case "forecast":
      case "fib-trend-ext":
      case "fib-channel":
      case "fib-wedge":
      case "dchannel":
      case "curve":
      case "double-curve":
      case "arc": {
      if (pts.length < 3) break; // P39b: mid-creation preview may be short
        const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
        if (p.x >= Math.min(...xs) - LINE_HIT && p.x <= Math.max(...xs) + LINE_HIT &&
            p.y >= Math.min(...ys) - LINE_HIT && p.y <= Math.max(...ys) + LINE_HIT) return { index: i };
        break;
      }
      case "polyline":
      case "path": {
        for (let k = 1; k < pts.length; k++) {
          if (distToSegmentSq(p, pts[k - 1], pts[k]) <= LINE_HIT * LINE_HIT) return { index: i };
        }
        break;
      }
      case "arrow":
      case "info-line":
      case "trend-angle": {
        if (distToSegmentSq(p, pts[0], pts[1]) <= LINE_HIT * LINE_HIT) return { index: i };
        break;
      }
      case "regression": {
        if (pointInRect(p, pts[0], pts[1], LINE_HIT)) return { index: i };
        break;
      }
      case "fib-timezone": {
        // the timezone lines render across the FULL canvas height
        const xs = pts.map((q) => q.x);
        if (p.x >= Math.min(...xs) - LINE_HIT && p.x <= Math.max(...xs) + LINE_HIT) return { index: i };
        break;
      }
      case "pitchfork": {
        const edgeX = (pts[1].x + pts[2].x) / 2 >= pts[0].x ? 1e6 : -1e6;
        const L = pitchforkLines(pts[0], pts[1], pts[2], edgeX);
        const rays: LineSeg[] = [L.upper, L.median, L.lower];
        for (const ray of rays) {
          if (distToSegmentSq(p, ray.from, ray.to) <= LINE_HIT * LINE_HIT) return { index: i };
        }
        break;
      }
      case "fib-fan":
      case "fib-arc":
      case "fib-circle":
      case "fib-spiral": {
        const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
        if (p.x >= Math.min(...xs) - LINE_HIT && p.x <= Math.max(...xs) + LINE_HIT &&
            p.y >= Math.min(...ys) - LINE_HIT && p.y <= Math.max(...ys) + LINE_HIT) return { index: i };
        break;
      }
      case "highlighter": {
        for (let k = 1; k < pts.length; k++) {
          if (distToSegmentSq(p, pts[k - 1], pts[k]) <= LINE_HIT * 2) return { index: i };
        }
        break;
      }
      case "arrow-marker":
      case "price-label":
      case "anchored-text":
      case "note":
      case "price-note":
      case "signpost":
      case "comment":
      case "flag":
      case "callout": {
        const bnd = textBounds(d.text || "A", d.style.fontSize, pts[0]);
        if (p.x >= bnd.x - TEXT_HIT && p.x <= bnd.x + bnd.w + TEXT_HIT && p.y >= bnd.y - TEXT_HIT && p.y <= bnd.y + bnd.h + TEXT_HIT) return { index: i };
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

/** Optional shape fill from the drawing style. */
function applyFill(ctx: CanvasRenderingContext2D, d: Drawing): void {
  if (!d.style.fill || d.style.fill.opacity <= 0) return;
  ctx.save();
  ctx.fillStyle = d.style.fill.color || d.style.color;
  ctx.globalAlpha = d.style.fill.opacity;
  ctx.setLineDash([]);
  ctx.fill();
  ctx.restore();
}

function drawArrowHead(ctx: CanvasRenderingContext2D, a: XY, b: XY, size = 10): void {
  const { w1, w2 } = arrowHead(a, b, size);
  ctx.save();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(w1.x, w1.y);
  ctx.lineTo(w2.x, w2.y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Per-point labels for pattern/position tools. */
function drawPointLabels(ctx: CanvasRenderingContext2D, d: Drawing, pts: XY[]): void {
  const labels = TOOL_LABELS[d.type];
  if (!labels) return;
  ctx.save();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.font = `bold ${d.style.fontSize}px ui-sans-serif, system-ui`;
  ctx.fillStyle = d.style.color;
  for (let k = 0; k < pts.length && k < labels.length; k++) {
    if (!labels[k]) continue;
    ctx.fillText(labels[k], pts[k].x + 5, pts[k].y - 5);
  }
  ctx.restore();
}

/** Fibonacci level list (per-drawing overrides > tool defaults), filtered by show. */
function visibleLevels(d: Drawing): FibLevel[] {
  return levelsFor(d).filter((l) => l.show);
}

/**
 * Attached text for line/shape/fib tools — lives ON the drawing (moves with
 * it, saved with it). Text-rendering tools (text/note/callout/…) paint their
 * own and are excluded by the caller.
 */
export const TEXT_RENDERED_EXPLICITLY: ReadonlySet<DrawingType> = new Set<DrawingType>([
  "text", "anchored-text", "note", "price-note", "signpost", "comment", "flag", "callout", "price-label",
]);

function drawAttachedText(ctx: CanvasRenderingContext2D, d: Drawing, pts: XY[]): void {
  if (!d.text || !pts.length || TEXT_RENDERED_EXPLICITLY.has(d.type)) return;
  const pos = d.style.textPos || "start";
  let at: XY;
  if (pos === "end") at = pts[pts.length - 1];
  else if (pos === "above" || pos === "below") {
    const a = pts[0], b = pts[pts.length - 1];
    at = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  } else at = pts[0];
  const dy = pos === "below" ? d.style.fontSize + 6 : -6;
  ctx.save();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.font = `${d.style.fontWeight === "bold" ? "bold " : ""}${d.style.fontSize}px ui-sans-serif, system-ui`;
  ctx.textAlign = d.style.textAlign === "center" ? "center" : d.style.textAlign === "right" ? "right" : "left";
  if (d.style.textBg) {
    // P39 §7 — background chip sized from the actual text metrics
    const w2 = ctx.measureText(d.text).width + 6;
    const bx = ctx.textAlign === "center" ? at.x + 4 - w2 / 2 : ctx.textAlign === "right" ? at.x + 4 - w2 + 3 : at.x + 1;
    ctx.fillStyle = d.style.textBg;
    ctx.globalAlpha = 0.8 * (d.style.opacity ?? 1);
    ctx.fillRect(bx, at.y + dy - d.style.fontSize, w2, d.style.fontSize + 5);
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = d.style.textColor || d.style.color;
  ctx.fillText(d.text, at.x + 4, at.y + dy);
  ctx.restore();
}

/** P39 §2 — human duration for the trend Δ label (m / h / d) */
function fmtDur(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return "";
  const days = secs / 86400;
  if (days >= 1) return `${days >= 10 ? Math.round(days) : Math.round(days * 10) / 10}d`;
  const hours = secs / 3600;
  if (hours >= 1) return `${Math.round(hours * 10) / 10}h`;
  const mins = Math.round(secs / 60);
  return mins > 0 ? `${mins}m` : "";
}

/** Endpoint price/time labels for line tools (both toggleable). */
function drawEndpointLabels(ctx: CanvasRenderingContext2D, d: Drawing, pts: XY[]): void {
  if (!(d.style.showLabels || d.style.showTimeLabels) || pts.length < 2) return;
  ctx.save();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.font = `${Math.max(9, d.style.fontSize - 1)}px ui-sans-serif, system-ui`;
  for (let i = 0; i < pts.length; i++) {
    const lines: string[] = [];
    if (d.style.showLabels && d.points[i]) lines.push(String(d.points[i].price));
    if (d.style.showTimeLabels && d.points[i]) {
      const t = new Date(d.points[i].time * 1000);
      lines.push(`${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")} ${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`);
    }
    lines.forEach((ln, k) => ctx.fillText(ln, pts[i].x + 4, pts[i].y - 4 - k * (d.style.fontSize - 1)));
  }
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
  applyStyle(ctx, d.style, (selected ? 1 : 0.92) * (d.style.opacity ?? 1));

  switch (d.type) {
    case "trend": {
      const mode = d.style.extend || "none";
      if (mode === "right") {
        const ext = rayToEdge(pts[0], pts[1], canvasW, canvasH);
        drawSegment(ctx, ext.a, ext.b);
      } else if (mode === "both") {
        const ext = extendedToEdge(pts[0], pts[1], canvasW, canvasH);
        drawSegment(ctx, ext.a, ext.b);
      } else if (mode === "left") {
        // P38 §6 — backward ray: from the end anchor through the start anchor
        const ext = rayToEdge(pts[1], pts[0], canvasW, canvasH);
        drawSegment(ctx, ext.a, ext.b);
      } else {
        drawSegment(ctx, pts[0], pts[1]);
      }
      drawEndpointLabels(ctx, d, pts);
      // P38 §6 — Δ price + % over the leg (props-bar "Δ" toggle)
      if (d.style.showPrices && d.points.length >= 2) {
        const dp = d.points[1].price - d.points[0].price;
        const pct = d.points[0].price ? (dp / d.points[0].price) * 100 : 0;
        const dur = fmtDur(Math.abs(d.points[1].time - d.points[0].time));
        ctx.save();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.font = `${d.style.fontSize}px ui-sans-serif, system-ui`;
        ctx.fillStyle = d.style.textColor || d.style.color;
        const sign = dp >= 0 ? "+" : "";
        ctx.fillText(`${sign}${fmtDrawingPrice(dp)} (${sign}${pct.toFixed(2)}%)${dur ? ` · ${dur}` : ""}`, pts[1].x + 6, pts[1].y + d.style.fontSize + 4);
        ctx.restore();
      }
      break;
    }
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
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      applyFill(ctx, d);
      ctx.strokeRect(x, y, w, h);
      break;
    }
    case "channel": {
      const off = channelOffset(pts[0], pts[1], pts[2]);
      // P39 §4 — the fill slider actually fills the channel body
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.lineTo(off.to.x, off.to.y);
      ctx.lineTo(off.from.x, off.from.y);
      ctx.closePath();
      applyFill(ctx, d);
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
      const reverse = d.style.reverse === true;
      const a = reverse ? p1 : p0;
      const b = reverse ? p0 : p1;
      const x1 = Math.min(p0.x, p1.x);
      // Phase 37 §2 — extend levels to the right edge when requested
      const x2 = d.style.extend === "right" || d.style.extend === "both" ? canvasW : Math.max(p0.x, p1.x);
      for (const lvl of visibleLevels(d)) {
        const y = a.y + (b.y - a.y) * lvl.ratio;
        ctx.save();
        if (lvl.color) ctx.strokeStyle = lvl.color;
        if (lvl.width) ctx.lineWidth = lvl.width;
        if (lvl.dash) ctx.setLineDash(lvl.dash === "dashed" ? [6, 4] : lvl.dash === "dotted" ? [2, 3] : []);
        ctx.globalAlpha = lvl.ratio === 0 || lvl.ratio === 1 ? 0.9 : 0.7;
        drawSegment(ctx, { x: x1, y }, { x: x2, y });
        if (d.style.showLabels !== false) {
          ctx.setLineDash([]);
          ctx.globalAlpha = 0.9;
          ctx.font = `${d.style.fontSize}px ui-sans-serif, system-ui`;
          const priceTxt = d.style.showPrices && d.points.length >= 2
            ? ` ${fmtDrawingPrice(fibLevelPrice("retracement", d.points[0].price, d.points[1].price, 0, lvl.ratio, reverse))}`
            : "";
          ctx.fillText(`${(lvl.ratio * 100).toFixed(1)}%${priceTxt}`, x1 + 4, y - 3);
        }
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
      const right = Math.max(p0.x, p1.x, p2.x);
      const x2 = d.style.extend === "right" || d.style.extend === "both" ? canvasW : right;
      const reverse = d.style.reverse === true;
      for (const lvl of visibleLevels(d)) {
        const y = p2.y + (reverse ? p0.y - p1.y : p1.y - p0.y) * lvl.ratio;
        ctx.save();
        if (lvl.color) ctx.strokeStyle = lvl.color;
        if (lvl.width) ctx.lineWidth = lvl.width;
        if (lvl.dash) ctx.setLineDash(lvl.dash === "dashed" ? [6, 4] : lvl.dash === "dotted" ? [2, 3] : []);
        ctx.globalAlpha = 0.7;
        drawSegment(ctx, { x: Math.min(p2.x, x2 - 40), y }, { x: x2, y });
        if (d.style.showLabels !== false) {
          ctx.setLineDash([]);
          ctx.globalAlpha = 0.9;
          ctx.font = `${d.style.fontSize}px ui-sans-serif, system-ui`;
          const priceTxt = d.style.showPrices && d.points.length >= 3
            ? ` ${fmtDrawingPrice(fibLevelPrice("extension", d.points[0].price, d.points[1].price, d.points[2].price, lvl.ratio, reverse))}`
            : "";
          ctx.fillText(`${(lvl.ratio * 100).toFixed(1)}%${priceTxt}`, x2 - 58, y - 3);
        }
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
      const label = d.text || "Text";
      ctx.font = `${d.style.fontWeight === "bold" ? "bold " : ""}${d.style.fontSize}px ui-sans-serif, system-ui`;
      ctx.textAlign = d.style.textAlign === "center" ? "center" : d.style.textAlign === "right" ? "right" : "left";
      if (d.style.textBg) {
        const w2 = ctx.measureText(label).width + 6;
        const bx = ctx.textAlign === "center" ? pts[0].x - w2 / 2 : ctx.textAlign === "right" ? pts[0].x - w2 + 3 : pts[0].x - 3;
        ctx.fillStyle = d.style.textBg;
        ctx.globalAlpha = 0.8 * (d.style.opacity ?? 1);
        ctx.fillRect(bx, pts[0].y - d.style.fontSize, w2, d.style.fontSize + 5);
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = d.style.textColor || d.style.color;
      ctx.fillText(label, pts[0].x, pts[0].y);
      ctx.restore();
      break;
    }

    // ---------- trend line family ----------
    case "info-line": {
      drawSegment(ctx, pts[0], pts[1]);
      ctx.save();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.font = `${d.style.fontSize}px ui-sans-serif, system-ui`;
      // Phase 26 D1: market-space Δprice (the pixel delta rendered a useless
      // canvas-coordinate number); the slope angle stays pixel-based (it IS a
      // visual property).
      const dprice = d.points.length >= 2 ? d.points[1].price - d.points[0].price : pts[0].y - pts[1].y;
      const angle = (Math.atan2(-(pts[1].y - pts[0].y), Math.abs(pts[1].x - pts[0].x) || 1) * 180) / Math.PI;
      ctx.fillText(`${dprice >= 0 ? "+" : ""}${fmtDrawingPrice(dprice)} · ${angle.toFixed(1)}°`, pts[1].x + 6, pts[1].y - 5);
      ctx.restore();
      break;
    }
    case "trend-angle": {
      drawSegment(ctx, pts[0], pts[1]);
      ctx.save();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.font = `${d.style.fontSize}px ui-sans-serif, system-ui`;
      const ang = (Math.atan2(-(pts[1].y - pts[0].y), Math.abs(pts[1].x - pts[0].x) || 1) * 180) / Math.PI;
      ctx.fillText(`${ang.toFixed(1)}°`, pts[1].x + 6, pts[1].y - 5);
      ctx.restore();
      break;
    }
    case "hray": {
      const dir = pts[1].x >= pts[0].x ? 1 : -1;
      const seg = rayToEdge(pts[0], { x: pts[0].x + dir * canvasW, y: pts[0].y }, canvasW, canvasH);
      drawSegment(ctx, seg.a, seg.b);
      break;
    }
    case "hchannel": {
      const y2 = pts[2].y;
      const x1 = Math.min(pts[0].x, pts[1].x), x2 = Math.max(pts[0].x, pts[1].x);
      ctx.beginPath();
      ctx.rect(x1, Math.min(pts[0].y, y2), x2 - x1, Math.abs(y2 - pts[0].y));
      applyFill(ctx, d);
      drawSegment(ctx, { x: x1, y: pts[0].y }, { x: x2, y: pts[0].y });
      drawSegment(ctx, { x: x1, y: y2 }, { x: x2, y: y2 });
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.globalAlpha = 0.4;
      for (const xx of [x1, x2]) drawSegment(ctx, { x: xx, y: pts[0].y }, { x: xx, y: y2 });
      ctx.restore();
      break;
    }
    case "dchannel": {
      if (pts.length < 4) break; // P39b: mid-creation preview may be short
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.lineTo(pts[3].x, pts[3].y);
      ctx.lineTo(pts[2].x, pts[2].y);
      ctx.closePath();
      applyFill(ctx, d);
      drawSegment(ctx, pts[0], pts[1]);
      drawSegment(ctx, pts[2], pts[3]);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.globalAlpha = 0.4;
      drawSegment(ctx, pts[1], pts[3]);
      drawSegment(ctx, pts[0], pts[2]);
      ctx.restore();
      break;
    }
    case "regression": {
      // Phase 37 §7 fix — the canvas layer always renders the bars-driven
      // least-squares fit for regression; this base case used to ALSO stroke a
      // degenerate span, double-drawing every regression. Render nothing here.
      break;
    }
    case "pitchfork": {
      if (pts.length === 3) {
        // extend toward the side the fork opens to (mid of P1P2 vs P0)
        const edgeX = (pts[1].x + pts[2].x) / 2 >= pts[0].x ? canvasW : 0;
        const L = pitchforkLines(pts[0], pts[1], pts[2], edgeX);
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.globalAlpha *= 0.55;
        drawSegment(ctx, pts[1], pts[2]); // trigger line
        ctx.restore();
        drawSegment(ctx, L.upper.from, L.upper.to);
        drawSegment(ctx, L.median.from, L.median.to);
        drawSegment(ctx, L.lower.from, L.lower.to);
      }
      break;
    }

    // ---------- fibonacci family ----------
    case "fib-trend-ext": {
      if (pts.length < 3) break; // P39b: mid-creation preview may be short
      const [p0, p1, p2] = pts;
      drawSegment(ctx, p0, p1);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.globalAlpha = 0.5;
      drawSegment(ctx, p1, p2);
      ctx.restore();
      const x2 = Math.max(p0.x, p1.x, p2.x);
      for (const lvl of visibleLevels(d)) {
        const y = p2.y + (p1.y - p0.y) * lvl.ratio;
        const x1 = Math.min(p2.x, x2 - 60);
        ctx.save();
        ctx.globalAlpha = 0.75;
        ctx.strokeStyle = lvl.color || d.style.color;
        ctx.lineWidth = lvl.width || d.style.width;
        ctx.setLineDash(dashPattern(lvl.dash || d.style.dash));
        drawSegment(ctx, { x: x1, y }, { x: x2, y });
        ctx.setLineDash([]);
        ctx.globalAlpha = 0.95;
        ctx.font = `${d.style.fontSize}px ui-sans-serif, system-ui`;
        ctx.fillStyle = lvl.color || d.style.color;
        ctx.fillText(`${(lvl.ratio * 100).toFixed(1)}%`, x2 - 58, y - 3);
        ctx.restore();
      }
      break;
    }
    case "fib-channel": {
      if (pts.length < 3) break; // P39b: mid-creation preview may be short
      const [p0, p1, p2] = pts;
      drawSegment(ctx, p0, p1);
      const dx = p1.x - p0.x, dy = p1.y - p0.y;
      const projLen = dx * (p2.x - p0.x) + dy * (p2.y - p0.y);
      const lenSq = dx * dx + dy * dy || 1;
      const t = projLen / lenSq;
      const bx = p0.x + dx * t, by = p0.y + dy * t;
      const ox = p2.x - bx, oy = p2.y - by;
      for (const lvl of visibleLevels(d)) {
        const k = lvl.ratio;
        ctx.save();
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = lvl.color || d.style.color;
        ctx.lineWidth = lvl.width || d.style.width;
        ctx.setLineDash(dashPattern(lvl.dash || d.style.dash));
        drawSegment(ctx, { x: p0.x + ox * k, y: p0.y + oy * k }, { x: p1.x + ox * k, y: p1.y + oy * k });
        ctx.restore();
      }
      break;
    }
    case "fib-timezone": {
      const [p0, p1] = pts;
      const dt = p1.x - p0.x;
      for (const lvl of visibleLevels(d)) {
        const x = p0.x + dt * lvl.ratio;
        ctx.save();
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = lvl.color || d.style.color;
        ctx.lineWidth = lvl.width || d.style.width;
        ctx.setLineDash(dashPattern(lvl.dash || d.style.dash));
        drawSegment(ctx, { x, y: 0 }, { x, y: canvasH });
        ctx.setLineDash([]);
        ctx.globalAlpha = 0.95;
        ctx.font = `${d.style.fontSize}px ui-sans-serif, system-ui`;
        ctx.fillStyle = lvl.color || d.style.color;
        ctx.fillText(`${lvl.ratio}`, x + 3, 12);
        ctx.restore();
      }
      break;
    }
    case "fib-fan": {
      const [p0, p1] = pts;
      const dy = p1.y - p0.y;
      const dx = p1.x - p0.x;
      drawSegment(ctx, p0, p1);
      for (const lvl of visibleLevels(d)) {
        ctx.save();
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = lvl.color || d.style.color;
        ctx.lineWidth = lvl.width || d.style.width;
        ctx.setLineDash(dashPattern(lvl.dash || d.style.dash));
        const seg = rayToEdge(p0, { x: p0.x + dx, y: p0.y + dy * lvl.ratio }, canvasW, canvasH);
        drawSegment(ctx, seg.a, seg.b);
        ctx.restore();
      }
      break;
    }
    case "fib-arc": {
      const [p0, p1] = pts;
      const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      drawSegment(ctx, p0, p1);
      for (const lvl of visibleLevels(d)) {
        ctx.save();
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = lvl.color || d.style.color;
        ctx.lineWidth = lvl.width || d.style.width;
        ctx.setLineDash(dashPattern(lvl.dash || d.style.dash));
        ctx.beginPath();
        ctx.arc(p0.x, p0.y, dist * lvl.ratio, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      break;
    }
    case "fib-circle": {
      const [p0, p1] = pts;
      const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      for (const lvl of visibleLevels(d)) {
        ctx.save();
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = lvl.color || d.style.color;
        ctx.lineWidth = lvl.width || d.style.width;
        ctx.setLineDash(dashPattern(lvl.dash || d.style.dash));
        ctx.beginPath();
        ctx.arc(p0.x, p0.y, dist * lvl.ratio, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      break;
    }
    case "fib-spiral": {
      const [p0, p1] = pts;
      const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const base = Math.atan2(p1.y - p0.y, p1.x - p0.x);
      // logarithmic (golden) spiral: r(θ) = a·φ^(θ/(π/2)) — quarter-turn per φ step
      ctx.save();
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = d.style.color;
      ctx.beginPath();
      const phi = 1.6180339887;
      const steps = 220;
      for (let i = 0; i <= steps; i++) {
        const theta = (i / steps) * Math.PI * 4; // 2 full turns
        const r = (dist / phi) * Math.pow(phi, theta / (Math.PI / 2));
        const x = p0.x + r * Math.cos(base + theta);
        const y = p0.y + r * Math.sin(base + theta);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
      break;
    }
    case "fib-wedge": {
      if (pts.length < 3) break; // P39b: mid-creation preview may be short
      const [apex, p1, p2] = pts;
      for (const lvl of visibleLevels(d)) {
        const dir1 = { x: p1.x - apex.x, y: (p1.y - apex.y) * lvl.ratio };
        const dir2 = { x: p2.x - apex.x, y: (p2.y - apex.y) * lvl.ratio };
        ctx.save();
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = lvl.color || d.style.color;
        ctx.lineWidth = lvl.width || d.style.width;
        ctx.setLineDash(dashPattern(lvl.dash || d.style.dash));
        const s1 = rayToEdge(apex, { x: apex.x + dir1.x, y: apex.y + dir1.y }, canvasW, canvasH);
        const s2 = rayToEdge(apex, { x: apex.x + dir2.x, y: apex.y + dir2.y }, canvasW, canvasH);
        drawSegment(ctx, s1.a, s1.b);
        drawSegment(ctx, s2.a, s2.b);
        ctx.restore();
      }
      break;
    }

    // ---------- shapes ----------
    case "rrect": {
      if (pts.length < 3) break; // P39b: mid-creation preview may be short
      // rotated rectangle: p0→p1 is one edge, p2 sets the depth
      const dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y;
      const ox = pts[2].x - (pts[0].x + dx / 2), oy = pts[2].y - (pts[0].y + dy / 2);
      const quad = [pts[0], pts[1], { x: pts[1].x + ox, y: pts[1].y + oy }, { x: pts[0].x + ox, y: pts[0].y + oy }];
      ctx.beginPath();
      ctx.moveTo(quad[0].x, quad[0].y);
      for (let k = 1; k < 4; k++) ctx.lineTo(quad[k].x, quad[k].y);
      ctx.closePath();
      applyFill(ctx, d);
      ctx.stroke();
      break;
    }
    case "triangle": {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.lineTo(pts[2].x, pts[2].y);
      ctx.closePath();
      applyFill(ctx, d);
      ctx.stroke();
      break;
    }
    case "circle": {
      const r = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, r, 0, Math.PI * 2);
      applyFill(ctx, d);
      ctx.stroke();
      break;
    }
    case "ellipse": {
      const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.abs(pts[1].x - pts[0].x) / 2, Math.abs(pts[1].y - pts[0].y) / 2, 0, 0, Math.PI * 2);
      applyFill(ctx, d);
      ctx.stroke();
      break;
    }
    case "polyline": {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
      ctx.stroke();
      break;
    }
    case "path": {
      // smooth curve through the clicked points (Catmull-Rom → bezier)
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let k = 1; k < pts.length - 1; k++) {
        const mx = (pts[k].x + pts[k + 1].x) / 2, my = (pts[k].y + pts[k + 1].y) / 2;
        ctx.quadraticCurveTo(pts[k].x, pts[k].y, mx, my);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
      break;
    }
    case "curve": {
      if (pts.length < 3) break; // P39b: mid-creation preview may be short
      const poly = bezierPolyline(pts[0], pts[1], pts[2]);
      ctx.beginPath();
      ctx.moveTo(poly[0].x, poly[0].y);
      for (const q of poly.slice(1)) ctx.lineTo(q.x, q.y);
      ctx.stroke();
      for (const q of [pts[1]]) drawHandle(ctx, q, false);
      break;
    }
    case "double-curve": {
      if (pts.length < 4) break; // P39b: mid-creation preview may be short
      // S-curve through 4 anchors: two quadratic halves sharing the middle
      const mid = { x: (pts[1].x + pts[2].x) / 2, y: (pts[1].y + pts[2].y) / 2 };
      const c1 = { x: (pts[0].x + mid.x) / 2 + (pts[1].x - pts[0].x), y: (pts[0].y + mid.y) / 2 + (pts[1].y - pts[0].y) };
      const c2 = { x: (mid.x + pts[3].x) / 2 + (pts[2].x - pts[3].x), y: (mid.y + pts[3].y) / 2 + (pts[2].y - pts[3].y) };
      const p1 = bezierPolyline(pts[0], c1, mid);
      const p2 = bezierPolyline(mid, c2, pts[3]);
      ctx.beginPath();
      ctx.moveTo(p1[0].x, p1[0].y);
      for (const q of p1.slice(1)) ctx.lineTo(q.x, q.y);
      for (const q of p2) ctx.lineTo(q.x, q.y);
      ctx.stroke();
      break;
    }
    case "arc": {
      const cc = circumcenter(pts[0], pts[1], pts[2]);
      if (cc) {
        const a0 = Math.atan2(pts[0].y - cc.y, pts[0].x - cc.x);
        const a2 = Math.atan2(pts[2].y - cc.y, pts[2].x - cc.x);
        ctx.beginPath();
        ctx.arc(cc.x, cc.y, cc.r, a0, a2, (a2 - a0 + Math.PI * 2) % (Math.PI * 2) > Math.PI);
        ctx.stroke();
      } else {
        drawSegment(ctx, pts[0], pts[2]);
      }
      break;
    }
    case "highlighter": {
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.lineWidth = Math.max(10, d.style.width * 6);
      ctx.lineCap = "round";
      for (let k = 1; k < pts.length; k++) drawSegment(ctx, pts[k - 1], pts[k]);
      ctx.restore();
      break;
    }
    case "arrow": {
      drawSegment(ctx, pts[0], pts[1]);
      drawArrowHead(ctx, pts[0], pts[1], Math.max(8, d.style.width * 4));
      break;
    }
    case "arrow-marker": {
      drawArrowHead(ctx, { x: pts[0].x - (pts[1].x - pts[0].x) * 0.05, y: pts[0].y - (pts[1].y - pts[0].y) * 0.05 }, pts[0], 14);
      break;
    }
    case "callout": {
      const txt = d.text || "Callout";
      ctx.save();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.font = `${d.style.fontSize}px ui-sans-serif, system-ui`;
      const bnd = textBounds(txt, d.style.fontSize, pts[0]);
      ctx.fillStyle = "rgba(15,23,42,0.92)";
      ctx.fillRect(bnd.x - 4, bnd.y - 4, bnd.w + 8, bnd.h + 8);
      ctx.strokeStyle = d.style.color;
      ctx.strokeRect(bnd.x - 4, bnd.y - 4, bnd.w + 8, bnd.h + 8);
      ctx.fillStyle = d.style.color;
      ctx.fillText(txt, bnd.x, bnd.y + d.style.fontSize);
      ctx.restore();
      drawSegment(ctx, { x: bnd.x + bnd.w + 4, y: bnd.y + bnd.h / 2 }, pts[1]);
      break;
    }
    case "price-label": {
      const txt = d.text || (d.points[0] ? fmtDrawingPrice(d.points[0].price) : "");
      ctx.save();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.font = `bold ${d.style.fontSize}px ui-sans-serif, system-ui`;
      const w = ctx.measureText(txt).width + 10;
      ctx.fillStyle = d.style.color;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(0, pts[0].y - d.style.fontSize, Math.max(w, 64), d.style.fontSize + 8);
      ctx.fillStyle = "#0b1220";
      ctx.fillText(txt, 4, pts[0].y + 2);
      ctx.restore();
      break;
    }

    // ---------- annotations ----------
    case "anchored-text": {
      drawSegment(ctx, pts[0], { x: pts[0].x + 6, y: pts[0].y - 6 });
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      ctx.font = `${d.style.fontSize}px ui-sans-serif, system-ui`;
      ctx.fillText(d.text || "Text", pts[0].x + 8, pts[0].y - 8);
      ctx.restore();
      break;
    }
    case "note":
    case "signpost":
    case "comment": {
      const txt = d.text || "";
      ctx.save();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.font = `${d.style.fontSize}px ui-sans-serif, system-ui`;
      const bnd = textBounds(txt || "Note", d.style.fontSize, pts[0]);
      ctx.fillStyle = d.type === "signpost" ? d.style.color : "rgba(15,23,42,0.92)";
      ctx.globalAlpha = d.type === "signpost" ? 0.85 : 1;
      ctx.fillRect(bnd.x - 4, bnd.y - 4, bnd.w + 8, bnd.h + 8);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = d.style.color;
      if (d.type === "comment") ctx.strokeRect(bnd.x - 4, bnd.y - 4, bnd.w + 8, bnd.h + 8);
      if (d.type === "signpost") {
        ctx.beginPath();
        ctx.moveTo(bnd.x - 4, bnd.y + bnd.h / 2);
        ctx.lineTo(pts[0].x - 10, bnd.y + bnd.h / 2);
        ctx.stroke();
      }
      ctx.fillStyle = d.type === "signpost" ? "#0b1220" : d.style.color;
      ctx.fillText(txt || "Note", bnd.x, bnd.y + d.style.fontSize);
      ctx.restore();
      break;
    }
    case "price-note": {
      const txt = d.text ? `${d.text} · ${pts[0].y.toFixed(0)}` : pts[0].y.toFixed(0);
      ctx.save();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.font = `bold ${d.style.fontSize}px ui-sans-serif, system-ui`;
      const w = ctx.measureText(txt).width + 10;
      ctx.fillStyle = "rgba(15,23,42,0.92)";
      ctx.fillRect(pts[0].x + 8, pts[0].y - d.style.fontSize, w, d.style.fontSize + 8);
      ctx.strokeStyle = d.style.color;
      ctx.strokeRect(pts[0].x + 8, pts[0].y - d.style.fontSize, w, d.style.fontSize + 8);
      ctx.fillStyle = d.style.color;
      ctx.fillText(txt, pts[0].x + 12, pts[0].y + 2);
      ctx.restore();
      drawSegment(ctx, pts[0], { x: pts[0].x + 8, y: pts[0].y });
      break;
    }
    case "flag": {
      ctx.save();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = d.style.color;
      ctx.fillStyle = d.style.color;
      drawSegment(ctx, pts[0], { x: pts[0].x + 26, y: pts[0].y });
      ctx.beginPath();
      ctx.moveTo(pts[0].x + 26, pts[0].y);
      ctx.lineTo(pts[0].x + 26, pts[0].y - 14);
      ctx.lineTo(pts[0].x + 48, pts[0].y - 8);
      ctx.lineTo(pts[0].x + 26, pts[0].y - 2);
      ctx.closePath();
      ctx.fill();
      if (d.text) {
        ctx.font = `${d.style.fontSize}px ui-sans-serif, system-ui`;
        ctx.fillText(d.text, pts[0].x + 52, pts[0].y - 4);
      }
      ctx.restore();
      break;
    }
    case "price-range": {
      const x = Math.min(pts[0].x, pts[1].x), w2 = Math.max(40, Math.abs(pts[1].x - pts[0].x));
      const y1 = Math.min(pts[0].y, pts[1].y), y2 = Math.max(pts[0].y, pts[1].y);
      ctx.beginPath();
      ctx.rect(x, y1, w2, y2 - y1);
      applyFill(ctx, d);
      ctx.strokeRect(x, y1, w2, y2 - y1);
      ctx.save();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.font = `bold ${d.style.fontSize}px ui-sans-serif, system-ui`;
      ctx.fillStyle = d.style.color;
      const mid = (y1 + y2) / 2;
      // Phase 26 D1: the real price delta between the anchors (was pixels)
      const dprice = d.points.length >= 2 ? d.points[1].price - d.points[0].price : pts[0].y - pts[1].y;
      ctx.fillText(`${dprice >= 0 ? "+" : ""}${fmtDrawingPrice(dprice)}`, x + w2 + 6, mid + 4);
      ctx.restore();
      break;
    }
    case "date-range": {
      const y = Math.min(pts[0].y, pts[1].y), h2 = Math.max(24, Math.abs(pts[1].y - pts[0].y));
      const x1 = Math.min(pts[0].x, pts[1].x), x2 = Math.max(pts[0].x, pts[1].x);
      ctx.beginPath();
      ctx.rect(x1, y, x2 - x1, h2);
      applyFill(ctx, d);
      ctx.strokeRect(x1, y, x2 - x1, h2);
      ctx.save();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.font = `bold ${d.style.fontSize}px ui-sans-serif, system-ui`;
      ctx.fillStyle = d.style.color;
      const secs = d.points.length === 2 ? Math.abs(d.points[1].time - d.points[0].time) : 0;
      const days = Math.round(secs / 86400 * 10) / 10;
      ctx.fillText(`${days}d`, (x1 + x2) / 2 - 14, y + h2 + d.style.fontSize);
      ctx.restore();
      break;
    }
    case "datetime-range": {
      const x = Math.min(pts[0].x, pts[1].x), w2 = Math.abs(pts[1].x - pts[0].x);
      const y = Math.min(pts[0].y, pts[1].y), h2 = Math.abs(pts[1].y - pts[0].y);
      ctx.beginPath();
      ctx.rect(x, y, w2, h2);
      applyFill(ctx, d);
      ctx.strokeRect(x, y, w2, h2);
      ctx.save();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.font = `bold ${d.style.fontSize}px ui-sans-serif, system-ui`;
      ctx.fillStyle = d.style.color;
      const secs = d.points.length === 2 ? Math.abs(d.points[1].time - d.points[0].time) : 0;
      // Phase 26 D1: market-space Δprice (was pixels) + the day span
      const dprice = d.points.length >= 2 ? d.points[1].price - d.points[0].price : pts[0].y - pts[1].y;
      ctx.fillText(`${dprice >= 0 ? "+" : ""}${fmtDrawingPrice(dprice)} · ${(secs / 86400).toFixed(1)}d`, x + 6, y + d.style.fontSize + 4);
      ctx.restore();
      break;
    }

    // ---------- measurement & positions ----------
    case "long-position":
    case "short-position": {
      if (pts.length < 3) break; // P39b: mid-creation preview may be short
      const [entry, stop, target] = pts;
      const isLong = d.type === "long-position";
      // risk zone (entry↔stop) red, reward zone (entry↔target) green
      const x = entry.x - 36;
      const w2 = Math.max(72, Math.abs(target.x - stop.x));
      ctx.save();
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = "#ef4444";
      ctx.fillRect(x, Math.min(entry.y, stop.y), w2, Math.abs(stop.y - entry.y));
      ctx.fillStyle = "#22c55e";
      ctx.fillRect(x, Math.min(entry.y, target.y), w2, Math.abs(target.y - entry.y));
      ctx.restore();
      ctx.save();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = d.style.color;
      drawSegment(ctx, { x, y: entry.y }, { x: x + w2, y: entry.y });
      ctx.font = `bold ${d.style.fontSize}px ui-sans-serif, system-ui`;
      ctx.fillStyle = "#ef4444";
      // Phase 26 D1: Stop/Target show the anchors' MARKET prices (was pixels)
      ctx.fillText(`Stop ${fmtDrawingPrice(d.points[1]?.price ?? NaN)}`, x + 4, stop.y + (stop.y > entry.y ? -4 : d.style.fontSize + 2));
      ctx.fillStyle = "#22c55e";
      ctx.fillText(`Target ${fmtDrawingPrice(d.points[2]?.price ?? NaN)}`, x + 4, target.y + (target.y > entry.y ? -4 : d.style.fontSize + 2));
      ctx.fillStyle = d.style.color;
      ctx.fillText(`Entry ${fmtDrawingPrice(d.points[0]?.price ?? NaN)}`, x + 4, entry.y + d.style.fontSize + 4);
      // P39 §8 — RR from MARKET prices (exact on log/% scales too), not
      // canvas pixels. Chart-measured figure — never a broker/P&L number.
      const entryP = d.points[0]?.price ?? 0;
      const stopP = d.points[1]?.price ?? 0;
      const targetP = d.points[2]?.price ?? 0;
      const riskDist = Math.abs(entryP - stopP);
      const rr = riskDist > 0 ? Math.abs(targetP - entryP) / riskDist : 0;
      ctx.fillText(`${isLong ? "Long" : "Short"} · RR ${rr.toFixed(2)}`, x + 4, entry.y - 6);
      ctx.restore();
      break;
    }
    case "forecast": {
      if (pts.length < 3) break; // P39b: mid-creation preview may be short
      drawSegment(ctx, pts[0], pts[1]);
      ctx.save();
      ctx.setLineDash([6, 4]);
      drawSegment(ctx, pts[1], pts[2]);
      ctx.restore();
      drawArrowHead(ctx, pts[1], pts[2], 10);
      break;
    }

    // ---------- patterns ----------
    case "elliott-impulse":
    case "elliott-correction":
    case "head-shoulders":
    case "xabcd":
    case "abcd":
    case "three-drives": {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
      ctx.stroke();
      break;
    }
  }

  drawPointLabels(ctx, d, pts);
  drawEndpointLabels(ctx, d, pts);
  drawAttachedText(ctx, d, pts);

  if (selected) {
    for (const p of pts) drawHandle(ctx, p, false);
  }
}

// ---------------------------------------------------------------------------
// Phase 35 — sanitize on load. Persistence used to cast remote snapshots
// without validation, so one corrupted entry could break rendering or spawn
// duplicates. Invalid entries are DROPPED, fields clamped to the engine's
// ranges, duplicate ids collapse to the newest entry. Pure + unit-tested.
// ---------------------------------------------------------------------------
export function __sanitizeDrawingList(list: unknown): Drawing[] {
  if (!Array.isArray(list)) return [];
  const out = new Map<string, Drawing>();
  const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const typeKey = typeof r.type === "string" ? r.type : "";
    const arity = (TOOL_POINT_COUNT as Record<string, number | undefined>)[typeKey];
    if (arity === undefined) continue; // unknown tool — drop, never guess
    const type = typeKey as DrawingType;
    const rawPoints = Array.isArray(r.points) ? r.points : [];
    const points: DrawingPoint[] = [];
    for (const p of rawPoints) {
      if (!p || typeof p !== "object") continue;
      const time = Number((p as DrawingPoint).time);
      const price = Number((p as DrawingPoint).price);
      if (!Number.isFinite(time) || !Number.isFinite(price)) continue;
      points.push({ time, price });
      if (arity === -1 && points.length >= 800) break; // freehand cap
    }
    const min = arity === -1 || arity === -2 ? 2 : arity;
    const max = arity === -1 || arity === -2 ? Infinity : arity;
    if (points.length < min || points.length > max) continue;
    const levels = sanitizeFibLevels(r.levels);
    const st = (r.style && typeof r.style === "object" ? r.style : {}) as Record<string, unknown>;
    const fill = st.fill && typeof st.fill === "object" ? (st.fill as Record<string, unknown>) : null;
    const tfs = Array.isArray(r.tfs)
      ? (r.tfs.filter((t) => typeof t === "string") as Timeframe[]).slice(0, 16)
      : undefined;
    const d: Drawing = {
      id: typeof r.id === "string" && r.id ? r.id.slice(0, 40) : `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      type,
      points,
      style: {
        color: typeof st.color === "string" ? st.color : DEFAULT_STYLE.color,
        width: clamp(st.width, 1, 6, 2),
        dash: st.dash === "dashed" || st.dash === "dotted" ? st.dash : "solid",
        fontSize: clamp(st.fontSize, 6, 32, 12),
        ...(fill ? { fill: { color: typeof fill.color === "string" ? fill.color : DEFAULT_STYLE.color, opacity: clamp(fill.opacity, 0, 1, 0.15) } } : {}),
        ...(typeof st.textColor === "string" ? { textColor: st.textColor } : {}),
        ...(st.textPos === "start" || st.textPos === "end" || st.textPos === "above" || st.textPos === "below" ? { textPos: st.textPos } : {}),
        ...(st.extend === "right" || st.extend === "left" || st.extend === "both" ? { extend: st.extend } : {}),
        ...(st.showLabels === true || st.showLabels === false ? { showLabels: st.showLabels } : {}),
        ...(st.showTimeLabels === true || st.showTimeLabels === false ? { showTimeLabels: st.showTimeLabels } : {}),
        ...(st.showPrices === true || st.showPrices === false ? { showPrices: st.showPrices } : {}),
        ...(st.reverse === true || st.reverse === false ? { reverse: st.reverse } : {}),
        ...(typeof st.opacity === "number" && Number.isFinite(st.opacity) ? { opacity: clamp(st.opacity, 0.1, 1, 1) } : {}),
        ...(st.fontWeight === "bold" ? { fontWeight: "bold" as const } : {}),
        ...(st.textAlign === "left" || st.textAlign === "center" || st.textAlign === "right" ? { textAlign: st.textAlign } : {}),
        ...(typeof st.textBg === "string" && /^#[0-9a-fA-F]{3,8}$/.test(st.textBg) ? { textBg: st.textBg } : {}),
      },
      ...(typeof r.text === "string" ? { text: r.text.slice(0, 200) } : {}),
      ...(r.locked === true ? { locked: true } : {}),
      ...(r.hidden === true ? { hidden: true } : {}),
      ...(typeof r.name === "string" && r.name ? { name: r.name.slice(0, 60) } : {}),
      ...(tfs && tfs.length ? { tfs } : {}),
      ...(levels ? { levels } : {}),
    };
    out.set(d.id, d); // duplicate ids collapse to the newest entry
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Phase 27 — z-order + magnet snap (pure, unit-tested)
// ---------------------------------------------------------------------------

/** Z-order action for the selected drawing. Render order = array order, so
 * "front" = last (topmost), "back" = first (bottom-most). */
export type ZOrderAction = "front" | "back" | "forward" | "backward";

/** Phase 27 §4 — bring forward / send backward / to front / to back. Pure:
 * returns a NEW array, the input is untouched; unknown ids return the list
 * unchanged so a stale UI action can never corrupt the stack. */
export function reorderDrawing<T extends { id: string }>(list: T[], id: string, action: ZOrderAction): T[] {
  const idx = list.findIndex((d) => d.id === id);
  if (idx < 0) return list;
  const out = [...list];
  const [d] = out.splice(idx, 1);
  if (action === "front") out.push(d);
  else if (action === "back") out.unshift(d);
  else if (action === "forward") out.splice(Math.min(idx + 1, out.length), 0, d);
  else out.splice(Math.max(idx - 1, 0), 0, d);
  return out;
}

/** Phase 27 §7 — magnet snap: pull a pending anchor to the nearest bar OHLC
 * value whose pixel distance is within `thresholdPx` (TradingView magnet
 * behaviour — the crosshair magnet already snaps the CURSOR, this snaps the
 * ANCHOR the drawing actually stores). Pure; returns the original price when
 * nothing is in range. */
export function magnetSnapPrice(
  price: number,
  bar: { open: number; high: number; low: number; close: number } | null | undefined,
  priceToY: (p: number) => number | null,
  thresholdPx = 12,
): number {
  if (!bar || !Number.isFinite(price) || price <= 0) return price;
  const py = priceToY(price);
  if (py == null) return price;
  let best = price;
  let bestDist = thresholdPx;
  for (const c of [bar.open, bar.high, bar.low, bar.close]) {
    if (!Number.isFinite(c) || c <= 0) continue;
    const y = priceToY(c);
    if (y == null) continue;
    const dist = Math.abs(y - py);
    if (dist <= bestDist) { bestDist = dist; best = c; }
  }
  return best;
}

/** Magnet time snap: the anchor lands exactly on the containing bar's open
 * time (drawings must stay glued to their candle, not to a pixel column). */
export function magnetSnapTime(time: number, tfSec: number | null | undefined): number {
  if (!tfSec || tfSec <= 0 || !Number.isFinite(time) || time <= 0) return time;
  // weekly anchors to Monday 00:00 UTC (epoch 0 is a Thursday — the plain
  // floor would glue weekly drawings to Thursday, off every real bar)
  if (tfSec === 604800) {
    const MONDAY_ANCHOR = 345600;
    return Math.floor((time - MONDAY_ANCHOR) / tfSec) * tfSec + MONDAY_ANCHOR;
  }
  return Math.floor(time / tfSec) * tfSec;
}
