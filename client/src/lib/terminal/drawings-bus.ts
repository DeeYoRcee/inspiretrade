/**
 * Tiny command bus for drawing-tool actions. The toolbar lives in
 * TerminalPage; DrawingEngine instances live inside each TerminalChart.
 * Commands broadcast to every mounted chart engine (layouts share drawings).
 *
 * "grow" / "shrink" / "label" — act on the SELECTED drawing (floating object
 * toolbar). "sel" is an EVENT fired by the engines: arg = { info: SelInfo | null }
 */
import type { DrawingStyle } from "./drawings";

export type DrawingsCommand =
  | "undo" | "redo" | "lock" | "hide" | "delete" | "style"
  | "grow" | "shrink" | "label" | "sel";

interface BusMessage { cmd: DrawingsCommand; arg?: any }

type Handler = (m: BusMessage) => void;

const handlers = new Set<Handler>();

export const drawingsBus = {
  emit(m: BusMessage) {
    handlers.forEach((h) => {
      try { h(m); } catch { /* one bad chart must not break others */ }
    });
  },
  subscribe(h: Handler): () => void {
    handlers.add(h);
    return () => handlers.delete(h);
  },
};
