/**
 * Terminal drawing engine — a transparent <canvas> overlay on top of a
 * lightweight-charts instance. Drawings are stored in chart coordinates
 * ({time, price}) so they stay anchored when the user scrolls/zooms.
 *
 * Supported tools: trendline, hline, vline, ray, extended line, rectangle,
 * fibonacci retracement, brush, text, arrow, long/short position, measure.
 * Selection, dragging, lock, hide, delete, undo/redo and JSON serialization
 * for per-user Firebase persistence are included.
 */
import type { IChartApi, ISeriesApi, Time } from "lightweight-charts";

export type DrawingTool =
  | "cursor" | "trendline" | "hline" | "vline" | "ray" | "extline" | "rect"
  | "fib" | "fibext" | "channel" | "brush" | "text" | "arrow" | "long" | "short" | "measure";

export interface DrawingPoint { time: number; price: number }

export interface Drawing {
  id: string;
  tool: Exclude<DrawingTool, "cursor">;
  points: DrawingPoint[];
  color: string;
  width: number;
  locked?: boolean;
  hidden?: boolean;
  text?: string;
}

export interface DrawingStyle { color: string; width: number; }

/** selection snapshot for the floating object toolbar in TerminalPage */
export interface SelInfo { id: string; tool: string; text: string; width: number; locked: boolean; hidden: boolean }

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_EXT_LEVELS = [0, 0.618, 1, 1.618, 2.618];
const SELECT_RADIUS = 8;

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export class DrawingEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private getChart: () => IChartApi | null;
  private getSeries: () => ISeriesApi<"Candlestick"> | null;

  tool: DrawingTool = "cursor";
  style: DrawingStyle = { color: "#4ade80", width: 2 };
  drawings: Drawing[] = [];
  /** crosshair-sync vertical line from other charts (UNIX seconds) */
  syncTime: number | null = null;
  /** fired when a tool finishes its drawing (host resets the toolbar highlight) */
  onToolDone: (tool: DrawingTool) => void = () => {};

  /** fired whenever the selection changes (null = nothing selected) */
  onSelection: (info: SelInfo | null) => void = () => {};

  getSelected(): SelInfo | null {
    const d = this.drawings.find((x) => x.id === this.selectedId);
    if (!d) return null;
    return { id: d.id, tool: d.tool, text: d.text ?? "", width: d.width, locked: !!d.locked, hidden: !!d.hidden };
  }

  private fireSel() {
    try { this.onSelection(this.getSelected()); } catch { /* host must not break drawing */ }
  }

  /** scale the selected drawing's stroke size (floating toolbar − / +) */
  resizeSelected(factor: number) {
    const d = this.drawings.find((x) => x.id === this.selectedId);
    if (!d || d.locked) return;
    d.width = Math.min(10, Math.max(1, Math.round(d.width * factor * 10) / 10));
    this.pushUndo();
    this.onChange();
    this.render();
    this.fireSel();
  }

  /** set / clear the text label of the selected drawing */
  setTextSelected(text: string) {
    const d = this.drawings.find((x) => x.id === this.selectedId);
    if (!d || d.locked) return;
    d.text = text || undefined;
    this.pushUndo();
    this.onChange();
    this.render();
    this.fireSel();
  }

  /** in-progress drawing points (chart coords) */
  private pending: DrawingPoint[] = [];
  private dragging: { id: string; startX: number; startY: number; orig: DrawingPoint[] } | null = null;
  /** grabbing an endpoint of the SELECTED shape → resize/rotate that end only */
  private dragEndpoint: { id: string; idx: number; moved: boolean } | null = null;
  private selectedId: string | null = null;
  private hoverId: string | null = null;

  private undoStack: string[] = [];
  private redoStack: string[] = [];

  private onChange: () => void;
  private ro: ResizeObserver;

  constructor(
    canvas: HTMLCanvasElement,
    getChart: () => IChartApi | null,
    getSeries: () => ISeriesApi<"Candlestick"> | null,
    onChange: () => void,
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.getChart = getChart;
    this.getSeries = getSeries;
    this.onChange = onChange;

    this.ro = new ResizeObserver(() => this.syncSize());
    this.ro.observe(canvas.parentElement ?? canvas);
    this.syncSize();

    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("pointerleave", this.onUp);
    canvas.addEventListener("dblclick", this.onDblClick);
    window.addEventListener("keydown", this.onKey);
    // cursor-mode clickability: in cursor mode the canvas is pointer-events:none
    // so the chart below stays fully interactive (pan/zoom/crosshair) — these
    // window listeners flip the canvas to auto ONLY when the pointer is over a
    // drawing or its endpoint handles (see syncPointer / onWinDown)
    window.addEventListener("pointermove", this.syncPointer);
    window.addEventListener("pointerdown", this.onWinDown, true);
  }

  destroy() {
    this.ro.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onDown);
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerup", this.onUp);
    this.canvas.removeEventListener("pointerleave", this.onUp);
    this.canvas.removeEventListener("dblclick", this.onDblClick);
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("pointermove", this.syncPointer);
    window.removeEventListener("pointerdown", this.onWinDown, true);
  }

  /** Esc — cancel the in-progress drawing and go back to the cursor. */
  private onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (this.pending.length || this.tool !== "cursor") {
      this.pending = [];
      this.tool = "cursor";
      this.onToolDone("cursor");
      this.render();
    }
  };

  // ---- coordinate helpers ---------------------------------------------------

  private xFor(time: number): number | null {
    const chart = this.getChart();
    return chart ? chart.timeScale().timeToCoordinate(time as Time) : null;
  }
  private yFor(price: number): number | null {
    const s = this.getSeries();
    return s ? s.priceToCoordinate(price) : null;
  }
  private timeFor(x: number): number | null {
    const chart = this.getChart();
    const t = chart?.timeScale().coordinateToTime(x);
    return t == null ? null : Number(t);
  }
  private priceFor(y: number): number | null {
    const s = this.getSeries();
    const p = s?.coordinateToPrice(y);
    return p == null ? null : Number(p);
  }

  private syncSize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = parent.clientWidth * dpr;
    this.canvas.height = parent.clientHeight * dpr;
    this.canvas.style.width = `${parent.clientWidth}px`;
    this.canvas.style.height = `${parent.clientHeight}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  // ---- public API -----------------------------------------------------------

  redraw() { this.render(); }

  setTool(tool: DrawingTool) {
    this.tool = tool;
    this.pending = [];
    this.selectedId = null;
    this.canvas.style.pointerEvents = tool === "cursor" ? "none" : "auto";
    this.canvas.style.cursor = tool === "cursor" ? "default" : "crosshair";
    this.render();
  }

  setStyle(style: Partial<DrawingStyle>) {
    this.style = { ...this.style, ...style };
    if (this.selectedId) {
      const d = this.drawings.find((x) => x.id === this.selectedId);
      if (d) { d.color = this.style.color; d.width = this.style.width; this.pushUndo(); this.onChange(); }
    }
    this.render();
  }

  load(drawings: Drawing[]) {
    this.drawings = (drawings || []).filter((d) => d && d.tool && Array.isArray(d.points));
    this.undoStack = [];
    this.redoStack = [];
    this.render();
    this.onChange();
  }

  /** Programmatically add a finished drawing (context menu shortcuts). */
  addDrawing(tool: Exclude<DrawingTool, "cursor">, points: DrawingPoint[]) {
    this.pushUndo();
    this.drawings.push({ id: uid(), tool, points, color: this.style.color, width: this.style.width });
    this.onChange();
    this.render();
  }

  serialize(): Drawing[] {
    return JSON.parse(JSON.stringify(this.drawings));
  }

  deleteSelected() {
    if (!this.selectedId) return;
    const d = this.drawings.find((x) => x.id === this.selectedId);
    if (!d || d.locked) return;
    this.pushUndo();
    this.drawings = this.drawings.filter((x) => x.id !== this.selectedId);
    this.selectedId = null;
    this.fireSel();
    this.onChange();
    this.render();
  }

  toggleLockSelected() {
    const d = this.drawings.find((x) => x.id === this.selectedId);
    if (!d) return;
    d.locked = !d.locked;
    this.pushUndo();
    this.onChange();
    this.render();
  }
  toggleHideSelected() {
    const d = this.drawings.find((x) => x.id === this.selectedId);
    if (!d) return;
    d.hidden = !d.hidden;
    this.onChange();
    this.render();
  }
  clearAll() {
    this.pushUndo();
    this.drawings = [];
    this.selectedId = null;
    this.onChange();
    this.render();
  }

  private pushUndo() {
    this.undoStack.push(JSON.stringify(this.drawings));
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
  }
  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }
  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.drawings));
    this.drawings = JSON.parse(this.undoStack.pop()!);
    this.selectedId = null;
    this.fireSel();
    this.onChange();
    this.render();
  }
  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.drawings));
    this.drawings = JSON.parse(this.redoStack.pop()!);
    this.selectedId = null;
    this.fireSel();
    this.onChange();
    this.render();
  }

  // ---- interaction ----------------------------------------------------------

  private evPos(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // live cursor position (canvas CSS px) — powers the rubber-band preview
  private cursorXY: { x: number; y: number } | null = null;
  // where the current press started — detects drag-to-draw gestures
  private downXY: { x: number; y: number } | null = null;

  private onDown = (e: PointerEvent) => {
    const { x, y } = this.evPos(e);
    const time = this.timeFor(x), price = this.priceFor(y);
    if (time == null || price == null) return;
    this.cursorXY = { x, y };
    this.downXY = { x, y };

    if (this.tool === "cursor") {
      this.selectAt(x, y);
      return;
    }

    // click-to-place tools
    this.pending.push({ time, price });
    const needed = this.neededPoints(this.tool);
    if (needed !== Infinity && this.pending.length >= needed) this.finishPending();
    this.render();
  };

  /** finalize the pending points into a real drawing — shared by the
   *  click-click flow AND the drag-release flow */
  private finishPending() {
    this.pushUndo();
    this.drawings.push({
      id: uid(),
      tool: this.tool as Exclude<DrawingTool, "cursor">,
      points: [...this.pending],
      color: this.style.color,
      width: this.style.width,
    });
    this.pending = [];
    // drawing finished — deactivate the tool so the next click doesn't
    // start another one (arrow "never stops" bug)
    this.tool = "cursor";
    this.cursorXY = null;
    this.onToolDone("cursor");
    this.onChange();
  }

  private neededPoints(tool: Exclude<DrawingTool, "cursor">): number {
    switch (tool) {
      case "hline": case "vline": case "text": return 1;
      case "fibext": case "channel": return 3;
      case "brush": return Infinity; // brush completes on pointerup
      default: return 2;
    }
  }

  private onMove = (e: PointerEvent) => {
    const { x, y } = this.evPos(e);
    this.cursorXY = { x, y };
    if (this.tool !== "cursor") this.canvas.style.cursor = "crosshair";
    if (this.dragEndpoint) {
      // TradingView-style endpoint drag — resize / rotate / extend one end,
      // the other end (and the whole shape) stays put
      const d = this.drawings.find((z) => z.id === this.dragEndpoint!.id);
      if (!d) return;
      const time = this.timeFor(x), price = this.priceFor(y);
      if (time != null && price != null) {
        d.points[this.dragEndpoint.idx] = { time, price };
        this.dragEndpoint.moved = true;
        this.render();
      }
      return;
    }
    if (this.dragging) {
      const d = this.drawings.find((z) => z.id === this.dragging!.id);
      if (!d) return;
      const dxTime = (this.timeFor(x) ?? 0) - (this.timeFor(this.dragging.startX) ?? 0);
      const dyPrice = (this.priceFor(y) ?? 0) - (this.priceFor(this.dragging.startY) ?? 0);
      d.points = this.dragging.orig.map((p) => ({ time: p.time + dxTime, price: p.price + dyPrice }));
      this.render();
      return;
    }
    if (this.tool === "brush" && this.pending.length) {
      const time = this.timeFor(x), price = this.priceFor(y);
      if (time != null && price != null) this.pending.push({ time, price });
      this.render();
      return;
    }
    if (this.tool === "cursor") {
      const ep = this.hitEndpoint(x, y);
      const hit = ep ?? this.hitTest(x, y);
      if ((hit?.id ?? null) !== this.hoverId) {
        this.hoverId = hit?.id ?? null;
        this.render();
      }
      this.canvas.style.cursor = ep ? "nwse-resize" : hit ? "pointer" : "default";
    } else if (this.pending.length) {
      this.render(); // preview line to cursor
    }
  };

  private onUp = (e: PointerEvent) => {
    if (this.dragEndpoint) {
      const moved = this.dragEndpoint.moved;
      this.dragEndpoint = null;
      if (moved) { this.pushUndo(); this.onChange(); }
    }
    if (this.dragging) {
      this.pushUndo();
      this.dragging = null;
      this.onChange();
    }
    if (this.tool === "brush" && this.pending.length > 1) {
      this.pushUndo();
      this.drawings.push({ id: uid(), tool: "brush", points: [...this.pending], color: this.style.color, width: this.style.width });
      this.pending = [];
      // brush stroke finished — back to the cursor
      this.tool = "cursor";
      this.onToolDone("cursor");
      this.onChange();
    } else if (this.pending.length && this.downXY) {
      // drag-to-draw: pressed at point 1, dragged, released — finish the
      // shape on release (a plain click without movement still waits for
      // the second click, so the click-click flow is untouched)
      const { x, y } = this.evPos(e);
      const moved = Math.hypot(x - this.downXY.x, y - this.downXY.y) > 6;
      const needed = this.neededPoints(this.tool as Exclude<DrawingTool, "cursor">);
      if (moved && needed !== Infinity && this.pending.length < needed) {
        const time = this.timeFor(x), price = this.priceFor(y);
        if (time != null && price != null) {
          this.pending.push({ time, price });
          if (this.pending.length >= needed) this.finishPending();
        }
      }
    }
    this.downXY = null;
    this.render();
  };

  private onDblClick = (e: MouseEvent) => {
    const d = this.drawings.find((x) => x.id === this.selectedId);
    if (d && d.tool === "text" && !d.locked) {
      e.stopPropagation(); // text edit wins over chart "reset view"
      const t = window.prompt("Text", d.text || "");
      if (t != null) { d.text = t; this.pushUndo(); this.onChange(); this.render(); }
    }
  };

  // ---- selection & cursor-mode pointer routing ------------------------------

  /** shared click-selection: endpoint grab vs whole-shape select/move */
  private selectAt(x: number, y: number) {
    const ep = this.hitEndpoint(x, y);
    if (ep) {
      this.dragEndpoint = { id: ep.id, idx: ep.idx, moved: false };
      this.render();
      this.onChange();
      return;
    }
    const hit = this.hitTest(x, y);
    this.selectedId = hit?.id ?? null;
    this.fireSel();
    if (hit && !hit.d.locked) {
      this.dragging = { id: hit.id, startX: x, startY: y, orig: JSON.parse(JSON.stringify(hit.d.points)) };
    }
    this.render();
    this.onChange();
  }

  /** flips the drawing canvas between pointer-events none/auto depending on
   *  whether the cursor is over a drawing — chart stays interactive elsewhere */
  private syncPointer = (e: PointerEvent) => {
    if (this.tool !== "cursor") return; // active tools keep the canvas auto
    if (this.dragging || this.dragEndpoint) {
      this.canvas.style.pointerEvents = "auto"; // drag continues outside too
      return;
    }
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const over = x >= 0 && y >= 0 && x <= r.width && y <= r.height
      && (!!this.hitEndpoint(x, y) || !!this.hitTest(x, y));
    this.canvas.style.pointerEvents = over ? "auto" : "none";
    if (!over && this.hoverId) {
      this.hoverId = null;
      this.render();
    }
  };

  /** window-level pointerdown (capture): selects on touch taps (no prior
   *  mousemove → the canvas never saw the event) and deselects when the user
   *  clicks anywhere outside the drawings */
  private onWinDown = (e: PointerEvent) => {
    if (this.tool !== "cursor" || this.dragging || this.dragEndpoint) return;
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const inside = x >= 0 && y >= 0 && x <= r.width && y <= r.height;
    if (inside && e.target !== this.canvas) {
      if (this.hitEndpoint(x, y) || this.hitTest(x, y)) {
        this.canvas.style.pointerEvents = "auto";
        this.selectAt(x, y);
        e.stopPropagation(); // the chart must not pan on this tap
        return;
      }
    }
    const t = e.target as HTMLElement | null;
    if (this.selectedId && e.target !== this.canvas && !t?.closest?.("[data-draw-sel-bar]")) {
      this.selectedId = null;
      this.fireSel();
      this.render();
    }
  };

  /** endpoint handles of the SELECTED shape (the amber dots) */
  private hitEndpoint(px: number, py: number): { id: string; idx: number; d: Drawing } | null {
    const d = this.drawings.find((x) => x.id === this.selectedId);
    if (!d || d.hidden || d.locked || d.tool === "brush") return null;
    for (let i = 0; i < d.points.length; i++) {
      const x = this.xFor(d.points[i].time), y = this.yFor(d.points[i].price);
      if (x == null || y == null) continue;
      if (Math.hypot(px - x, py - y) <= 7) return { id: d.id, idx: i, d };
    }
    return null;
  }

  // ---- hit testing ----------------------------------------------------------

  private distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
    const cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  private hitTest(px: number, py: number): { id: string; d: Drawing } | null {
    for (const d of [...this.drawings].reverse()) {
      if (d.hidden) continue;
      const pts = d.points.map((p) => ({ x: this.xFor(p.time), y: this.yFor(p.price) }));
      if (pts.some((p) => p.x == null || p.y == null)) continue;
      const P = pts as { x: number; y: number }[];
      let hit = false;
      switch (d.tool) {
        case "hline": hit = Math.abs(P[0].y - py) < SELECT_RADIUS; break;
        case "vline": hit = Math.abs(P[0].x - px) < SELECT_RADIUS; break;
        case "text": {
          const w = this.ctx.measureText(d.text || "").width;
          hit = px >= P[0].x - 4 && px <= P[0].x + w + 8 && Math.abs(py - P[0].y) < 14;
          break;
        }
        case "rect": case "long": case "short": case "measure": {
          const x1 = Math.min(P[0].x, P[1].x), x2 = Math.max(P[0].x, P[1].x);
          const y1 = Math.min(P[0].y, P[1].y), y2 = Math.max(P[0].y, P[1].y);
          hit = (Math.abs(py - y1) < SELECT_RADIUS || Math.abs(py - y2) < SELECT_RADIUS) && px >= x1 && px <= x2
            || (Math.abs(px - x1) < SELECT_RADIUS || Math.abs(px - x2) < SELECT_RADIUS) && py >= y1 && py <= y2;
          break;
        }
        case "fib": {
          const p0 = P[0], p1 = P[1];
          for (const lvl of FIB_LEVELS) {
            const y = p0.y + (p1.y - p0.y) * lvl;
            if (Math.abs(py - y) < SELECT_RADIUS && px >= Math.min(p0.x, p1.x) - 10 && px <= Math.max(p0.x, p1.x) + 10) hit = true;
          }
          break;
        }
        case "fibext": {
          if (P.length < 3) break;
          // move height p0→p1 projected from p2
          const dy = (P[1].y - P[0].y);
          for (const lvl of FIB_EXT_LEVELS) {
            const y = P[2].y + dy * lvl;
            if (Math.abs(py - y) < SELECT_RADIUS) hit = true;
          }
          break;
        }
        case "channel": {
          if (P.length < 3) break;
          // offset of the parallel line relative to p0→p1
          const ox = P[2].x - P[0].x, oy = P[2].y - P[0].y;
          hit = this.distToSeg(px, py, P[0].x, P[0].y, P[1].x, P[1].y) < SELECT_RADIUS
            || this.distToSeg(px, py, P[0].x + ox, P[0].y + oy, P[1].x + ox, P[1].y + oy) < SELECT_RADIUS;
          break;
        }
        case "brush": {
          for (let i = 1; i < P.length && !hit; i++) hit = this.distToSeg(px, py, P[i - 1].x, P[i - 1].y, P[i].x, P[i].y) < SELECT_RADIUS;
          break;
        }
        default: {
          if (P.length >= 2) hit = this.distToSeg(px, py, P[0].x, P[0].y, P[1].x, P[1].y) < SELECT_RADIUS;
        }
      }
      if (hit) return { id: d.id, d };
    }
    return null;
  }

  // ---- rendering ------------------------------------------------------------

  render() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);
    this.ctx.clearRect(0, 0, w, h);
    const series = this.getSeries();

    const toXY = (p: DrawingPoint) => ({ x: this.xFor(p.time), y: this.yFor(p.price) });

    for (const d of this.drawings) {
      if (d.hidden) continue;
      const pts = d.points.map(toXY);
      const selected = d.id === this.selectedId;
      const col = d.color;
      const lw = d.width;
      this.ctx.lineWidth = lw;
      this.ctx.strokeStyle = col;
      this.ctx.fillStyle = col;
      this.ctx.font = "12px ui-sans-serif, system-ui";

      if (pts.some((p) => p.x == null || p.y == null)) {
        // partially offscreen — still draw tools that tolerate one anchor
        if (!["hline", "fib", "rect", "long", "short", "measure"].includes(d.tool)) continue;
      }
      const P = pts as { x: number; y: number }[];
      const n = d.tool === "brush" ? Infinity : this.neededPoints(d.tool as Exclude<DrawingTool, "cursor">);
      const complete = d.points.length >= (n === Infinity ? 2 : n);

      // user label on any shape ("Text" in the floating object toolbar) —
      // drawn at the shape's midpoint, pill background for readability
      if (d.text && d.tool !== "text" && d.tool !== "fib" && d.tool !== "fibext") {
        const anchor = P.length >= 2 && d.tool !== "hline" && d.tool !== "vline"
          ? { x: (P[0].x + P[1].x) / 2, y: (P[0].y + P[1].y) / 2 }
          : P[0];
        if (anchor && anchor.x != null) {
          const tw = this.ctx.measureText(d.text).width;
          this.ctx.fillStyle = "rgba(13,17,23,0.85)";
          this.ctx.fillRect(anchor.x + 8, anchor.y - 20, tw + 12, 17);
          this.ctx.fillStyle = col;
          this.ctx.fillText(d.text, anchor.x + 14, anchor.y - 7);
        }
      }

      switch (d.tool) {
        case "trendline": case "arrow": {
          if (P.length < 2) break;
          this.ctx.beginPath(); this.ctx.moveTo(P[0].x, P[0].y); this.ctx.lineTo(P[1].x, P[1].y); this.ctx.stroke();
          if (d.tool === "arrow") {
            const ang = Math.atan2(P[1].y - P[0].y, P[1].x - P[0].x);
            const a1 = ang + Math.PI - 0.4, a2 = ang + Math.PI + 0.4, L = 10 + lw * 2;
            this.ctx.beginPath();
            this.ctx.moveTo(P[1].x, P[1].y); this.ctx.lineTo(P[1].x + L * Math.cos(a1), P[1].y + L * Math.sin(a1));
            this.ctx.moveTo(P[1].x, P[1].y); this.ctx.lineTo(P[1].x + L * Math.cos(a2), P[1].y + L * Math.sin(a2));
            this.ctx.stroke();
          }
          break;
        }
        case "hline": {
          if (!P[0]) break;
          this.ctx.beginPath(); this.ctx.moveTo(0, P[0].y); this.ctx.lineTo(w, P[0].y); this.ctx.stroke();
          this.ctx.fillText(this.fmt(series, d.points[0].price), 6, P[0].y - 4);
          break;
        }
        case "vline": {
          if (!P[0]) break;
          this.ctx.beginPath(); this.ctx.moveTo(P[0].x, 0); this.ctx.lineTo(P[0].x, h); this.ctx.stroke();
          break;
        }
        case "ray": case "extline": {
          if (P.length < 2) break;
          const dx = P[1].x - P[0].x, dy = P[1].y - P[0].y;
          const big = Math.max(w, h) * 2;
          this.ctx.beginPath();
          if (d.tool === "ray") {
            this.ctx.moveTo(P[0].x, P[0].y); this.ctx.lineTo(P[0].x + dx * big, P[0].y + dy * big);
          } else {
            this.ctx.moveTo(P[0].x - dx * big, P[0].y - dy * big); this.ctx.lineTo(P[0].x + dx * big, P[0].y + dy * big);
          }
          this.ctx.stroke();
          break;
        }
        case "rect": {
          if (P.length < 2) break;
          const x = Math.min(P[0].x, P[1].x), y = Math.min(P[0].y, P[1].y);
          const rw = Math.abs(P[1].x - P[0].x), rh = Math.abs(P[1].y - P[0].y);
          this.ctx.globalAlpha = 0.12; this.ctx.fillRect(x, y, rw, rh);
          this.ctx.globalAlpha = 1; this.ctx.strokeRect(x, y, rw, rh);
          break;
        }
        case "fib": {
          if (P.length < 2) break;
          const p0 = P[0], p1 = P[1];
          const x1 = Math.min(p0.x, p1.x), x2 = Math.max(p0.x, p1.x);
          for (const lvl of FIB_LEVELS) {
            const y = p0.y + (p1.y - p0.y) * lvl;
            this.ctx.globalAlpha = 0.1; this.ctx.fillRect(x1, y, x2 - x1, (p1.y - p0.y) * (FIB_LEVELS[1] || 0.236));
            this.ctx.globalAlpha = 1;
            this.ctx.beginPath(); this.ctx.moveTo(x1, y); this.ctx.lineTo(x2, y); this.ctx.stroke();
            this.ctx.fillText(`${lvl.toFixed(3)}  ${this.fmt(series, d.points[0].price + (d.points[1].price - d.points[0].price) * lvl)}`, x2 + 4, y - 2);
          }
          this.ctx.beginPath(); this.ctx.moveTo(p0.x, p0.y); this.ctx.lineTo(p1.x, p1.y); this.ctx.globalAlpha = 0.4; this.ctx.stroke(); this.ctx.globalAlpha = 1;
          break;
        }
        case "fibext": {
          if (P.length < 3) break;
          // trend-based extension: move height (p0→p1) projected from p2
          const dyP = d.points[1].price - d.points[0].price;
          const yBase = P[2].y;
          const x1 = Math.min(P[0].x, P[1].x, P[2].x), x2 = Math.max(P[0].x, P[1].x, P[2].x);
          for (const lvl of FIB_EXT_LEVELS) {
            const y = yBase + (P[1].y - P[0].y) * lvl;
            this.ctx.beginPath(); this.ctx.moveTo(x1, y); this.ctx.lineTo(x2, y); this.ctx.stroke();
            this.ctx.fillText(`${lvl.toFixed(3)}  ${this.fmt(series, d.points[2].price + dyP * lvl)}`, x2 + 4, y - 2);
          }
          this.ctx.globalAlpha = 0.4;
          this.ctx.beginPath(); this.ctx.moveTo(P[0].x, P[0].y); this.ctx.lineTo(P[1].x, P[1].y); this.ctx.stroke();
          this.ctx.beginPath(); this.ctx.moveTo(P[1].x, P[1].y); this.ctx.lineTo(P[2].x, P[2].y); this.ctx.stroke();
          this.ctx.globalAlpha = 1;
          break;
        }
        case "channel": {
          if (P.length < 2) break;
          // parallel channel: p0→p1 main line, p2 sets the offset of the second line
          const ox = P.length >= 3 ? P[2].x - P[0].x : 0;
          const oy = P.length >= 3 ? P[2].y - P[0].y : 0;
          const big = Math.max(w, h) * 2;
          const dx = P[1].x - P[0].x, dy = P[1].y - P[0].y;
          const len = Math.hypot(dx, dy) || 1;
          const ux = dx / len, uy = dy / len;
          this.ctx.beginPath();
          this.ctx.moveTo(P[0].x - ux * big, P[0].y - uy * big);
          this.ctx.lineTo(P[1].x + ux * big, P[1].y + uy * big);
          this.ctx.stroke();
          this.ctx.beginPath();
          this.ctx.moveTo(P[0].x + ox - ux * big, P[0].y + oy - uy * big);
          this.ctx.lineTo(P[1].x + ox + ux * big, P[1].y + oy + uy * big);
          this.ctx.stroke();
          // translucent fill between the lines over the p0→p1 span
          this.ctx.globalAlpha = 0.08;
          this.ctx.beginPath();
          this.ctx.moveTo(P[0].x, P[0].y); this.ctx.lineTo(P[1].x, P[1].y);
          this.ctx.lineTo(P[1].x + ox, P[1].y + oy); this.ctx.lineTo(P[0].x + ox, P[0].y + oy);
          this.ctx.closePath(); this.ctx.fill();
          this.ctx.globalAlpha = 1;
          break;
        }
        case "brush": {
          if (P.length < 2) break;
          this.ctx.beginPath(); this.ctx.moveTo(P[0].x, P[0].y);
          for (let i = 1; i < P.length; i++) this.ctx.lineTo(P[i].x, P[i].y);
          this.ctx.stroke();
          break;
        }
        case "text": {
          if (!P[0]) break;
          this.ctx.fillText(d.text || "Text", P[0].x, P[0].y);
          break;
        }
        case "long": case "short": {
          if (P.length < 2) break;
          const isLong = d.tool === "long";
          const entry = d.points[0].price, stop = d.points[1].price;
          const risk = Math.abs(entry - stop);
          const target = isLong ? entry + 2 * risk : entry - 2 * risk;
          const ty = this.yFor(target);
          if (ty == null) break;
          const x = Math.min(P[0].x, P[1].x), rw = Math.max(Math.abs(P[1].x - P[0].x), 60);
          const ey = P[0].y, sy = P[1].y;
          // risk zone (red)
          this.ctx.fillStyle = "rgba(239,68,68,0.18)";
          this.ctx.fillRect(x, Math.min(ey, sy), rw, Math.abs(sy - ey));
          // profit zone (green)
          this.ctx.fillStyle = "rgba(34,197,94,0.18)";
          this.ctx.fillRect(x, Math.min(ey, ty), rw, Math.abs(ty - ey));
          this.ctx.strokeStyle = col;
          for (const yy of [ey, sy, ty]) { this.ctx.beginPath(); this.ctx.moveTo(x, yy); this.ctx.lineTo(x + rw, yy); this.ctx.stroke(); }
          this.ctx.fillStyle = "rgba(34,197,94,0.9)";
          this.ctx.fillText(`${isLong ? "LONG" : "SHORT"}  1:2`, x + 4, Math.min(ey, ty) + 12);
          break;
        }
        case "measure": {
          if (P.length < 2) break;
          const x = Math.min(P[0].x, P[1].x), y = Math.min(P[0].y, P[1].y);
          const rw = Math.abs(P[1].x - P[0].x), rh = Math.abs(P[1].y - P[0].y);
          this.ctx.fillStyle = "rgba(59,130,246,0.12)";
          this.ctx.fillRect(x, y, rw, rh);
          this.ctx.strokeStyle = col; this.ctx.strokeRect(x, y, rw, rh);
          const p0 = d.points[0], p1 = d.points[1];
          const diff = p1.price - p0.price;
          const pct = p0.price ? (diff / p0.price) * 100 : 0;
          const bars = Math.round(Math.abs(p1.time - p0.time));
          this.ctx.fillStyle = "rgba(147,197,253,0.95)";
          this.ctx.fillText(`${diff >= 0 ? "+" : ""}${this.fmt(series, diff)}  (${pct.toFixed(2)}%)  ${bars}s`, x + 6, y - 6);
          break;
        }
      }

      // pending preview — amber FILLED endpoint handles on the selected shape
      if (selected) {
        this.ctx.strokeStyle = "#fbbf24";
        this.ctx.fillStyle = "#fbbf24";
        this.ctx.lineWidth = 1;
        for (const p of P) { if (p.x == null) continue; this.ctx.beginPath(); this.ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); this.ctx.fill(); this.ctx.stroke(); }
      }
      if (this.hoverId === d.id && !selected) {
        this.ctx.save(); this.ctx.globalAlpha = 0.9; this.ctx.strokeStyle = "#fbbf24";
        this.ctx.lineWidth = 1; this.ctx.setLineDash([4, 3]);
        // dashed outline approximated by re-stroking with dash
        this.ctx.restore();
      }
    }

    // in-progress tool preview — rubber-band from the placed points to the
    // LIVE cursor so the shape is visible WHILE dragging, not only after
    if (this.pending.length && this.cursorXY) {
      const pts = this.pending.map(toXY);
      const cx = this.cursorXY.x, cy = this.cursorXY.y;
      const solid = pts.filter((p) => p.x != null && p.y != null) as { x: number; y: number }[];
      this.ctx.strokeStyle = this.style.color;
      this.ctx.fillStyle = this.style.color;
      this.ctx.lineWidth = this.style.width;
      this.ctx.save();
      this.ctx.globalAlpha = 0.85;
      if (this.tool === "brush") {
        // freehand: polyline so far + a live tail to the cursor
        this.ctx.beginPath();
        if (solid.length) this.ctx.moveTo(solid[0].x, solid[0].y);
        for (const p of solid) this.ctx.lineTo(p.x, p.y);
        this.ctx.lineTo(cx, cy);
        this.ctx.stroke();
      } else if (solid.length === 1) {
        const p0 = solid[0];
        if (["rect", "long", "short", "measure", "fib"].includes(this.tool)) {
          // box-style tools: translucent rubber rectangle + outline
          const x = Math.min(p0.x, cx), y = Math.min(p0.y, cy);
          const rw = Math.abs(cx - p0.x), rh = Math.abs(cy - p0.y);
          this.ctx.globalAlpha = 0.12;
          this.ctx.fillRect(x, y, rw, rh);
          this.ctx.globalAlpha = 0.9;
          this.ctx.strokeRect(x, y, rw, rh);
        } else {
          // line-style tools: rubber-band line to the cursor
          this.ctx.beginPath(); this.ctx.moveTo(p0.x, p0.y); this.ctx.lineTo(cx, cy); this.ctx.stroke();
        }
      } else if (solid.length === 2) {
        // 3-point tools (channel / fibext): both legs drawn live
        const [p0, p1] = solid;
        this.ctx.beginPath(); this.ctx.moveTo(p0.x, p0.y); this.ctx.lineTo(p1.x, p1.y); this.ctx.stroke();
        this.ctx.beginPath(); this.ctx.moveTo(p1.x, p1.y); this.ctx.lineTo(cx, cy); this.ctx.stroke();
        if (this.tool === "channel") {
          // the second parallel line follows the cursor offset live
          const ox = cx - p0.x, oy = cy - p0.y;
          this.ctx.globalAlpha = 0.4;
          this.ctx.beginPath(); this.ctx.moveTo(p0.x + ox, p0.y + oy); this.ctx.lineTo(p1.x + ox, p1.y + oy); this.ctx.stroke();
        }
      }
      // anchor dots on the placed points
      this.ctx.globalAlpha = 0.9;
      this.ctx.lineWidth = 1;
      for (const p of solid) { this.ctx.beginPath(); this.ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); this.ctx.stroke(); }
      this.ctx.restore();
    }

    // crosshair-sync vertical line (hover on another chart of the layout)
    if (this.syncTime != null) {
      const x = this.xFor(this.syncTime);
      if (x != null) {
        this.ctx.save();
        this.ctx.strokeStyle = "rgba(250,204,21,0.55)";
        this.ctx.lineWidth = 1;
        this.ctx.setLineDash([3, 3]);
        this.ctx.beginPath(); this.ctx.moveTo(x, 0); this.ctx.lineTo(x, h); this.ctx.stroke();
        this.ctx.restore();
      }
    }
  }

  private fmt(series: ISeriesApi<"Candlestick"> | null, v: number): string {
    if (series == null || !Number.isFinite(v)) return String(v);
    try {
      const p = (series as any).options?.priceFormat?.precision ?? 2;
      const m = (series as any).options?.priceFormat?.minMove ?? 0.01;
      const digits = Math.max(0, Math.round(-Math.log10(m || 0.01)));
      return v.toFixed(Math.min(Number(p) || digits, 8) || digits);
    } catch {
      return v.toFixed(2);
    }
  }
}
