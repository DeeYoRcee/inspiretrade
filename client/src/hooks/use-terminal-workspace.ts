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
  const [settings, setSettings] = useState<TerminalSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const snap = await get(ref(db, `terminalSettings/${user.uid}/terminal`));
        if (snap.exists()) {
          const saved = snap.val();
          setSettings((s) => ({
            ...s, ...saved,
            colors: { ...s.colors, ...(saved.colors || {}) },
            indicators: Array.isArray(saved.indicators) ? saved.indicators : s.indicators,
          }));
        }
      } catch { /* first visit */ }
      setLoaded(true);
    })();
  }, [user]);

  const update = (patch: Partial<TerminalSettings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
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

/** Drawings per symbol in RTDB: `terminalDrawings/{uid}/{symbol}` */
export function useDrawingsStore(uid?: string, symbol?: string) {
  const [drawings, setDrawings] = useState<DrawingList>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;

  useEffect(() => {
    if (!uid || !symbol) { setDrawings([]); return; }
    let alive = true;
    (async () => {
      try {
        const snap = await get(ref(db, `terminalDrawings/${uid}/${symbol}`));
        if (alive) setDrawings(snap.exists() ? snap.val() : []);
      } catch { if (alive) setDrawings([]); }
    })();
    return () => { alive = false; };
  }, [uid, symbol]);

  const save = (list: DrawingList) => {
    setDrawings(list);
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
