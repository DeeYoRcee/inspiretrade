/** Chart rendering type (Lightweight Charts series kinds the terminal offers).
 * Phase 34: bars / baseline / heikin added — all render genuine OHLC-derived data. */
export type ChartType = "candles" | "hollow" | "bars" | "baseline" | "line" | "area" | "heikin";

export const CHART_TYPE_KEY = "it_chart_type";

export function loadChartType(): ChartType {
  try {
    const v = localStorage.getItem(CHART_TYPE_KEY);
    if (v === "candles" || v === "hollow" || v === "bars" || v === "baseline" || v === "line" || v === "area" || v === "heikin") return v;
  } catch { /* private mode */ }
  return "candles";
}

export function saveChartType(t: ChartType) {
  try { localStorage.setItem(CHART_TYPE_KEY, t); } catch { /* private mode */ }
}
