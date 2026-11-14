/**
 * Terminal workspace persistence — layout, chart config, indicator sets and
 * display settings saved per-user in RTDB (`terminalSettings/{uid}/terminal`)
 * and restored on login. Debounced writes keep Firebase reads/writes low.
 */
import { useEffect, useRef, useState } from "react";
import { ref, get, set } from "firebase/database";
import { db } from "@/lib/firebase";
import { useAuth } from "./use-auth";
import { DEFAULT_COLORS, type ChartColors } from "@/components/terminal/TerminalChart";
import type { ActiveIndicator } from "@/components/terminal/TerminalChart";
import type { ChartType, Timeframe } from "@shared/terminal";
import type { DrawingTool } from "@/lib/terminal/drawings";

export type LayoutKind = 1 | 2 | 4;

export interface TerminalSettings {
  layout: LayoutKind;
  symbol: string;
  timeframe: Timeframe;
  chartType: ChartType;
  indicators: ActiveIndicator[];
  showVolume: boolean;
  sound: boolean;
  colors: ChartColors;
  defaultRiskPct: number;
  /** right price scale mode — TradingView-style log / percent toggles */
  priceScale: "normal" | "log" | "percent";
  /** magnet crosshair — snaps to OHLC values */
  magnet: boolean;
  /** last-change timestamp of THIS settings copy — the freshest copy (local
   *  mirror vs Firebase) always wins, so a cloud write that never landed
   *  (debounce cut off / rules hiccup) can never resurrect older colors */
  savedAt?: number;
}

export const DEFAULT_SETTINGS: TerminalSettings = {
  layout: 1,
  symbol: "XAUUSD",
  timeframe: "15m",
  chartType: "candles",
  indicators: [{ id: "ema", params: { period: 20 } }, { id: "rsi", params: { period: 14 } }],
  showVolume: true,
  sound: true,
  colors: DEFAULT_COLORS,
  defaultRiskPct: 1,
  priceScale: "normal",
  magnet: false,
};

export function useTerminalWorkspace() {
  const { user } = useAuth();
  // localStorage mirror — Firebase only exists for signed-in users, but the
  // workspace (chart colors, layout, indicators…) must survive reloads for
  // anonymous visitors too (was resetting to defaults every visit)
  const [settings, setSettings] = useState<TerminalSettings>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("inspire_terminal_settings") || "null");
      if (!raw) return DEFAULT_SETTINGS;
      return {
        ...DEFAULT_SETTINGS, ...raw,
        colors: { ...DEFAULT_SETTINGS.colors, ...(raw.colors || {}) },
        indicators: Array.isArray(raw.indicators) ? raw.indicators : DEFAULT_SETTINGS.indicators,
      };
    } catch { return DEFAULT_SETTINGS; }
  });
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!user) { setLoaded(true); return; }
    (async () => {
      try {
        const snap = await get(ref(db, `terminalSettings/${user.uid}/terminal`));
        if (snap.exists()) {
          const saved = snap.val();
          setSettings((s) => {
            // Only apply the cloud copy when it is NEWER than the local
            // mirror: the last change of a session lives in localStorage
            // even when its debounced Firebase write was cut off — that
            // fresh local copy must win over a stale cloud snapshot.
            if ((saved?.savedAt ?? 0) <= (s.savedAt ?? 0)) return s;
            return {
              ...s, ...saved,
              colors: { ...s.colors, ...(saved.colors || {}) },
              indicators: Array.isArray(saved.indicators) ? saved.indicators : s.indicators,
            };
          });
        }
      } catch { /* first visit, offline or rules not yet deployed */ }
      setLoaded(true);
    })();
  }, [user]);

  const update = (patch: Partial<TerminalSettings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch, savedAt: Date.now() };
      try { localStorage.setItem("inspire_terminal_settings", JSON.stringify(next)); } catch { /* quota */ }
      if (user) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          set(ref(db, `terminalSettings/${user.uid}/terminal`), next).catch(() => {});
        }, 800);
      }
      return next;
    });
  };

  return { settings, update, loaded };
}

/** Drawings per symbol in RTDB: `terminalDrawings/{uid}/{symbol}` — with a
 *  localStorage mirror so anonymous visitors keep their drawings per symbol. */
export function useDrawingsStore(uid?: string, symbol?: string) {
  const [drawings, setDrawings] = useState<DrawingList>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;

  useEffect(() => {
    if (!symbol) { setDrawings([]); return; }
    let alive = true;
    const localKey = `terminalDrawingsLocal:${symbol}`;
    (async () => {
      if (!uid) {
        try {
          const raw = JSON.parse(localStorage.getItem(localKey) || "null");
          if (alive) setDrawings(Array.isArray(raw) ? raw : []);
        } catch { if (alive) setDrawings([]); }
        return;
      }
      try {
        const snap = await get(ref(db, `terminalDrawings/${uid}/${symbol}`));
        if (alive) setDrawings(snap.exists() ? snap.val() : []);
      } catch {
        try {
          const raw = JSON.parse(localStorage.getItem(localKey) || "null");
          if (alive) setDrawings(Array.isArray(raw) ? raw : []);
        } catch { if (alive) setDrawings([]); }
      }
    })();
    return () => { alive = false; };
  }, [uid, symbol]);

  const save = (list: DrawingList) => {
    setDrawings(list);
    const localKey = `terminalDrawingsLocal:${symbolRef.current}`;
    try { localStorage.setItem(localKey, JSON.stringify(list)); } catch { /* quota */ }
    if (uid && symbolRef.current) {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        set(ref(db, `terminalDrawings/${uid}/${symbolRef.current}`), list).catch(() => {});
      }, 700);
    }
  };
  return { drawings, save };
}

type DrawingList = import("@/lib/terminal/drawings").Drawing[];
export type { DrawingTool };
