/**
 * P64R user request — TradingView-style per-tool visibility: each drawing
 * TOOL TYPE (trend, hline, fib, …) can be hidden globally from the terminal
 * settings "Scales & lines" section. This is a display filter only: hidden
 * types are skipped by the canvas renderer and hit-testing, but the stored
 * drawing objects are NEVER touched (un-hiding brings them back).
 *
 * Storage: localStorage `it_tool_visibility_v1` — a Partial map
 * (missing key = visible; false = hidden). A tiny pub/sub lets the canvas
 * and the settings section stay in sync without a context provider.
 */
import type { DrawingType } from "./drawings";

const LS_KEY = "it_tool_visibility_v1";

type VisMap = Partial<Record<DrawingType, boolean>> & { __all__?: boolean };

let cache: VisMap | null = null;
const listeners = new Set<() => void>();

function readCache(): VisMap {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(LS_KEY);
    const parsed = raw ? (JSON.parse(raw) as VisMap) : {};
    cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

function writeCache(next: VisMap): void {
  cache = next;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  } catch { /* private mode — session-only */ }
  listeners.forEach((fn) => fn());
}

export function subscribeToolVisibility(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** For useSyncExternalStore — returns the stable cache reference. */
export function getToolVisibilitySnapshot(): VisMap {
  return readCache();
}

/** true → the tool type renders and is hit-testable (default). */
export function isVisibleTool(type: DrawingType): boolean {
  const map = readCache();
  // "__all__" is the hide-everything sentinel (show-all/hide-all buttons);
  // per-type overrides still apply on top of it
  if (map.__all__ === false) return false;
  return map[type] !== false;
}

export function setToolVisible(type: DrawingType, visible: boolean): void {
  const next = { ...readCache() };
  if (visible) delete next[type];
  else next[type] = false;
  writeCache(next);
}

/** Show-all / hide-all in one flag (the sentinel above). */
export function setAllToolsVisible(visible: boolean): void {
  const next = { ...readCache() };
  if (visible) delete next.__all__;
  else next.__all__ = false;
  writeCache(next);
}

export function resetToolVisibility(): void {
  writeCache({});
}
