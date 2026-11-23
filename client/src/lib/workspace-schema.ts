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

/** PHASE 60 — cross-chart sync state travels WITH the workspace. */
export interface WorkspaceSyncCfg {
  crosshair: boolean;
  time: boolean;
  symbol: boolean;
  interval: boolean;
}

export interface WorkspacePreset {
  id: string;
  name: string;
  layout: LayoutId;
  panels: PanelCfg[];
  colW?: number[];
  rowH?: number[];
  updatedAt: number;
  /** PHASE 60: the user's default workspace (restored when no last-active) */
  default?: boolean;
  /** PHASE 60: sync toggles captured with the grid */
  sync?: WorkspaceSyncCfg;
}

export const KNOWN_LAYOUTS: LayoutId[] = ["1", "2h", "2v", "3", "4", "6"];
const KNOWN_TFS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1W", "1M"];

/** Validate + clamp a workspace preset from any untrusted shape. */
export function sanitizePreset(raw: WorkspacePreset): WorkspacePreset | null {
  if (!raw || typeof raw !== "object") return null;
  const layout = KNOWN_LAYOUTS.includes(raw.layout) ? raw.layout : "1";
  // PHASE 60 hardening (found by regression tests): a hostile import used to
  // survive as symbol "[OBJECT OBJECT]" (String({a:1})) and arbitrary
  // chartType strings — symbols must be plain instrument codes and chart
  // types must be from the KNOWN set.
  // mirrors lib/chart-types ChartType union exactly
  const KNOWN_CHART_TYPES: string[] = ["candles", "hollow", "bars", "baseline", "line", "area", "heikin"];
  const panels = Array.isArray(raw.panels)
    ? raw.panels.slice(0, 6).map((p: any) => ({
        symbol: typeof p?.symbol === "string" && /^[A-Za-z0-9.^_-]{1,20}$/.test(p.symbol)
          ? p.symbol.toUpperCase()
          : "",
        timeframe: (KNOWN_TFS.includes(p?.timeframe) ? p.timeframe : "1h") as PanelCfg["timeframe"],
        chartType: typeof p?.chartType === "string" && KNOWN_CHART_TYPES.includes(p.chartType)
          ? p.chartType as ChartType
          : undefined,
      })).filter((p: PanelCfg) => p.symbol)
    : [];
  if (!panels.length) return null;
  const syncRaw = raw.sync as Partial<WorkspaceSyncCfg> | undefined;
  return {
    id: String(raw.id || "").slice(0, 60),
    name: String(raw.name || "Workspace").trim().slice(0, 60) || "Workspace",
    layout,
    panels,
    colW: Array.isArray(raw.colW) ? raw.colW.slice(0, 3).map(Number).filter((v: number) => Number.isFinite(v) && v > 0) : undefined,
    rowH: Array.isArray(raw.rowH) ? raw.rowH.slice(0, 2).map(Number).filter((v: number) => Number.isFinite(v) && v > 0) : undefined,
    updatedAt: Number(raw.updatedAt ?? 0) || Date.now(),
    default: raw.default === true,
    sync: syncRaw && typeof syncRaw === "object" ? {
      crosshair: syncRaw.crosshair === true,
      time: syncRaw.time === true,
      symbol: syncRaw.symbol === true,
      interval: syncRaw.interval === true,
    } : undefined,
  };
}

// ---- PHASE 60: export / import (shareable JSON, NO credentials) -------------

export interface WorkspaceExportFile {
  inspiretrade: 1;
  kind: "workspace";
  name: string;
  layout: LayoutId;
  panels: PanelCfg[];
  colW?: number[];
  rowH?: number[];
  sync?: WorkspaceSyncCfg;
  exportedAt: string;
}

/** Serialize a workspace for export. Contains ONLY layout/panel config —
 * never tokens, account data or market data. */
export function exportWorkspaceFile(w: WorkspacePreset): WorkspaceExportFile {
  const clean = sanitizePreset(w);
  if (!clean) throw new Error("Invalid workspace");
  return {
    inspiretrade: 1,
    kind: "workspace",
    name: clean.name,
    layout: clean.layout,
    panels: clean.panels,
    colW: clean.colW,
    rowH: clean.rowH,
    sync: clean.sync,
    exportedAt: new Date().toISOString(),
  };
}

/** Parse + sanitize an exported workspace file. Throws with a readable
 * message on invalid/incompatible files; NEVER trusts ids (a fresh id is
 * minted) — the caller saves it under the CURRENT user only. */
export function importWorkspaceFile(json: string): WorkspacePreset {
  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Not a valid JSON file");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Not a workspace file");
  if (parsed.kind !== "workspace" || parsed.inspiretrade !== 1) {
    throw new Error("This file is not an InspireTrade workspace export");
  }
  const candidate: WorkspacePreset = {
    id: `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: String(parsed.name || "Imported workspace").slice(0, 60),
    layout: parsed.layout,
    panels: Array.isArray(parsed.panels) ? parsed.panels : [],
    colW: parsed.colW,
    rowH: parsed.rowH,
    sync: parsed.sync,
    updatedAt: Date.now(),
  };
  const clean = sanitizePreset(candidate);
  if (!clean) throw new Error("Workspace has no valid panels");
  return clean;
}
