/**
 * chart-layouts — PHASE 48 Part 1: PURE multi-chart layout math.
 *
 * A layout is a small grid definition: column weights, row weights and one
 * cell (col/row/colSpan/rowSpan) per panel. Dividers are computed from the
 * weights as percentage rectangles — the workspace renders absolutely-
 * positioned drag handles there and resizes the adjacent weight pair.
 * No DOM, no browser APIs — unit-tested directly.
 */

export type LayoutId = "1" | "2h" | "2v" | "3" | "4" | "6";

export interface LayoutCell { c: number; r: number; cs?: number; rs?: number }

export interface LayoutDef {
  id: LayoutId;
  /** human label for the selector */
  label: string;
  panels: number;
  cols: number;
  rows: number;
  cells: LayoutCell[];
}

export const LAYOUTS: Record<LayoutId, LayoutDef> = {
  "1": { id: "1", label: "Single", panels: 1, cols: 1, rows: 1, cells: [{ c: 0, r: 0 }] },
  "2h": { id: "2h", label: "Two horizontal", panels: 2, cols: 2, rows: 1, cells: [{ c: 0, r: 0 }, { c: 1, r: 0 }] },
  "2v": { id: "2v", label: "Two vertical", panels: 2, cols: 1, rows: 2, cells: [{ c: 0, r: 0 }, { c: 0, r: 1 }] },
  "3": {
    id: "3", label: "Three", panels: 3, cols: 2, rows: 2,
    cells: [{ c: 0, r: 0, rs: 2 }, { c: 1, r: 0 }, { c: 1, r: 1 }],
  },
  "4": {
    id: "4", label: "Four (2×2)", panels: 4, cols: 2, rows: 2,
    cells: [{ c: 0, r: 0 }, { c: 1, r: 0 }, { c: 0, r: 1 }, { c: 1, r: 1 }],
  },
  "6": {
    id: "6", label: "Six (2×3)", panels: 6, cols: 3, rows: 2,
    cells: [
      { c: 0, r: 0 }, { c: 1, r: 0 }, { c: 2, r: 0 },
      { c: 0, r: 1 }, { c: 1, r: 1 }, { c: 2, r: 1 },
    ],
  },
};

export const LAYOUT_ORDER: LayoutId[] = ["1", "2h", "2v", "3", "4", "6"];

export interface GridStyle {
  gridTemplateColumns: string;
  gridTemplateRows: string;
}

/** CSS grid template from weights (fr units). */
export function gridStyle(def: LayoutDef, colW: number[], rowH: number[]): GridStyle {
  const cols = normWeights(colW, def.cols);
  const rows = normWeights(rowH, def.rows);
  return {
    gridTemplateColumns: cols.map((w) => `${w}fr`).join(" "),
    gridTemplateRows: rows.map((w) => `${w}fr`).join(" "),
  };
}

/** Clamp + normalize to the layout's track count (all positive, summed = count). */
export function normWeights(w: number[] | undefined, count: number): number[] {
  const src = Array.isArray(w) ? w.slice(0, count) : [];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const v = src[i];
    out.push(Number.isFinite(v) && v > 0 ? v : 1);
  }
  return out;
}

export interface DividerSeg {
  /** absolute position of the divider line, percent of the container */
  left: number;
  top: number;
  width: number;
  height: number;
  /** which weight pair it splits: "c<idx>" between column idx/idx+1, "r<idx>" for rows */
  id: string;
}

/**
 * Divider rectangles (percent of the container) for the drag handles.
 * A vertical divider between col i/i+1 exists for every row where both
 * columns actually host a cell (the "3" layout has no divider inside the
 * full-height left panel, etc.).
 */
export function dividers(def: LayoutDef, colW: number[], rowH: number[]): DividerSeg[] {
  const cols = normWeights(colW, def.cols);
  const rows = normWeights(rowH, def.rows);
  const colTot = cols.reduce((a, b) => a + b, 0);
  const rowTot = rows.reduce((a, b) => a + b, 0);
  const out: DividerSeg[] = [];
  const colStarts = prefixPct(cols, colTot);
  const rowStarts = prefixPct(rows, rowTot);

  const covers = (cell: LayoutCell, axis: "c" | "r", i: number) =>
    axis === "c" ? cell.c <= i && i < cell.c + (cell.cs ?? 1) : cell.r <= i && i < cell.r + (cell.rs ?? 1);

  // vertical dividers (between columns i/i+1): a row segment exists where a
  // cell ENDS at column i and a DIFFERENT cell starts at column i+1 — a cell
  // spanning the boundary (e.g. the full-height left panel of the 3-layout)
  // has no divider inside it
  const endsAt = (cell: LayoutCell, axis: "c" | "r", i: number) =>
    axis === "c" ? cell.c + (cell.cs ?? 1) - 1 === i : cell.r + (cell.rs ?? 1) - 1 === i;
  const startsAt = (cell: LayoutCell, axis: "c" | "r", i: number) =>
    axis === "c" ? cell.c === i : cell.r === i;
  for (let i = 0; i < def.cols - 1; i++) {
    const touched: number[] = [];
    for (let r = 0; r < def.rows; r++) {
      const left = def.cells.some((c) => covers(c, "r", r) && endsAt(c, "c", i));
      const right = def.cells.some((c) => covers(c, "r", r) && startsAt(c, "c", i + 1));
      if (left && right) touched.push(r);
    }
    const left = colStarts[i + 1]; // the boundary sits at the END of column i
    for (const [r0, r1] of contiguousRanges(touched)) {
      out.push({ left, top: rowStarts[r0], width: 0, height: rowStarts[r1 + 1] - rowStarts[r0], id: `c${i}@r${r0}` });
    }
  }
  // horizontal dividers (between rows i/i+1), same end/start rule
  for (let i = 0; i < def.rows - 1; i++) {
    const touched: number[] = [];
    for (let c = 0; c < def.cols; c++) {
      const above = def.cells.some((cell) => covers(cell, "c", c) && endsAt(cell, "r", i));
      const below = def.cells.some((cell) => covers(cell, "c", c) && startsAt(cell, "r", i + 1));
      if (above && below) touched.push(c);
    }
    const top = rowStarts[i + 1];
    for (const [c0, c1] of contiguousRanges(touched)) {
      out.push({ left: colStarts[c0], top, width: colStarts[c1 + 1] - colStarts[c0], height: 0, id: `r${i}@c${c0}` });
    }
  }
  return out;
}

/** merge sorted touching indices into contiguous [start,end] ranges */
function contiguousRanges(idxs: number[]): [number, number][] {
  const sorted = [...new Set(idxs)].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const v of sorted) {
    const last = out[out.length - 1];
    if (last && v <= last[1] + 1) last[1] = Math.max(last[1], v);
    else out.push([v, v]);
  }
  return out;
}

function prefixPct(weights: number[], total: number): number[] {
  const out = [0];
  let acc = 0;
  for (const w of weights) { acc += w; out.push((acc / total) * 100); }
  return out;
}

/**
 * Drag the divider between tracks idx/idx+1 so the boundary sits at
 * `pctBefore` percent of the PAIR's span. Returns the updated weights.
 */
export function resizePair(weights: number[], idx: number, pairStartPct: number, pairSpanPct: number, pointerPct: number): number[] {
  const w = normWeights(weights, weights.length);
  if (idx < 0 || idx + 1 >= w.length || pairSpanPct <= 0) return w;
  const t = Math.min(0.9, Math.max(0.1, (pointerPct - pairStartPct) / pairSpanPct));
  const total = w[idx] + w[idx + 1];
  const next = [...w];
  next[idx] = total * t;
  next[idx + 1] = total * (1 - t);
  return next;
}

/** percent of the container for a pointer position inside [rect] */
export function pointerPct(rect: { left: number; width: number }, clientX: number): number {
  if (rect.width <= 0) return 0;
  return ((clientX - rect.left) / rect.width) * 100;
}

export function pointerPctY(rect: { top: number; height: number }, clientY: number): number {
  if (rect.height <= 0) return 0;
  return ((clientY - rect.top) / rect.height) * 100;
}
