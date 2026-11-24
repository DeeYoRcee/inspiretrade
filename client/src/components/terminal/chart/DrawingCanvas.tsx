/**
 * DrawingCanvas — transparent interaction + render layer above the main pane.
 *
 * Owns: drawing tools (trend/hline/vline/rect/ray/fib×2/channel/text),
 * selection with endpoint handles, move/resize drags, in-place SL/TP dragging,
 * context-menu requests and delete/escape keys.
 *
 * The canvas NEVER blocks chart pan/zoom: pointer-events are none, all
 * handlers run in the CAPTURE phase on the parent and only stop propagation
 * when they actually consume a gesture (active tool, hit drawing, trade line).
 * Anchors are market coordinates (time/price) via the parent-provided
 * converter, so drawings survive timeframe switches and prepended history.
 */
import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import {
  hitTest, makeDrawing, renderDrawing, setupCanvas, regressionLine,
  TEXT_TOOLS, CLICK_COLLECT_TOOLS, TOOL_POINT_COUNT, TOOL_LABELS, drawHandle,
  magnetSnapPrice, magnetSnapNear, magnetSnapTime, MAGNET_PX, snapToTick, clampPositionPrice,
  createPositionFromGesture, fmtPositionPrice,
  type Drawing, type DrawingPoint, type DrawingType, type XY, isPositionTool, positionAnchors, type DrawingRenderEnv } from "@/lib/drawings";

export interface TradeLine {
  /** entity id — a position id, or a pending-order id for order-* kinds */
  positionId: string;
  kind: "entry" | "sl" | "tp" | "order-entry" | "order-sl" | "order-tp";
  price: number;
  color: string;
  label: string;
  /** instrument digits for the price label */
  digits: number;
  // ---- PHASE 63: MT5-style position chip data --------------------------------
  /** instrument symbol shown in the entry chip (e.g. "BTCUSD") */
  symbol?: string;
  /** position/pending-order side — colors the side badge */
  side?: "buy" | "sell";
  /** volume in lots */
  lots?: number;
  /** live floating P/L in USD (entry lines only; null while unknown) */
  pnl?: number | null;
  /** the line is the active selection (brighter stroke + chip border) */
  selected?: boolean;
  /** the last modify attempt failed — draw the line/chip red until the sync restores */
  error?: boolean;
}

export interface ChartConverter {
  paneW: number;
  paneH: number;
  x(time: number): number | null;
  y(price: number): number | null;
  time(x: number): number | null;
  price(y: number): number | null;
}

export interface DrawingCanvasHandle { redraw: () => void }

interface DragState {
  mode: "draw" | "move" | "handle" | "trade";
  /** draw: committed preview points in market coords */
  drawing?: Drawing;
  drawingIndex?: number;
  handle?: number;
  /** trade-line drag snapshot (position SL/TP) */
  trade?: TradeLine;
  /** PHASE 63: pointerdown landed on the label chip — click-only, never drags */
  tradeClickOnly?: boolean;
  /** move/handle baseline */
  original?: Drawing;
  startX?: number;
  startY?: number;
  moved?: boolean;
  /** P46 §1.1 — position creation: press coordinates of the entry gesture */
  positionPress?: XY;
}

export const DrawingCanvas = forwardRef<DrawingCanvasHandle, {
  converterRef: React.RefObject<ChartConverter | null>;
  /** element the capture-phase listeners attach to — MUST be an ancestor that
   *  also contains the chart, so events reach the chart unless we consume them */
  attachRef: React.RefObject<HTMLDivElement | null>;
  drawings: Drawing[];
  onChange: (drawings: Drawing[]) => void;
  activeTool: DrawingType | null;
  onToolCommitted: () => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** multi-selection (Ctrl/Shift-click) — falls back to [selectedId] */
  selectedIds?: string[];
  onSelectIds?: (ids: string[]) => void;
  onDelete: (id: string) => void;
  /** multi-selection delete (Delete key with Ctrl-selected objects) */
  onDeleteMany?: (ids: string[]) => void;
  onEdit: (id: string) => void;
  onContextMenu: (x: number, y: number, hitId: string | null) => void;
  tradeLines: TradeLine[];
  onTradeLineMove: (positionId: string, kind: TradeLine["kind"], price: number) => void;
  /** P54 §3 — click (press+release without dragging) on a trade line opens
   *  the order/position details panel */
  onTradeLineClick?: (t: TradeLine) => void;
  toolDefaults?: Partial<Drawing["style"]>;
  /** timeframe seconds — measure tool computes the bar count label */
  tfSeconds?: number;
  /** instrument digits — measure tool formats the price delta */
  digits?: number;
  /** live bar series — regression tool computes the least-squares line from it */
  getBars?: () => { time: number; close: number }[];
  /** CSS cursor for the idle state (respects the Cross/Dot/Arrow pointer mode) */
  cursorFallback?: string;
  /** LOCK mode: drawings can be created but never selected/moved/deleted */
  locked?: boolean;
  /** global visibility toggle — hides every drawing (render + hit-test) */
  hiddenAll?: boolean;
  /** Phase 27 §7 magnet: snap NEW anchors to the nearest bar OHLC/time.
   * P46 §2 — three states: 0=off · 1=normal (12px) · 2=strong (36px). The
   * legacy boolean prop maps true→1. Magnet now ALSO applies to handle drags
   * (the dragged anchor only) — never to chart panning. */
  magnet?: boolean;
  magnetMode?: 0 | 1 | 2;
  /** P41 — instrument metadata + live balance for position drawings */
  renderEnv?: DrawingRenderEnv;
}>(({
  converterRef, attachRef, drawings, onChange, activeTool, onToolCommitted, selectedId,
  onSelect, onDelete, onDeleteMany, onEdit, onContextMenu, tradeLines, onTradeLineMove, onTradeLineClick,
  tfSeconds = 0, digits = 2, locked = false, hiddenAll = false, getBars, cursorFallback = "default",
  selectedIds, onSelectIds, toolDefaults, magnet = false, magnetMode, renderEnv,
}, ref) => {
  const renderEnvRef = useRef(renderEnv);
  renderEnvRef.current = renderEnv;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** pointer target: the chart-area wrapper (host itself is pointer-events:none) */
  const attachEl = () => attachRef.current ?? hostRef.current;

  // mutable interaction state (kept OUT of React state — zero re-renders on drag)
  const dragRef = useRef<DragState | null>(null);
  const hoverRef = useRef<{ id: string; handle?: number } | null>(null);
  const mouseRef = useRef<XY | null>(null);
  const toolRef = useRef<DrawingType | null>(activeTool);
  toolRef.current = activeTool;
  // Phase 37 §7 — while a drawing tool is armed the browser must not steal
  // touch gestures (page scroll / pinch): disable native touch-action on the
  // capture wrapper. Cursor mode leaves chart pan/zoom fully native.
  useEffect(() => {
    const el = attachRef.current;
    if (el) el.style.touchAction = activeTool ? "none" : "";
  }, [activeTool, attachRef]);
  const drawingsRef = useRef(drawings);
  drawingsRef.current = drawings;
  /** P46 §2 — 0=off · 1=normal · 2=strong (legacy boolean prop maps true→1) */
  const magnetModeRef = useRef<0 | 1 | 2>(0);
  magnetModeRef.current = (magnetMode ?? (magnet ? 1 : 0)) as 0 | 1 | 2;
  /** P46 §2.5 — last snap location for the visual feedback ring (post-clip) */
  const snapFlashRef = useRef<XY | null>(null);
  const getBarsRef = useRef(getBars);
  getBarsRef.current = getBars;
  /** Phase 27 §7: inline text editor draft (replaces window.prompt) */
  const [textDraft, setTextDraft] = useState<{ drawing: Drawing; x: number; y: number } | null>(null);
  const tradeRef = useRef(tradeLines);
  tradeRef.current = tradeLines;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const tfRef = useRef(tfSeconds);
  tfRef.current = tfSeconds;
  const digitsRef = useRef(digits);
  digitsRef.current = digits;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const hiddenAllRef = useRef(hiddenAll);
  hiddenAllRef.current = hiddenAll;
  const cursorFallbackRef = useRef(cursorFallback);
  cursorFallbackRef.current = cursorFallback;
  // Callback props live in a ref: the capture-phase listeners below attach
  // ONCE at mount and would otherwise freeze the FIRST render's closures —
  // the classic stale-callback bug (a uid resolving after mount kept every
  // pointer-driven commit uid-less, silently skipping persistence).
  const cbRef = useRef({ onChange, onSelect, onSelectIds, onToolCommitted, onDelete, onDeleteMany, onEdit, onContextMenu, onTradeLineMove, onTradeLineClick });
  cbRef.current = { onChange, onSelect, onSelectIds, onToolCommitted, onDelete, onDeleteMany, onEdit, onContextMenu, onTradeLineMove, onTradeLineClick };
  const multiIdsRef = useRef<string[]>(selectedIds ?? []);
  multiIdsRef.current = selectedIds?.length ? selectedIds : (selectedId ? [selectedId] : []);
  /** group-move snapshots (id → original points) captured at drag start */
  const groupOrigRef = useRef<Map<string, DrawingPoint[]> | null>(null);
  const toolDefaultsRef = useRef(toolDefaults);
  toolDefaultsRef.current = toolDefaults;

  /** Phase 27 §7 — magnet: a NEW anchor snaps to the containing bar's open
   * time and to the nearest bar OHLC within a 12px radius (TradingView
   * magnet). Creation-time only — dragging existing drawings never snaps,
   * so the user can always place a drawing exactly where they want it. */
  // ---- P38 §5 — Shift angle-snap (TradingView behavior) -------------------
  // Shift locks the line's final leg to 45° steps measured in SCREEN pixels,
  // so horizontal / vertical / diagonal lines are one gesture at any zoom.
  const ANGLE_SNAP_TOOLS = new Set<DrawingType>(["trend", "ray", "extended", "info-line", "trend-angle"]);
  const shiftRef = useRef(false);

  const snapLegScreen = (anchor: XY, cur: XY, shift: boolean, tool: DrawingType): XY => {
    if (!shift || !ANGLE_SNAP_TOOLS.has(tool)) return cur;
    const dx = cur.x - anchor.x, dy = cur.y - anchor.y;
    if (!dx && !dy) return cur;
    const step = Math.PI / 4;
    const ang = Math.round(Math.atan2(dy, dx) / step) * step;
    const len = Math.hypot(dx, dy);
    return { x: anchor.x + Math.cos(ang) * len, y: anchor.y + Math.sin(ang) * len };
  };

  /** market-coordinate wrapper: convert both ends to screen, snap, convert back */
  const snapLegMarket = (anchor: DrawingPoint, cur: DrawingPoint, shift: boolean, tool: DrawingType): DrawingPoint => {
    if (!shift || !ANGLE_SNAP_TOOLS.has(tool)) return cur;
    const conv = converterRef.current;
    if (!conv) return cur;
    const ax = conv.x(anchor.time), ay = conv.y(anchor.price);
    const cx = conv.x(cur.time), cy = conv.y(cur.price);
    if (ax == null || ay == null || cx == null || cy == null) return cur;
    const s = snapLegScreen({ x: ax, y: ay }, { x: cx, y: cy }, true, tool);
    const t = conv.time(s.x), pr = conv.price(s.y);
    if (t == null || pr == null) return cur;
    return { time: t, price: pr };
  };

  /** P46 §2.3 — the bar containing a time (binary search over the REAL
   * series): snapping only ever lands on actual OHLC values of existing
   * candles — never on empty space or fabricated data. */
  const barAtTime = (t: number): { open: number; high: number; low: number; close: number } | null => {
    const bars = getBarsRef.current?.() ?? [];
    if (!bars.length) return null;
    let lo = 0, hi = bars.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if ((bars[mid] as any).time < t) lo = mid + 1; else hi = mid; }
    return (bars[lo] as any) ?? null;
  };
  /** P46 §2.2 — proximity threshold: normal 12px, strong 36px (screen px, so
   * it behaves consistently at any zoom / device pixel ratio) */
  const magnetThreshold = (): number => (magnetModeRef.current === 2 ? MAGNET_PX.strong : MAGNET_PX.normal);

  const snapPoint = (time: number, price: number): { time: number; price: number } => {
    if (!magnetModeRef.current) return { time, price };
    // neighbour-aware magnet: the containing bar's OHLC first, then its two
    // neighbours (a wick tip of the adjacent column still attracts); when a
    // neighbour wins, the time follows it — anchor and bar stay a pair
    const snapped = magnetSnapNear(time, price, barAtTime, tfRef.current, (pp) => converterRef.current?.y(pp) ?? null, magnetThreshold());
    if ((snapped.price !== price || snapped.time !== time)) {
      const sx = converterRef.current?.x(snapped.time) ?? null;
      const sy = converterRef.current?.y(snapped.price) ?? null;
      if (sx != null && sy != null) snapFlashRef.current = { x: sx, y: sy };
    }
    return snapped;
  };

  /** measure tool summary: Δprice (Δ%) over N bars — computed in MARKET space */
  const measureLabel = (a: DrawingPoint, b: DrawingPoint): string => {
    const dp = b.price - a.price;
    const pct = a.price ? (dp / a.price) * 100 : 0;
    const bars = tfRef.current > 0 ? Math.max(0, Math.round(Math.abs(b.time - a.time) / tfRef.current)) : null;
    const sign = dp >= 0 ? "+" : "−";
    const parts = [`${sign}${Math.abs(dp).toFixed(digitsRef.current)} (${sign}${Math.abs(pct).toFixed(2)}%)`];
    if (bars != null) parts.push(`${bars} bars`);
    return parts.join(" · ");
  };

  const redraw = () => {
    const canvas = canvasRef.current;
    const conv = converterRef.current;
    if (!canvas || !conv) return;
    const ctx = setupCanvas(canvas);
    if (!ctx) return;
    const W = conv.paneW;
    const H = conv.paneH;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();

    // ---- committed drawings ------------------------------------------------
    const toCanvas = (d: Drawing): XY[] => {
      const pts: XY[] = [];
      const topPrice = conv.price(0);
      for (const p of d.points) {
        const x = conv.x(p.time);
        if (x == null) continue;
        let y = conv.y(p.price);
        if (y == null) {
          // P40 — clamp off-scale anchors instead of dropping the WHOLE
          // drawing (one anchor outside the visible price range used to
          // make the object unrenderable AND unselectable)
          y = topPrice != null && p.price > topPrice ? 1 : H - 1;
        }
        pts.push({ x, y });
      }
      return pts;
    };
    if (!hiddenAllRef.current) {
      const selSet = new Set(multiIdsRef.current);
      for (const d of drawingsRef.current) {
        const pts = toCanvas(d);
        // PHASE 62 fix #13: the measure label is computed at RENDER time from
        // the live points — XY-editor/props-bar anchor edits used to leave the
        // stale Δ%/bars text (the label was only refreshed during drags).
        const rendered = d.type === "measure" && d.points.length === 2 && !dragRef.current
          ? { ...d, text: measureLabel(d.points[0], d.points[1]) }
          : d;
        if (pts.length) renderDrawing(ctx, rendered, pts, W, H, selSet.has(d.id), renderEnvRef.current);
        // regression: least-squares line over the closes inside the selected span
        if (d.type === "regression" && getBars && d.points.length === 2) {
          const bars = getBars();
          const t1 = Math.min(d.points[0].time, d.points[1].time);
          const t2 = Math.max(d.points[0].time, d.points[1].time);
          const sample: XY[] = [];
          for (const b of bars) {
            if (b.time < t1 || b.time > t2) continue;
            const x = conv.x(b.time);
            const y = conv.y(b.close);
            if (x != null && y != null) sample.push({ x, y });
          }
          const fit = regressionLine(sample);
          if (fit && sample.length >= 2) {
            const x0 = sample[0].x;
            const x1 = sample[sample.length - 1].x;
            const y0 = fit.m * x0 + fit.b;
            const y1 = fit.m * x1 + fit.b;
            ctx.save();
            ctx.strokeStyle = d.style.color;
            ctx.lineWidth = d.style.width;
            ctx.setLineDash(d.style.dash === "dashed" ? [6, 4] : d.style.dash === "dotted" ? [2, 3] : []);
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            ctx.stroke();
            // Pearson R label
            const n = sample.length;
            const mx = sample.reduce((s, q) => s + q.x, 0) / n;
            const my = sample.reduce((s, q) => s + q.y, 0) / n;
            let sxy = 0, sxx = 0, syy = 0;
            for (const q of sample) { sxy += (q.x - mx) * (q.y - my); sxx += (q.x - mx) ** 2; syy += (q.y - my) ** 2; }
            const r = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
            ctx.setLineDash([]);
            ctx.font = `${d.style.fontSize}px ui-sans-serif, system-ui`;
            ctx.fillStyle = d.style.color;
            ctx.fillText(`R² ${(r * r).toFixed(3)} · n ${n}`, x1 + 6, y1 - 6);
            ctx.restore();
          }
        }
      }
    }

    // ---- in-progress drag preview ------------------------------------------
    const drag = dragRef.current;
    if (drag?.mode === "draw" && drag.drawing) {
      const pts = toCanvas(drag.drawing);
      const m = mouseRef.current;
      const wantPts = TOOL_POINT_COUNT[drag.drawing.type];
      if (isPositionTool(drag.drawing.type) && drag.drawing.points.length === 1 && m) {
        // P46 §1.1 — live 1:R preview: the cursor is the second level and the
        // opposite level mirrors it around entry, so the preview shows the
        // FINAL geometry while the user is still choosing the side
        const e0 = pts[0] ?? m;
        pts.length = 0;
        pts.push(e0, { x: m.x, y: m.y }, { x: m.x, y: Math.max(0, Math.min(H, 2 * e0.y - m.y)) });
      } else if (m && pts.length < wantPts) {
        // P38 §5 — Shift-locked preview leg
        const last = drag.drawing.points[drag.drawing.points.length - 1];
        const anchor = last ? (() => { const ax = conv.x(last.time); const ay = conv.y(last.price); return ax != null && ay != null ? { x: ax, y: ay } : null; })() : null;
        pts.push(anchor ? snapLegScreen(anchor, m, shiftRef.current, drag.drawing.type) : m);
      }
      // P39b — pad the preview to the tool's arity (repeat the last point):
      // 3/4-point tools used to render with a SHORT pts array mid-creation
      // and their renderers threw → the whole page hit the error boundary
      while (pts.length > 0 && pts.length < wantPts) {
        pts.push({ ...pts[pts.length - 1] });
      }
      // measure preview: label from the first committed point → current mouse (market space)
      if (drag.drawing.type === "measure" && drag.drawing.points.length === 1 && m) {
        const t = conv.time(m.x);
        const pr = conv.price(m.y);
        if (t != null && pr != null) drag.drawing.text = measureLabel(drag.drawing.points[0], { time: t, price: pr });
      }
      try {
        renderDrawing(ctx, drag.drawing, pts, W, H, true, renderEnvRef.current);
      } catch { /* a bad preview must never take the page down */ }
    } else if ((drag?.mode === "move" || drag?.mode === "handle") && drag.drawing) {
      const pts = toCanvas(drag.drawing);
      if (pts.length) {
        // moving/resizing a measure keeps the summary in sync with its anchors
        if (drag.drawing.type === "measure" && drag.drawing.points.length === 2) {
          drag.drawing.text = measureLabel(drag.drawing.points[0], drag.drawing.points[1]);
        }
        renderDrawing(ctx, drag.drawing, pts, W, H, true, renderEnvRef.current);
        if (drag.mode === "handle" && drag.handle != null) drawHandle(ctx, pts[drag.handle], true);
      }
    } else if (drag?.mode === "trade" && drag.trade) {
      drawTradeLine(ctx, drag.trade.price, drag.trade, conv, true);
    }

    // ---- hover highlight ----------------------------------------------------
    if (!drag && hoverRef.current) {
      const d = drawingsRef.current.find((x) => x.id === hoverRef.current!.id);
      if (d) {
        const pts = toCanvas(d);
        if (pts.length) {
          ctx.save();
          ctx.globalAlpha = 0.25;
          ctx.lineWidth = 6;
          ctx.strokeStyle = d.style.color;
          ctx.beginPath();
          if (d.type === "hline") { ctx.moveTo(0, pts[0].y); ctx.lineTo(W, pts[0].y); }
          else if (d.type === "vline") { ctx.moveTo(pts[0].x, 0); ctx.lineTo(pts[0].x, H); }
          else { ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y); }
          ctx.stroke();
          ctx.restore();
          for (const p of (isPositionTool(d.type) && pts.length >= 3 ? positionAnchors(pts) : pts)) drawHandle(ctx, p, false);
        }
      }
    }

    // ---- trade lines (positions) -------------------------------------------
    tradeChipRects.length = 0;
    if (!drag || drag.mode !== "trade") {
      // PHASE 63: chips of overlapping lines stack downward (14px steps) so
      // several positions near the same price never cover each other.
      const stack = new Map<number, number>();
      const dragged = drag?.mode === "trade" ? drag.trade : null;
      if (dragged) drawTradeLine(ctx, dragged.price, dragged, conv, true);
      for (const t of tradeRef.current) {
        if (dragged && t.positionId === dragged.positionId && t.kind === dragged.kind) continue;
        const y = conv.y(t.price);
        if (y == null) continue;
        const bucket = Math.round(y / (CHIP_H + 1));
        const n = stack.get(bucket) ?? 0;
        stack.set(bucket, n + 1);
        drawTradeLine(ctx, t.price, t, conv, false, n * (CHIP_H - 3));
      }
    }
    ctx.restore();

    // ---- P46 §1.2 — POST-CLIP overlays: TradingView-style price-axis tags
    // for the Entry/Stop/Target levels (drawn on the axis strip right of the
    // pane) + the P46 §2.5 magnet snap-flash ring ----
    const axisW = Math.max(0, canvas.clientWidth - conv.paneW);
    if (axisW > 8) {
      const env = renderEnvRef.current;
      const dEnv = env?.digits ?? digitsRef.current;
      for (const d of drawingsRef.current) {
        if (hiddenAllRef.current) break; // Phase 59: hide-all also hides the axis tags
        if (!isPositionTool(d.type) || d.hidden || d.points.length < 3) continue;
        const tags: Array<[number, string, string]> = [
          [d.points[0].price, fmtPositionPrice(d.points[0].price, dEnv), d.style.color],
          [d.points[1].price, fmtPositionPrice(d.points[1].price, dEnv), d.style.lossColor || "#ef4444"],
          [d.points[2].price, fmtPositionPrice(d.points[2].price, dEnv), d.style.profitColor || "#22c55e"],
        ];
        ctx.save();
        ctx.setLineDash([]);
        ctx.font = "bold 10px ui-sans-serif, system-ui";
        for (const [pr, text, bg] of tags) {
          const y = conv.y(pr);
          if (y == null || y < 0 || y > conv.paneH) continue;
          const tw = Math.min(axisW, ctx.measureText(text).width + 8);
          ctx.globalAlpha = 0.95;
          ctx.fillStyle = bg;
          ctx.beginPath();
          if (typeof ctx.roundRect === "function") ctx.roundRect(conv.paneW + 1, Math.round(y - 7), tw, 14, 3);
          else ctx.rect(conv.paneW + 1, Math.round(y - 7), tw, 14);
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.fillStyle = "#0b1220";
          ctx.fillText(text, conv.paneW + 5, Math.round(y - 7) + 10.5);
        }
        ctx.restore();
      }
    }
    const flash = snapFlashRef.current;
    if (flash) {
      ctx.save();
      ctx.setLineDash([]);
      ctx.strokeStyle = "rgba(56,189,248,0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(flash.x, flash.y, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(flash.x, flash.y, 2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(56,189,248,0.9)";
      ctx.fill();
      ctx.restore();
    }
  };

  useImperativeHandle(ref, () => ({ redraw }));

  // redraw on prop changes + when the converter refreshes (parent schedules too)
  useEffect(() => { redraw(); });

  // ---- pointer plumbing -----------------------------------------------------
  const localXY = (e: PointerEvent | MouseEvent): XY => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const cursorFor = (p: XY): string => {
    const conv = converterRef.current;
    if (!conv) return "default";
    if (toolRef.current) return lockedRef.current ? "not-allowed" : "crosshair";
    if (hiddenAllRef.current || lockedRef.current) return "default";
    const hit = hitTest(p, drawingsRef.current, (d) => d.points.map((q) => ({ x: conv.x(q.time) ?? -9999, y: conv.y(q.price) ?? -9999 })), conv.paneW, conv.paneH);
    // Phase 59: feed the hover renderer — this ref was declared but never
    // written, so the hover glow/handle dots never appeared
    const hitId = hit != null ? drawingsRef.current[hit.index]?.id : undefined;
    hoverRef.current = hit != null && hitId ? { id: hitId, handle: hit.handle } : null;
    if (hit?.handle != null) return "grab";
    if (hit) return "move";
    for (const t of tradeRef.current) {
      if (t.kind === "entry") continue;
      const y = conv.y(t.price);
      if (y != null && Math.abs(p.y - y) <= 5) return "ns-resize";
    }
    return "default";
  };

  /** pointer capture can throw (inactive/synthetic pointer ids) — never let it break the gesture */
  const captureSafe = (target: HTMLElement, pointerId: number) => {
    try { target.setPointerCapture(pointerId); } catch { /* synthetic or already-released pointer */ }
  };

  /** Phase 27 §7 — commit the pending text annotation from the inline editor */
  const commitTextDrawing = (text: string) => {
    const drag = dragRef.current;
    const drawing = drag?.mode === "draw" ? drag.drawing : null;
    setTextDraft(null);
    dragRef.current = null;
    if (!drawing) return;
    if (text.trim()) drawing.text = text.trim().slice(0, 200);
    cbRef.current.onChange([...drawingsRef.current, drawing]);
    cbRef.current.onToolCommitted();
    cbRef.current.onSelect(drawing.id);
    redraw();
  };
  const cancelTextDrawing = () => {
    setTextDraft(null);
    dragRef.current = null;
    cbRef.current.onToolCommitted();
    redraw();
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return; // right button → context menu path
    const conv = converterRef.current;
    const target = attachEl();
    if (!conv || !target) return;
    // P39 — UI overlays that live INSIDE chartAreaRef (props bar, object
    // tree, history panel) are not chart gestures. The old code fell through
    // to the "empty space → deselect" step on their pointerdown, which
    // UNMOUNTED the props bar before its button's click could fire — the
    // toolbar Delete button looked completely dead.
    if ((e.target as Element | null)?.closest?.("[data-chart-ui]")) return;
    const p = localXY(e);
    if (p.x < 0 || p.y < 0 || p.x > conv.paneW || p.y > conv.paneH) return; // price scale etc.

    // 1a) PHASE 63 — label chip hit: opening the panel must work even when
    //     the chip is stacked away from its line or the line is the fixed
    //     entry of a filled position.
    for (const r of tradeChipRects) {
      if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y - 2 && p.y <= r.y + r.h + 2) {
        dragRef.current = { mode: "trade", trade: { ...r.t }, tradeClickOnly: true };
        e.stopPropagation();
        e.preventDefault();
        captureSafe(target, e.pointerId);
        redraw();
        return;
      }
    }
    // 1b) trade-line drag (SL/TP + pending-order entry) — wins over drawings
    for (const t of tradeRef.current) {
      if (t.kind === "entry") continue; // a filled position's entry is fixed
      const y = conv.y(t.price);
      if (y != null && Math.abs(p.y - y) <= 6) {
        dragRef.current = { mode: "trade", trade: { ...t } };
        e.stopPropagation();
        e.preventDefault();
        captureSafe(target, e.pointerId);
        redraw();
        return;
      }
    }

    // 2) drawing tool in progress → add a point / commit
    const tool = toolRef.current;
    if (tool && lockedRef.current) return; // LOCK: no new drawings either
    if (tool) {
      const time = conv.time(p.x);
      const price = conv.price(p.y);
      if (time == null || price == null) return;
      e.stopPropagation();
      e.preventDefault();
      // capture the pointer for the whole gesture — releasing outside the
      // chart wrapper (over the toolbar/rail) must still deliver pointerup,
      // otherwise the stroke stayed armed and "kept drawing" on re-entry
      captureSafe(target, e.pointerId);
      const drag = dragRef.current;
      // P46 §1.1 — position tools: ONE gesture (press entry → drag → release)
      // or two clicks. The second point's SIDE decides stop vs target; the
      // opposite level mirrors it at 1:R. All levels snap to the instrument
      // tick (renderEnv.tickSize) — TradingView placement semantics.
      if (isPositionTool(tool)) {
        const tick = renderEnvRef.current?.tickSize;
        const snapped = snapPoint(time, price);
        if (drag?.mode === "draw" && drag.drawing && drag.drawing.type === tool && drag.drawing.points.length === 1) {
          // second gesture (plain click) → derive stop/target + commit
          const d2 = drag.drawing;
          d2.points = createPositionFromGesture(tool as "long-position" | "short-position", d2.points[0], snapped, tick);
          cbRef.current.onChange([...drawingsRef.current, d2]);
          dragRef.current = null;
          snapFlashRef.current = null;
          cbRef.current.onToolCommitted();
          cbRef.current.onSelect(d2.id);
          redraw();
          return;
        }
        const d = makeDrawing(tool, []);
        const { riskPct: defaultRisk, ...stylePatch } = (toolDefaultsRef.current ?? {}) as Partial<Drawing["style"]> & { riskPct?: number };
        d.style = { ...d.style, ...stylePatch };
        if (typeof defaultRisk === "number" && defaultRisk > 0) d.riskPct = defaultRisk;
        d.points = [{ time: snapped.time, price: snapToTick(snapped.price, tick) }];
        dragRef.current = { mode: "draw", drawing: d, positionPress: { x: p.x, y: p.y } };
        redraw();
        return;
      }
      const drawing = drag?.mode === "draw" && drag.drawing
        ? drag.drawing
        : (() => {
            const d = makeDrawing(tool, []);
            d.style = { ...d.style, ...toolDefaultsRef.current };
            return d;
          })();
      const wanted = TOOL_POINT_COUNT[tool];
      const snapped = snapPoint(time, price);
      const legPt = wanted >= 2 && drawing.points.length === wanted - 1
        ? snapLegMarket(drawing.points[drawing.points.length - 1], snapped, e.shiftKey, tool)
        : snapped;
      drawing.points = [...drawing.points, legPt];
      // click-collected tools (path/polyline) wait for double-click / Enter
      if (CLICK_COLLECT_TOOLS.has(tool)) {
        dragRef.current = { mode: "draw", drawing };
        redraw();
        return;
      }
      if (wanted >= 0 && drawing.points.length >= wanted) {
        // annotation tools ask for their content via an INLINE editor at the
        // anchor (Phase 27 §7 — window.prompt was a browser modal: it froze
        // the whole window and looked nothing like charting software). The
        // pending drawing stays in dragRef; commitTextDrawing finalises it.
        if (TEXT_TOOLS.has(tool)) {
          dragRef.current = { mode: "draw", drawing };
          setTextDraft({ drawing, x: p.x, y: p.y });
          redraw();
          return;
        }
        if (tool === "measure") {
          drawing.text = measureLabel(drawing.points[0], drawing.points[1]);
        }
        cbRef.current.onChange([...drawingsRef.current, drawing]);
        dragRef.current = null;
        snapFlashRef.current = null;
        cbRef.current.onToolCommitted();
        cbRef.current.onSelect(drawing.id);
      } else {
        dragRef.current = { mode: "draw", drawing };
      }
      redraw();
      return;
    }

    // 3) hit-test drawings → select + begin move/handle
    if (lockedRef.current || hiddenAllRef.current) return; // LOCK/HIDE: objects are frozen
    const hit = hitTest(p, drawingsRef.current, (d) => d.points.map((q) => ({ x: conv.x(q.time) ?? -9999, y: conv.y(q.price) ?? -9999 })), conv.paneW, conv.paneH);
    if (hit) {
      const d = drawingsRef.current[hit.index];
      // Ctrl/Shift-click edits the multi-selection — no drag, no chart pan
      if ((e.ctrlKey || e.metaKey || e.shiftKey) && onSelectIds) {
        const cur = new Set(multiIdsRef.current);
        if (cur.has(d.id)) cur.delete(d.id);
        else cur.add(d.id);
        const next = [...cur];
        cbRef.current.onSelectIds?.(next);
        cbRef.current.onSelect(next[next.length - 1] ?? null);
        e.stopPropagation();
        e.preventDefault();
        redraw();
        return;
      }
      cbRef.current.onSelect(d.id);
      // plain click = single selection — collapse a stale Ctrl-multi-selection
      // so the handles and Delete target the object the user sees selected
      if (multiIdsRef.current.length > 1 && !multiIdsRef.current.includes(d.id)) cbRef.current.onSelectIds?.([]);
      // plain-click on an already-multi-selected object moves the WHOLE group
      const groupMove = multiIdsRef.current.length > 1 && multiIdsRef.current.includes(d.id);
      groupOrigRef.current = groupMove
        ? new Map(multiIdsRef.current.map((id) => {
            const g = drawingsRef.current.find((x) => x.id === id);
            return [id, g ? JSON.parse(JSON.stringify(g.points)) : []];
          }))
        : null;
      dragRef.current = {
        mode: hit.handle != null ? "handle" : "move",
        drawingIndex: hit.index,
        handle: hit.handle,
        original: JSON.parse(JSON.stringify(d)),
        startX: p.x,
        startY: p.y,
        moved: false,
      };
      e.stopPropagation();
      e.preventDefault();
      captureSafe(target, e.pointerId);
      redraw();
      return;
    }

    // 4) empty space — deselect (do NOT block chart pan)
    if (selectedRef.current) cbRef.current.onSelect(null);
    if (onSelectIds && multiIdsRef.current.length > 1) cbRef.current.onSelectIds?.([]);
  };

  const onPointerMove = (e: PointerEvent) => {
    const conv = converterRef.current;
    if (!conv) return;
    const p = localXY(e);
    mouseRef.current = p;
    shiftRef.current = e.shiftKey;
    const drag = dragRef.current;
    const target = attachEl();
    if (!drag) {
      const c0 = cursorFor(p); // one hit-test per move (was two full passes)
      const c = c0 === "default" ? cursorFallbackRef.current : c0;
      // PHASE 62 fix #9: the cursor only changes on object ENTER/LEAVE —
      // scheduling a full redraw every frame while the mouse idles over one
      // spot (regression resamples O(bars) at 60fps) was pure waste.
      const cursorChanged = target && target.style.cursor !== c;
      if (cursorChanged) {
        target.style.cursor = c;
        scheduleHover();
      }
      return;
    }
    // Phase 59: only real gestures (move/resize/pan-nudge) consume the event.
    // A multi-point tool ARMED between clicks also uses mode:"draw" — there
    // stopPropagation killed the chart's crosshair/legend until the object
    // committed. In draw mode the pointer press is already consumed, so pan
    // can't start; the crosshair must stay alive like on TradingView.
    if (drag.mode !== "draw") e.stopPropagation();
    if (drag.mode === "draw") {
      // brush/highlighter are freehand: append a point every ≥4px of travel (capped at 800)
      if (drag.drawing && toolRef.current && TOOL_POINT_COUNT[toolRef.current] === -1 && toolRef.current === drag.drawing.type) {
        const time = conv.time(p.x);
        const price = conv.price(p.y);
        const pts = drag.drawing.points;
        if (time != null && price != null && pts.length < 800) {
          const lastPt = pts[pts.length - 1];
          const lx = lastPt ? conv.x(lastPt.time) : null;
          const ly = lastPt ? conv.y(lastPt.price) : null;
          if (lx == null || ly == null || Math.hypot(p.x - lx, p.y - ly) >= 4) {
            drag.drawing.points = [...pts, { time, price }];
          }
        }
      }
      scheduleHover(); // PHASE 62 fix #10: rAF-coalesced preview (was 1 redraw per pointermove event)
      return;
    }
    if (drag.mode === "trade" && drag.trade) {
      // PHASE 63: a chip click never drags — tiny jitters keep it a click
      if (drag.tradeClickOnly) return;
      const price = conv.price(p.y);
      if (price != null && price > 0) {
        if (price !== drag.trade.price) drag.moved = true;
        drag.trade.price = price;
        redraw();
      }
      return;
    }
    if (drag.mode === "move" && drag.original) {
      const t0 = conv.time(drag.startX ?? p.x);
      const t1 = conv.time(p.x);
      const p0 = conv.price(drag.startY ?? p.y);
      const p1 = conv.price(p.y);
      if (t0 == null || t1 == null || p0 == null || p1 == null) return;
      const dt = t1 - t0;
      const dp = p1 - p0;
      drag.drawing = {
        ...drag.original,
        points: drag.original.points.map((q) => ({ time: q.time + dt, price: q.price + dp })),
      };
      drag.moved = true;
      scheduleHover(); // PHASE 62 fix #10: rAF-coalesced (was per-event)
      return;
    }
    if (drag.mode === "handle" && drag.original && drag.handle != null) {
      const time = conv.time(p.x);
      const price = conv.price(p.y);
      if (time == null || price == null) return;
      const points = drag.original.points.map((q) => ({ ...q }));
      const tick = renderEnvRef.current?.tickSize;
      const snapPx = magnetModeRef.current ? magnetThreshold() : 0;
      /** P46 §2.5 — flash ring at the snapped location (post-clip overlay) */
      const flashAt = (t2: number, pr2: number) => {
        const sx = conv.x(t2), sy = conv.y(pr2);
        if (sx != null && sy != null) snapFlashRef.current = { x: sx, y: sy };
      };
      // P46 §2.4/§2.6 — magnet applies ONLY to the anchor being dragged
      // (never to panning, the crosshair path, or the other anchors);
      // hline/vline snap their meaningful axis.
      if (drag.original.type === "hline" || drag.original.type === "text") {
        let pr2 = price;
        if (snapPx) {
          const s = magnetSnapPrice(price, barAtTime(points[drag.handle].time), (pp) => conv.y(pp) ?? null, snapPx);
          if (s !== price) { pr2 = s; flashAt(points[drag.handle].time, s); }
        }
        points[drag.handle] = { ...points[drag.handle], price: pr2 };
      } else if (drag.original.type === "vline") {
        let t2 = time;
        if (snapPx) {
          const st = magnetSnapTime(time, tfRef.current);
          if (st !== time) { t2 = st; flashAt(st, points[drag.handle].price); }
        }
        points[drag.handle] = { ...points[drag.handle], time: t2 };
      } else if (isPositionTool(drag.original.type) && drag.original.points.length >= 3) {
        const posType = drag.original.type as "long-position" | "short-position";
        // P41/P46 — position semantics: handles 0-2 move their LEVEL vertically
        // only (never the band, never each other); 3/4 drag the band edges
        // horizontally (right edge carries target.time with it)
        if (drag.handle <= 2) {
          // P46 §1.1 — OHLC magnet (price axis) → tick rounding → the level
          // can never drag its way through entry (directional integrity)
          const entryPrice = drag.original.points[0].price;
          let pr2 = price;
          if (snapPx) {
            const s = magnetSnapPrice(price, barAtTime(points[drag.handle].time), (pp) => conv.y(pp) ?? null, snapPx);
            if (s !== price) { pr2 = s; flashAt(points[drag.handle].time, s); }
          }
          pr2 = snapToTick(clampPositionPrice(posType, drag.handle, entryPrice, pr2, tick), tick);
          points[drag.handle] = { ...points[drag.handle], price: pr2 };
        } else if (drag.handle === 3) {
          let t2 = time;
          if (snapPx) {
            const st = magnetSnapTime(time, tfRef.current);
            if (st !== time) { t2 = st; flashAt(st, points[0].price); }
          }
          points[0] = { ...points[0], time: t2 };
        } else {
          let t2 = time;
          if (snapPx) {
            const st = magnetSnapTime(time, tfRef.current);
            if (st !== time) { t2 = st; flashAt(st, points[1].price); }
          }
          points[1] = { ...points[1], time: t2 };
          points[2] = { ...points[2], time: t2 };
        }
      } else {
        let pt: DrawingPoint = { time, price };
        if (snapPx) {
          const s = snapPoint(time, price);
          if (s.time !== time || s.price !== price) { pt = s; flashAt(s.time, s.price); }
        }
        points[drag.handle] = pt;
      }
      drag.drawing = { ...drag.original, points };
      drag.moved = true;
      scheduleHover(); // PHASE 62 fix #10: rAF-coalesced (was per-event)
    }
  };

  const finishDrag = () => {
    const drag = dragRef.current;
    const conv = converterRef.current;
    snapFlashRef.current = null;
    if (!drag || !conv) return;
    if (drag.mode === "draw") return; // multi-point tool in progress — the NEXT click commits it
    if (drag.mode === "move" || drag.mode === "handle") {
      if (drag.drawing && drag.moved) {
        const next = drawingsRef.current.slice();
        // PHASE 62 fix #5: an RTDB merge mid-drag can shift the array —
        // resolve the slot by id (falling back to the captured index only
        // when the id is somehow missing).
        const idx = drag.drawing.id != null
          ? next.findIndex((d) => d.id === drag.drawing!.id)
          : (drag.drawingIndex ?? -1);
        if (idx < 0) return; // deleted mid-drag — nothing to commit
        next[idx] = drag.drawing;
        // group move: every other selected drawing shifts by the SAME delta
        if (groupOrigRef.current && drag.mode === "move") {
          const d0 = drag.drawing.points[0];
          const o0 = drag.original?.points[0];
          if (d0 && o0) {
            const dt = d0.time - o0.time;
            const dp = d0.price - o0.price;
            for (const [id, origPts] of groupOrigRef.current) {
              if (id === drag.drawing.id) continue;
              const idx = next.findIndex((x) => x.id === id);
              if (idx < 0 || origPts.length !== next[idx].points.length) continue;
              next[idx] = { ...next[idx], points: origPts.map((q) => ({ time: q.time + dt, price: q.price + dp })) };
            }
          }
        }
        cbRef.current.onChange(next);
      }
      groupOrigRef.current = null;
    } else if (drag.mode === "trade" && drag.trade) {
      if (drag.moved) cbRef.current.onTradeLineMove(drag.trade.positionId, drag.trade.kind, drag.trade.price);
      else cbRef.current.onTradeLineClick?.({ ...drag.trade });
    }
    dragRef.current = null;
    redraw();
  };

  const onPointerUpCapture = (e: PointerEvent) => {
    const drag = dragRef.current;
    if (drag?.mode === "draw" && drag.drawing && toolRef.current && TOOL_POINT_COUNT[toolRef.current] === -1) {
      // freehand stroke ends → commit (or discard a stray dot)
      e.stopPropagation();
      const d = drag.drawing;
      dragRef.current = null;
      snapFlashRef.current = null;
      if (d.points.length >= 2) {
        cbRef.current.onChange([...drawingsRef.current, d]);
        cbRef.current.onSelect(d.id);
      }
      cbRef.current.onToolCommitted();
      redraw();
      return;
    }
    if (dragRef.current) {
      e.stopPropagation();
      const dragDraw = dragRef.current.mode === "draw" ? dragRef.current : null;
      // ---- TradingView gesture: press → drag → release finalizes ------------
      // A real drag (≥4px) that leaves a fixed-point tool exactly one point
      // short commits on RELEASE. Without this the stroke survived pointer-up
      // waiting for a second click — the tool looked stuck active and the
      // drawn line was invisible until that extra click. Plain click-click
      // remains the alternative; multi-point collectors (path/polyline) and
      // freehand keep their own commit rules.
      if (dragDraw?.drawing && toolRef.current) {
        const tool = toolRef.current;
        const wanted = TOOL_POINT_COUNT[tool];
        const d = dragDraw.drawing;
        // P46 §1.1 — position release-derive: press at entry, drag ≥4px,
        // release → the FULL three-level position commits from the gesture
        // (the drag side picks stop vs target; the other mirrors at 1:R)
        if (isPositionTool(tool) && d.points.length === 1 && dragDraw.positionPress) {
          const conv = converterRef.current;
          const p = conv ? localXY(e) : null;
          const press = dragDraw.positionPress;
          if (conv && p && (Math.abs(p.x - press.x) > 4 || Math.abs(p.y - press.y) > 4)) {
            const time = conv.time(p.x);
            const price = conv.price(p.y);
            if (time != null && price != null) {
              const s2 = snapPoint(time, price);
              d.points = createPositionFromGesture(tool as "long-position" | "short-position", d.points[0], s2, renderEnvRef.current?.tickSize);
              e.stopPropagation();
              dragRef.current = null;
              snapFlashRef.current = null;
              cbRef.current.onChange([...drawingsRef.current, d]);
              cbRef.current.onToolCommitted();
              cbRef.current.onSelect(d.id);
              redraw();
              return;
            }
          }
          // short press → stay armed: the next click finalises (two-click flow)
        }
        if (wanted >= 2 && !CLICK_COLLECT_TOOLS.has(tool) && d.points.length === wanted - 1) {
          const conv = converterRef.current;
          const p = conv ? localXY(e) : null;
          const lastPt = d.points[d.points.length - 1];
          const px = conv?.x(lastPt.time) ?? -9999;
          const py = conv?.y(lastPt.price) ?? -9999;
          if (conv && p && (Math.abs(p.x - px) > 4 || Math.abs(p.y - py) > 4)) {
            const time = conv.time(p.x);
            const price = conv.price(p.y);
            if (time != null && price != null) {
              const finalPt = snapLegMarket(d.points[d.points.length - 1], { time, price }, e.shiftKey, tool);
              const drawing = { ...d, points: [...d.points, finalPt] };
              if (tool === "measure") {
                drawing.text = measureLabel(drawing.points[0], drawing.points[1]);
              }
              e.stopPropagation();
              dragRef.current = null;
              cbRef.current.onChange([...drawingsRef.current, drawing]);
              cbRef.current.onToolCommitted();
              cbRef.current.onSelect(drawing.id);
              redraw();
              return;
            }
          }
        }
      }
      // draw-mode drags survive the pointer-up: trend/fib/rect/etc. collect
      // one point per CLICK and commit when the tool's point count is reached
      // (the old code nulled the in-progress drawing here — multi-point tools
      // could never finish)
      if (dragRef.current && dragRef.current.mode !== "draw") finishDrag();
    }
  };

  // touch gestures / browser cancellations: never leave a stuck draw or drag
  const onPointerCancelCapture = (e: PointerEvent) => {
    const drag = dragRef.current;
    snapFlashRef.current = null;
    if (!drag) return;
    e.stopPropagation();
    if (drag.mode === "draw" && drag.drawing && toolRef.current && TOOL_POINT_COUNT[toolRef.current] === -1) {
      // freehand stroke cancelled near its end → commit what was drawn
      const d = drag.drawing;
      dragRef.current = null;
      if (d.points.length >= 2) {
        cbRef.current.onChange([...drawingsRef.current, d]);
        cbRef.current.onSelect(d.id);
      }
      cbRef.current.onToolCommitted();
    } else if (drag.mode !== "draw") {
      finishDrag(); // move/handle/trade keep their committed result
    }
    // multi-point strokes in progress are discarded on cancel
    dragRef.current = null;
    redraw();
  };

  const onDoubleClickCapture = (e: MouseEvent) => {
    // finishing a click-collected multi-point drawing wins over everything
    const drag = dragRef.current;
    if (drag?.mode === "draw" && drag.drawing && toolRef.current && CLICK_COLLECT_TOOLS.has(toolRef.current)) {
      const d = drag.drawing;
      dragRef.current = null;
      e.stopPropagation();
      e.preventDefault();
      if (d.points.length >= 2) {
        cbRef.current.onChange([...drawingsRef.current, d]);
        cbRef.current.onSelect(d.id);
      }
      cbRef.current.onToolCommitted();
      redraw();
      return;
    }
    const conv = converterRef.current;
    if (!conv) return;
    if (lockedRef.current || hiddenAllRef.current) return;
    const p = localXY(e);
    const hit = hitTest(p, drawingsRef.current, (d) => d.points.map((q) => ({ x: conv.x(q.time) ?? -9999, y: conv.y(q.price) ?? -9999 })), conv.paneW, conv.paneH);
    if (hit) {
      e.stopPropagation();
      cbRef.current.onSelect(drawingsRef.current[hit.index].id);
      cbRef.current.onEdit(drawingsRef.current[hit.index].id);
    }
  };

  const onContextMenuCapture = (e: MouseEvent) => {
    const conv = converterRef.current;
    if (!conv) return;
    const p = localXY(e);
    e.preventDefault();
    e.stopPropagation();
    if (p.x > conv.paneW || p.y > conv.paneH) return;
    const hit = (lockedRef.current || hiddenAllRef.current) ? null
      : hitTest(p, drawingsRef.current, (d) => d.points.map((q) => ({ x: conv.x(q.time) ?? -9999, y: conv.y(q.price) ?? -9999 })), conv.paneW, conv.paneH);
    cbRef.current.onContextMenu(e.clientX, e.clientY, hit ? drawingsRef.current[hit.index].id : null);
  };

  // hover cursor updates without storms — one rAF per burst
  const hoverRaf = useRef(0);
  const scheduleHover = () => {
    if (hoverRaf.current) return;
    hoverRaf.current = requestAnimationFrame(() => {
      hoverRaf.current = 0;
      redraw();
    });
  };

  // ---- keyboard: delete / escape --------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
        if (lockedRef.current) return; // LOCK: objects are frozen (matches the disabled object-tree buttons)
        const multi = multiIdsRef.current;
        if (multi.length > 1 && onDeleteMany) {
          e.preventDefault();
          cbRef.current.onDeleteMany?.(multi);
          cbRef.current.onSelect(null);
          if (onSelectIds) cbRef.current.onSelectIds?.([]);
        } else if (selectedRef.current) {
          e.preventDefault();
          cbRef.current.onDelete(selectedRef.current);
          cbRef.current.onSelect(null);
        }
      }
      if (e.key === "Escape") {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
        dragRef.current = null;
        toolRef.current = null;
        cbRef.current.onSelect(null);
        cbRef.current.onSelectIds?.([]);
        redraw();
      }
      // Enter finishes a click-collected multi-point drawing (path/polyline)
      if (e.key === "Enter") {
        const drag = dragRef.current;
        if (drag?.mode === "draw" && drag.drawing && toolRef.current && CLICK_COLLECT_TOOLS.has(toolRef.current)) {
          e.preventDefault();
          const d = drag.drawing;
          dragRef.current = null;
          if (d.points.length >= 2) {
            cbRef.current.onChange([...drawingsRef.current, d]);
            cbRef.current.onSelect(d.id);
          }
          cbRef.current.onToolCommitted();
          redraw();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // handlers read through cbRef — stable for the mount lifetime
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- attach capture-phase listeners to the chart-area wrapper --------------
  // The wrapper is an ancestor of the chart: events seen here FIRST, and only
  // consumed gestures are stopped — pan/zoom/crosshair stay native otherwise.
  useEffect(() => {
    const host = attachEl();
    if (!host) return;
    host.addEventListener("pointerdown", onPointerDown as EventListener, true);
    host.addEventListener("pointermove", onPointerMove as EventListener, true);
    host.addEventListener("pointerup", onPointerUpCapture as EventListener, true);
    host.addEventListener("pointercancel", onPointerCancelCapture as EventListener, true);
    host.addEventListener("dblclick", onDoubleClickCapture as EventListener, true);
    host.addEventListener("contextmenu", onContextMenuCapture as EventListener, true);
    return () => {
      host.removeEventListener("pointerdown", onPointerDown as EventListener, true);
      host.removeEventListener("pointermove", onPointerMove as EventListener, true);
      host.removeEventListener("pointerup", onPointerUpCapture as EventListener, true);
      host.removeEventListener("pointercancel", onPointerCancelCapture as EventListener, true);
      host.removeEventListener("dblclick", onDoubleClickCapture as EventListener, true);
      host.removeEventListener("contextmenu", onContextMenuCapture as EventListener, true);
    };
    // handlers close over refs only — stable for the lifetime of the mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    if (hoverRaf.current) cancelAnimationFrame(hoverRaf.current);
  }, []);

  return (
    // fully transparent to pointer events — the wrapper (attachRef) feeds us
    // capture-phase events; this layer only renders. z-5 keeps the overlay
    // above the lightweight-charts layers but below the legend/status chips.
    <div ref={hostRef} className="pointer-events-none absolute inset-0 z-[5]">
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      {textDraft && (
        <div
          /* PHASE 62 fix #2: WITHOUT data-chart-ui the tool handler treated
             editor clicks as chart clicks, appending a 2nd point to the text
             drawing — which the sanitizer then silently deleted on reload. */
          data-chart-ui="text-editor"
          className="pointer-events-auto absolute z-30 flex items-center gap-1 rounded-md border border-slate-600 bg-slate-900/95 px-1.5 py-1 shadow-xl"
          style={{
            left: Math.min(Math.max(4, textDraft.x), (converterRef.current?.paneW ?? textDraft.x) - 140),
            top: Math.min(Math.max(4, textDraft.y + 12), (converterRef.current?.paneH ?? textDraft.y) - 36),
          }}
        >
          <input
            autoFocus
            defaultValue=""
            placeholder="Text…"
            className="h-6 w-36 rounded bg-slate-800 px-2 text-xs text-slate-100 outline-none placeholder:text-slate-500"
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTextDrawing((e.target as HTMLInputElement).value);
              else if (e.key === "Escape") { e.preventDefault(); cancelTextDrawing(); }
              e.stopPropagation();
            }}
            onBlur={(e) => {
              if ((e.target as HTMLInputElement).value.trim()) commitTextDrawing((e.target as HTMLInputElement).value);
              else cancelTextDrawing();
            }}
          />
          <button
            title="Commit (Enter)"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => commitTextDrawing(((e.currentTarget.previousSibling as HTMLInputElement) ?? { value: "" } as HTMLInputElement).value)}
            className="flex h-6 w-6 items-center justify-center rounded bg-emerald-600/80 text-xs text-white hover:bg-emerald-600"
          >
            ✓
          </button>
        </div>
      )}
    </div>
  );
});

DrawingCanvas.displayName = "DrawingCanvas";

// ---------------------------------------------------------------------------
// Trade lines (entry / SL / TP) rendering
// ---------------------------------------------------------------------------

/** PHASE 63 — chip rects of the CURRENT frame, filled by drawTradeLine and
 *  consumed by the pointerdown hit-test (clicking a label opens the panel). */
const tradeChipRects: { t: TradeLine; x: number; y: number; w: number; h: number }[] = [];

const CHIP_H = 18;

function drawTradeLine(
  ctx: CanvasRenderingContext2D,
  price: number,
  t: TradeLine,
  conv: ChartConverter,
  dragging: boolean,
  /** vertical chip offset from label stacking (overlapping lines) */
  stackOffset = 0,
): void {
  const y = conv.y(price);
  if (y == null) return;
  const W = conv.paneW;
  const isEntry = t.kind === "entry" || t.kind === "order-entry";
  ctx.save();
  // line — error flash wins, then selection
  const lineColor = t.error ? "#ef4444" : t.color;
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = t.selected ? 2.25 : 1.5;
  ctx.globalAlpha = dragging ? 1 : t.selected ? 0.95 : 0.8;
  ctx.setLineDash(isEntry ? [] : [7, 5]);
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(W, y);
  ctx.stroke();
  if (t.selected) {
    // subtle glow on the selected line — visible, not neon
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 6;
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // ---- label chip (right-aligned inside the pane) --------------------------
  ctx.font = "10px ui-sans-serif, system-ui";
  const priceText = price.toFixed(t.digits);
  type Seg = { text: string; fg: string; bg?: string; bold?: boolean };
  const segs: Seg[] = [];
  if (isEntry) {
    if (t.error) segs.push({ text: "!", fg: "#fecaca", bg: "#7f1d1d", bold: true });
    const sideBadge = t.kind === "order-entry" ? (t.label.split(" ")[1] ?? t.side?.toUpperCase() ?? "") : (t.side === "sell" ? "SELL" : "BUY");
    const kindBadge = t.kind === "order-entry" ? (t.label.split(" ")[0] ?? "ORDER") : "";
    segs.push({
      text: kindBadge ? `${kindBadge} ${sideBadge}` : sideBadge,
      fg: "#ffffff",
      bg: t.error ? "#dc2626" : t.side === "sell" ? "#dc2626" : "#16a34a",
      bold: true,
    });
    if (t.symbol) segs.push({ text: t.symbol, fg: "#cbd5e1", bold: true });
    if (t.lots != null) segs.push({ text: t.lots.toFixed(2), fg: "#94a3b8" });
    segs.push({ text: priceText, fg: "#e2e8f0" });
    if (t.pnl != null) {
      segs.push({
        text: `${t.pnl >= 0 ? "+" : "\u2212"}$${Math.abs(t.pnl).toFixed(2)}`,
        fg: t.pnl >= 0 ? "#4ade80" : "#f87171",
        bold: true,
      });
    }
  } else {
    segs.push({ text: t.label, fg: "#ffffff", bg: t.error ? "#dc2626" : t.color, bold: true });
    segs.push({ text: priceText, fg: "#e2e8f0" });
  }

  const PAD = 6, GAP = 4;
  const widths = segs.map((g) => ctx.measureText(g.text).width + (g.bg ? 8 : 0));
  const w = widths.reduce((a2, b2) => a2 + b2, 0) + PAD * 2 + GAP * (segs.length - 1);
  const chipY = y - CHIP_H / 2 + stackOffset;
  const chipX = W - w - 4;
  // collect for hit-testing (pointerdown → open panel)
  tradeChipRects.push({ t, x: chipX, y: chipY, w, h: CHIP_H });

  ctx.globalAlpha = dragging ? 0.97 : 0.88;
  ctx.fillStyle = "rgba(13,21,38,0.92)";
  ctx.beginPath();
  ctx.roundRect(chipX, chipY, w, CHIP_H, 4);
  ctx.fill();
  ctx.strokeStyle = t.error ? "#ef4444" : t.selected ? "rgba(56,189,248,0.85)" : "rgba(148,163,184,0.28)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.globalAlpha = 1;
  // segments left→right
  let cx = chipX + PAD;
  for (let i = 0; i < segs.length; i++) {
    const g = segs[i];
    const gw = widths[i];
    if (g.bg) {
      ctx.fillStyle = g.bg;
      ctx.beginPath();
      ctx.roundRect(cx, chipY + 3, gw, CHIP_H - 6, 3);
      ctx.fill();
      ctx.fillStyle = g.fg;
    } else {
      ctx.fillStyle = g.fg;
    }
    ctx.fillText(g.text, cx + (g.bg ? 4 : 0), chipY + 12.5);
    cx += gw + GAP;
  }

  if (!isEntry) {
    // grip dots to hint draggability
    ctx.fillStyle = lineColor;
    for (const dx of [-8, -1]) {
      ctx.beginPath();
      ctx.arc(10 + dx + 4, y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}
