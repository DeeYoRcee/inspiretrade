/** Pointer style for the chart area — Cross · Dot · Arrow (TradingView cursor group). */
export type CursorMode = "cross" | "dot" | "arrow";

/** CSS cursor for the mode: dot renders a real dot bitmap via SVG data URL. */
export function cursorCss(mode: CursorMode): string {
  if (mode === "arrow") return "default";
  if (mode === "dot") {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><circle cx="6" cy="6" r="2.5" fill="%2338bdf8" stroke="%230b1220" stroke-width="1"/></svg>`;
    return `url("data:image/svg+xml,${svg}") 6 6, crosshair`;
  }
  return "crosshair";
}
