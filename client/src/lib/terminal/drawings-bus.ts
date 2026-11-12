/**
 * Tiny command bus for drawing-tool actions. The toolbar lives in
 * TerminalPage; DrawingEngine instances live inside each TerminalChart.
 * Commands broadcast to every mounted chart engine (layouts share drawings).
 */
import type { DrawingStyle } from "./drawings";

export type DrawingsCommand = "undo" | "redo" | "lock" | "hide" | "delete" | "style";

interface BusMessage { cmd: DrawingsCommand; arg?: Partial<DrawingStyle> }

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
