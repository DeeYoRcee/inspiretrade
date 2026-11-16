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
import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import {
  hitTest, makeDrawing, renderDrawing, setupCanvas,
  TOOL_POINT_COUNT, drawHandle, type Drawing, type DrawingType, type XY,
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
  drawings: Drawing[];
  onChange: (drawings: Drawing[]) => void;
  activeTool: DrawingType | null;
  onToolCommitted: () => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
  onContextMenu: (x: number, y: number, hitId: string | null) => void;
  tradeLines: TradeLine[];
  onTradeLineMove: (positionId: string, kind: TradeLine["kind"], price: number) => void;
  toolDefaults?: Partial<Drawing["style"]>;
}>(({
  converterRef, drawings, onChange, activeTool, onToolCommitted, selectedId,
  onSelect, onDelete, onEdit, onContextMenu, tradeLines, onTradeLineMove,
}, ref) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  // mutable interaction state (kept OUT of React state — zero re-renders on drag)
  const dragRef = useRef<DragState | null>(null);
  const hoverRef = useRef<{ id: string; handle?: number } | null>(null);
  const mouseRef = useRef<XY | null>(null);
  const toolRef = useRef<DrawingType | null>(activeTool);
  toolRef.current = activeTool;
  const drawingsRef = useRef(drawings);
  drawingsRef.current = drawings;
  const tradeRef = useRef(tradeLines);
  tradeRef.current = tradeLines;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

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
    for (const d of drawingsRef.current) {
      const pts = toCanvas(d);
      if (pts.length) renderDrawing(ctx, d, pts, W, H, d.id === selectedRef.current);
    }

    // ---- in-progress drag preview ------------------------------------------
    const drag = dragRef.current;
    if (drag?.mode === "draw" && drag.drawing) {
      const pts = toCanvas(drag.drawing);
      const m = mouseRef.current;
      if (m && pts.length < TOOL_POINT_COUNT[drag.drawing.type]) pts.push(m);
      renderDrawing(ctx, drag.drawing, pts, W, H, true);
    } else if ((drag?.mode === "move" || drag?.mode === "handle") && drag.drawing) {
      const pts = toCanvas(drag.drawing);
      if (pts.length) {
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
    if (toolRef.current) return "crosshair";
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

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return; // right button → context menu path
    const conv = converterRef.current;
    const host = hostRef.current;
    if (!conv || !host) return;
    const p = localXY(e);
    if (p.x < 0 || p.y < 0 || p.x > conv.paneW || p.y > conv.paneH) return; // price scale etc.

    // 1) trade-line drag (SL/TP) — wins over drawings
    for (const t of tradeRef.current) {
      if (t.kind === "entry") continue;
      const y = conv.y(t.price);
      if (y != null && Math.abs(p.y - y) <= 6) {
        dragRef.current = { mode: "trade", trade: { ...t } };
        host.setPointerCapture(e.pointerId);
        e.stopPropagation();
        e.preventDefault();
        redraw();
        return;
      }
    }

    // 2) drawing tool in progress → add a point / commit
    const tool = toolRef.current;
    if (tool) {
      const time = conv.time(p.x);
      const price = conv.price(p.y);
      if (time == null || price == null) return;
      e.stopPropagation();
      e.preventDefault();
      const drag = dragRef.current;
      const drawing = drag?.mode === "draw" && drag.drawing
        ? drag.drawing
        : makeDrawing(tool, []);
      drawing.points = [...drawing.points, { time, price }];
      if (drawing.points.length >= TOOL_POINT_COUNT[tool]) {
        // text asks for its content immediately after the single click
        if (tool === "text") {
          const text = window.prompt("Annotation text", drawing.text || "") ?? "";
          if (!text.trim()) { dragRef.current = null; redraw(); return; }
          drawing.text = text.trim().slice(0, 200);
        }
        onChange([...drawingsRef.current, drawing]);
        dragRef.current = null;
        onToolCommitted();
        onSelect(drawing.id);
      } else {
        dragRef.current = { mode: "draw", drawing };
      }
      redraw();
      return;
    }

    // 3) hit-test drawings → select + begin move/handle
    const hit = hitTest(p, drawingsRef.current, (d) => d.points.map((q) => ({ x: conv.x(q.time) ?? -9999, y: conv.y(q.price) ?? -9999 })), conv.paneW, conv.paneH);
    if (hit) {
      const d = drawingsRef.current[hit.index];
      onSelect(d.id);
      dragRef.current = {
        mode: hit.handle != null ? "handle" : "move",
        drawingIndex: hit.index,
        handle: hit.handle,
        original: JSON.parse(JSON.stringify(d)),
        startX: p.x,
        startY: p.y,
        moved: false,
      };
      host.setPointerCapture(e.pointerId);
      e.stopPropagation();
      e.preventDefault();
      redraw();
      return;
    }

    // 4) empty space — deselect (do NOT block chart pan)
    if (selectedRef.current) onSelect(null);
  };

  const onPointerMove = (e: PointerEvent) => {
    const conv = converterRef.current;
    if (!conv) return;
    const p = localXY(e);
    mouseRef.current = p;
    const drag = dragRef.current;
    const host = hostRef.current;
    if (!drag) {
      const c = cursorFor(p);
      if (host && host.style.cursor !== c) host.style.cursor = c;
      // hover re-render is throttled by rAF below
      scheduleHover();
      return;
    }
    e.stopPropagation();
    if (drag.mode === "draw") {
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
    if (drag.mode === "move" || drag.mode === "handle") {
      if (drag.drawing && drag.moved) {
        const next = drawingsRef.current.slice();
        next[drag.drawingIndex ?? -1] = drag.drawing;
        onChange(next);
      }
    } else if (drag.mode === "trade" && drag.trade) {
      onTradeLineMove(drag.trade.positionId, drag.trade.kind, drag.trade.price);
    }
    dragRef.current = null;
    redraw();
  };

  const onPointerUpCapture = (e: PointerEvent) => {
    if (dragRef.current) {
      e.stopPropagation();
      finishDrag();
    }
  };

  const onDoubleClickCapture = (e: MouseEvent) => {
    const conv = converterRef.current;
    if (!conv) return;
    const p = localXY(e);
    const hit = hitTest(p, drawingsRef.current, (d) => d.points.map((q) => ({ x: conv.x(q.time) ?? -9999, y: conv.y(q.price) ?? -9999 })), conv.paneW, conv.paneH);
    if (hit) {
      e.stopPropagation();
      onSelect(drawingsRef.current[hit.index].id);
      onEdit(drawingsRef.current[hit.index].id);
    }
  };

  const onContextMenuCapture = (e: MouseEvent) => {
    const conv = converterRef.current;
    if (!conv) return;
    const p = localXY(e);
    e.preventDefault();
    e.stopPropagation();
    if (p.x > conv.paneW || p.y > conv.paneH) return;
    const hit = hitTest(p, drawingsRef.current, (d) => d.points.map((q) => ({ x: conv.x(q.time) ?? -9999, y: conv.y(q.price) ?? -9999 })), conv.paneW, conv.paneH);
    onContextMenu(e.clientX, e.clientY, hit ? drawingsRef.current[hit.index].id : null);
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
      if ((e.key === "Delete" || e.key === "Backspace") && selectedRef.current) {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
        e.preventDefault();
        onDelete(selectedRef.current);
        onSelect(null);
      }
      if (e.key === "Escape") {
        dragRef.current = null;
        toolRef.current = null;
        onSelect(null);
        redraw();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDelete, onSelect]);

  // ---- attach capture-phase listeners to the host ---------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.addEventListener("pointerdown", onPointerDown as EventListener, true);
    host.addEventListener("pointermove", onPointerMove as EventListener, true);
    host.addEventListener("pointerup", onPointerUpCapture as EventListener, true);
    host.addEventListener("dblclick", onDoubleClickCapture as EventListener, true);
    host.addEventListener("contextmenu", onContextMenuCapture as EventListener, true);
    return () => {
      host.removeEventListener("pointerdown", onPointerDown as EventListener, true);
      host.removeEventListener("pointermove", onPointerMove as EventListener, true);
      host.removeEventListener("pointerup", onPointerUpCapture as EventListener, true);
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
    <div ref={hostRef} className="absolute inset-0" style={{ cursor: activeTool ? "crosshair" : undefined }}>
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
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
