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
  magnetSnapPrice, magnetSnapTime,
  type Drawing, type DrawingPoint, type DrawingType, type XY,
} from "@/lib/drawings";

export interface TradeLine {
  positionId: string;
  kind: "entry" | "sl" | "tp";
  price: number;
  color: string;
  label: string;
  /** instrument digits for the price label */
  digits: number;
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
  /** move/handle baseline */
  original?: Drawing;
  startX?: number;
  startY?: number;
  moved?: boolean;
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
  /** Phase 27 §7 magnet: snap NEW anchors to the nearest bar OHLC/time */
  magnet?: boolean;
}>(({
  converterRef, attachRef, drawings, onChange, activeTool, onToolCommitted, selectedId,
  onSelect, onDelete, onDeleteMany, onEdit, onContextMenu, tradeLines, onTradeLineMove,
  tfSeconds = 0, digits = 2, locked = false, hiddenAll = false, getBars, cursorFallback = "default",
  selectedIds, onSelectIds, toolDefaults, magnet = false,
}, ref) => {
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
  const magnetRef = useRef(magnet);
  magnetRef.current = magnet;
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
  const cbRef = useRef({ onChange, onSelect, onSelectIds, onToolCommitted, onDelete, onDeleteMany, onEdit, onContextMenu, onTradeLineMove });
  cbRef.current = { onChange, onSelect, onSelectIds, onToolCommitted, onDelete, onDeleteMany, onEdit, onContextMenu, onTradeLineMove };
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

  const snapPoint = (time: number, price: number): { time: number; price: number } => {
    if (!magnetRef.current) return { time, price };
    const t = magnetSnapTime(time, tfRef.current);
    const bars = getBarsRef.current?.() ?? [];
    let bar: { open: number; high: number; low: number; close: number } | null = null;
    if (bars.length) {
      let lo = 0, hi = bars.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if ((bars[mid] as any).time < t) lo = mid + 1; else hi = mid; }
      const cand = bars[lo] as any;
      if (cand) bar = cand;
    }
    const price2 = magnetSnapPrice(price, bar, (pp) => converterRef.current?.y(pp) ?? null);
    return { time: t, price: price2 };
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
      for (const p of d.points) {
        const x = conv.x(p.time);
        const y = conv.y(p.price);
        if (x == null || y == null) return [];
        pts.push({ x, y });
      }
      return pts;
    };
    if (!hiddenAllRef.current) {
      const selSet = new Set(multiIdsRef.current);
      for (const d of drawingsRef.current) {
        const pts = toCanvas(d);
        if (pts.length) renderDrawing(ctx, d, pts, W, H, selSet.has(d.id));
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
      if (m && pts.length < TOOL_POINT_COUNT[drag.drawing.type]) {
        // P38 §5 — Shift-locked preview leg
        const last = drag.drawing.points[drag.drawing.points.length - 1];
        const anchor = last ? (() => { const ax = conv.x(last.time); const ay = conv.y(last.price); return ax != null && ay != null ? { x: ax, y: ay } : null; })() : null;
        pts.push(anchor ? snapLegScreen(anchor, m, shiftRef.current, drag.drawing.type) : m);
      }
      // measure preview: label from the first committed point → current mouse (market space)
      if (drag.drawing.type === "measure" && drag.drawing.points.length === 1 && m) {
        const t = conv.time(m.x);
        const pr = conv.price(m.y);
        if (t != null && pr != null) drag.drawing.text = measureLabel(drag.drawing.points[0], { time: t, price: pr });
      }
      renderDrawing(ctx, drag.drawing, pts, W, H, true);
    } else if ((drag?.mode === "move" || drag?.mode === "handle") && drag.drawing) {
      const pts = toCanvas(drag.drawing);
      if (pts.length) {
        // moving/resizing a measure keeps the summary in sync with its anchors
        if (drag.drawing.type === "measure" && drag.drawing.points.length === 2) {
          drag.drawing.text = measureLabel(drag.drawing.points[0], drag.drawing.points[1]);
        }
        renderDrawing(ctx, drag.drawing, pts, W, H, true);
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
          for (const p of pts) drawHandle(ctx, p, false);
        }
      }
    }

    // ---- trade lines (positions) -------------------------------------------
    if (!drag || drag.mode !== "trade") {
      for (const t of tradeRef.current) {
        drawTradeLine(ctx, t.price, t, conv, false);
      }
    }
    ctx.restore();
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
    const p = localXY(e);
    if (p.x < 0 || p.y < 0 || p.x > conv.paneW || p.y > conv.paneH) return; // price scale etc.

    // 1) trade-line drag (SL/TP) — wins over drawings
    for (const t of tradeRef.current) {
      if (t.kind === "entry") continue;
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
      const c = cursorFor(p) === "default" ? cursorFallbackRef.current : cursorFor(p);
      if (target && target.style.cursor !== c) target.style.cursor = c;
      // hover re-render is throttled by rAF below
      scheduleHover();
      return;
    }
    e.stopPropagation();
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
      redraw(); // preview follows the mouse
      return;
    }
    if (drag.mode === "trade" && drag.trade) {
      const price = conv.price(p.y);
      if (price != null && price > 0) {
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
      redraw();
      return;
    }
    if (drag.mode === "handle" && drag.original && drag.handle != null) {
      const time = conv.time(p.x);
      const price = conv.price(p.y);
      if (time == null || price == null) return;
      const points = drag.original.points.map((q) => ({ ...q }));
      // hline/vline/text drag only the meaningful axis
      if (drag.original.type === "hline" || drag.original.type === "text") {
        points[drag.handle] = { ...points[drag.handle], price };
      } else if (drag.original.type === "vline") {
        points[drag.handle] = { ...points[drag.handle], time };
      } else {
        points[drag.handle] = { time, price };
      }
      drag.drawing = { ...drag.original, points };
      drag.moved = true;
      redraw();
    }
  };

  const finishDrag = () => {
    const drag = dragRef.current;
    const conv = converterRef.current;
    if (!drag || !conv) return;
    if (drag.mode === "draw") return; // multi-point tool in progress — the NEXT click commits it
    if (drag.mode === "move" || drag.mode === "handle") {
      if (drag.drawing && drag.moved) {
        const next = drawingsRef.current.slice();
        next[drag.drawingIndex ?? -1] = drag.drawing;
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
      cbRef.current.onTradeLineMove(drag.trade.positionId, drag.trade.kind, drag.trade.price);
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

function drawTradeLine(
  ctx: CanvasRenderingContext2D,
  price: number,
  t: TradeLine,
  conv: ChartConverter,
  dragging: boolean,
): void {
  const y = conv.y(price);
  if (y == null) return;
  const W = conv.paneW;
  ctx.save();
  ctx.strokeStyle = t.color;
  ctx.fillStyle = t.color;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = dragging ? 1 : 0.9;
  ctx.setLineDash(t.kind === "entry" ? [] : [7, 5]);
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(W, y);
  ctx.stroke();
  // label chip (right-aligned inside the pane)
  ctx.setLineDash([]);
  const label = `${t.label} ${price.toFixed(t.digits)}`;
  ctx.font = "10px ui-sans-serif, system-ui";
  const w = ctx.measureText(label).width + 10;
  ctx.globalAlpha = dragging ? 0.95 : 0.75;
  ctx.fillRect(W - w, y - 8, w, 15);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#0b1220";
  ctx.fillText(label, W - w + 5, y + 3);
  if (t.kind !== "entry") {
    // grip dots to hint draggability
    ctx.fillStyle = t.color;
    for (const dx of [-8, -1]) {
      ctx.beginPath();
      ctx.arc(10 + dx + 4, y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}
