/**
 * chart-sync — PHASE 48 Part 3: optional cross-chart synchronization.
 *
 * Toggles (persisted, independently switchable):
 *  · crosshair — a chart's crosshair position mirrors the hovered time on
 *    every other synced panel
 *  · time — the visible time range (zoom + scroll) mirrors across panels
 *  · interval / symbol — workspace-level: changing one synced panel's
 *    timeframe/instrument applies to all (handled by MultiChartWorkspace)
 *
 * Drawing sync is intentionally NOT forced: drawings are stored per
 * (user, instrument) — two panels showing the SAME instrument already share
 * their drawings through RTDB, which is the technically appropriate sync;
 * cloning drawings across DIFFERENT instruments would corrupt their market
 * coordinates, so it stays off.
 *
 * The bus is a plain module registry (no React state) — chart instances
 * publish and apply with loop guards so a synced range does not bounce back.
 */

export interface SyncSettings {
  crosshair: boolean;
  time: boolean;
}

const SYNC_KEY = "it_chart_sync";

const DEFAULT_SYNC: SyncSettings = { crosshair: false, time: false };

export function loadSyncSettings(): SyncSettings {
  try {
    const raw = localStorage.getItem(SYNC_KEY);
    if (!raw) return { ...DEFAULT_SYNC };
    const p = JSON.parse(raw) as Partial<SyncSettings>;
    return { crosshair: !!p.crosshair, time: !!p.time };
  } catch {
    return { ...DEFAULT_SYNC };
  }
}

export function saveSyncSettings(s: SyncSettings): void {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(s)); } catch { /* private mode */ }
  window.dispatchEvent(new CustomEvent("it_chart_sync_changed"));
}

// ---- crosshair bus -------------------------------------------------------------

export interface SyncCrosshairEvent { key: string; time: number | null; at: number }

type CrosshairCb = (e: SyncCrosshairEvent) => void;
type RangeCb = (e: SyncRangeEvent) => void;

const crosshairCbs = new Set<CrosshairCb>();
const rangeCbs = new Set<RangeCb>();

export function onSyncCrosshair(cb: CrosshairCb): () => void {
  crosshairCbs.add(cb);
  return () => crosshairCbs.delete(cb);
}

export function onSyncRange(cb: RangeCb): () => void {
  rangeCbs.add(cb);
  return () => rangeCbs.delete(cb);
}

export function publishCrosshair(e: SyncCrosshairEvent): void {
  for (const cb of crosshairCbs) cb(e);
}

export interface SyncRangeEvent { key: string; from: number; to: number; at: number }

export function publishRange(e: SyncRangeEvent): void {
  for (const cb of rangeCbs) cb(e);
}

/** shared loop-guard timestamp — while set, charts ignore inbound sync events */
let applyingUntil = 0;
const APPLY_GUARD_MS = 60;

export function isApplyingSync(now = Date.now()): boolean {
  return now < applyingUntil;
}

export function markApplyingSync(now = Date.now()): void {
  applyingUntil = now + APPLY_GUARD_MS;
}
