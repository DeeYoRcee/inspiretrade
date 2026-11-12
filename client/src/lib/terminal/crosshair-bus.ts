/**
 * Crosshair sync bus — broadcasts the hovered bar time between all chart
 * instances of the terminal workspace so multi-chart layouts show a synced
 * vertical cursor and OHLC legends.
 */
export interface CrosshairMessage {
  sourceId: string;
  /** hovered bar time (UNIX seconds), or null when the cursor leaves */
  time: number | null;
}

type Handler = (m: CrosshairMessage) => void;

const handlers = new Set<Handler>();

export const crosshairBus = {
  emit(m: CrosshairMessage) {
    handlers.forEach((h) => {
      try { h(m); } catch { /* one broken chart must not break others */ }
    });
  },
  subscribe(h: Handler): () => void {
    handlers.add(h);
    return () => handlers.delete(h);
  },
};
