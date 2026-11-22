/**
 * workspace-schema — PHASE 48 PURE workspace-preset shapes + sanitizer
 * (no Firebase, no browser APIs — unit-tested directly; the RTDB store in
 * lib/workspace-presets composes this).
 */
import type { ChartType } from "@/lib/chart-types";
import type { LayoutId } from "@/lib/chart-layouts";

export interface PanelCfg {
  symbol: string;
  timeframe: string;
  chartType?: ChartType;
}

export interface WorkspacePreset {
  id: string;
  name: string;
  layout: LayoutId;
  panels: PanelCfg[];
  colW?: number[];
  rowH?: number[];
  updatedAt: number;
}

export const KNOWN_LAYOUTS: LayoutId[] = ["1", "2h", "2v", "3", "4", "6"];
const KNOWN_TFS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1W", "1M"];

/** Validate + clamp a workspace preset from any untrusted shape. */
export function sanitizePreset(raw: WorkspacePreset): WorkspacePreset | null {
  if (!raw || typeof raw !== "object") return null;
  const layout = KNOWN_LAYOUTS.includes(raw.layout) ? raw.layout : "1";
  const panels = Array.isArray(raw.panels)
    ? raw.panels.slice(0, 6).map((p: any) => ({
        symbol: String(p?.symbol || "").toUpperCase().slice(0, 20),
        timeframe: (KNOWN_TFS.includes(p?.timeframe) ? p.timeframe : "1h") as PanelCfg["timeframe"],
        chartType: p?.chartType ? String(p.chartType).slice(0, 12) as ChartType : undefined,
      })).filter((p: PanelCfg) => p.symbol)
    : [];
  if (!panels.length) return null;
  return {
    id: String(raw.id || "").slice(0, 60),
    name: String(raw.name || "Workspace").trim().slice(0, 60) || "Workspace",
    layout,
    panels,
    colW: Array.isArray(raw.colW) ? raw.colW.slice(0, 3).map(Number).filter((v: number) => Number.isFinite(v) && v > 0) : undefined,
    rowH: Array.isArray(raw.rowH) ? raw.rowH.slice(0, 2).map(Number).filter((v: number) => Number.isFinite(v) && v > 0) : undefined,
    updatedAt: Number(raw.updatedAt ?? 0) || Date.now(),
  };
}
