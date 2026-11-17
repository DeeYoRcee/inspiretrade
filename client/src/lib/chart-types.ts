/** Chart rendering type (Lightweight Charts series kinds the terminal offers). */
export type ChartType = "candles" | "hollow" | "line" | "area";

export const CHART_TYPE_KEY = "it_chart_type";

export function loadChartType(): ChartType {
  try {
    const v = localStorage.getItem(CHART_TYPE_KEY);
    if (v === "candles" || v === "hollow" || v === "line" || v === "area") return v;
  } catch { /* private mode */ }
  return "candles";
}

export function saveChartType(t: ChartType) {
  try { localStorage.setItem(CHART_TYPE_KEY, t); } catch { /* private mode */ }
}
