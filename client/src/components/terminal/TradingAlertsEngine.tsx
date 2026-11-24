/**
 * TradingAlertsEngine — PHASE 47 Part 3/6/7: the CLIENT-side real-time
 * evaluator, mounted app-wide next to AlertsEngine.
 *
 * Why both sides evaluate: the Vercel Hobby cron runs /api/alerts-cron once
 * a day (plan limit — documented in the audit), so real-time detection while
 * the user is online happens here, against the SAME real data sources the
 * chart uses (market-data feed subscriptions — Binance WS / gold-api spot /
 * quotes proxy). The server cron remains the closed-browser push path and
 * writes `lastTriggeredAt` back to the same records, so client and server
 * de-duplicate against each other (cooldowns + trigger history).
 *
 * Indicator + drawing alerts need full OHLC / user drawings → evaluated from
 * the terminal-bridge snapshot (the open chart publishes bars + drawings);
 * they only run while the terminal is open, never during replay (look-ahead
 * safety), exactly like the cron's own docstring promises.
 */
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { subscribeFeed, quotesSnapshotBars } from "@/lib/market-data";
import { priceBusUpdateMany } from "@/lib/price-store";
import { publishTerminalSnapshot, readTerminalSnapshot } from "@/lib/terminal-bridge";
import type { Bar, Timeframe } from "@shared/terminal";
import type { Drawing } from "@/lib/drawings";
import {
  browserNotify, inQuietHours, loadAlertSettings, playAlertBeep, appendAlertLog,
} from "@/lib/notifications";
import { pushSyncedNotif } from "@/lib/notification-center";
import {
  alertDrawingMissing, evaluateDrawingAlert, evaluateIndicatorAlert, evaluatePriceAlert,
  patchAlert, recordTrigger, subscribeAlerts, triggerGate, type TradingAlert,
} from "@/lib/trading-alerts";

const EVAL_MS = 5000;

function fireTitle(a: TradingAlert, detail: string): string {
  if (a.message && a.message.trim()) return a.message.trim().slice(0, 120);
  return `${a.symbol} · ${detail.slice(0, 120)}`;
}

export function TradingAlertsEngine() {
  const { toast } = useToast();
  const alertsRef = useRef<TradingAlert[]>([]);
  const pricesRef = useRef<Map<string, number>>(new Map());
  const prevPriceRef = useRef<Map<string, number>>(new Map());
  /** symbol → open time of the newest bar seen (per-bar / bar-close logic) */
  const barTimeRef = useRef<Map<string, number>>(new Map());
  const barCloseRef = useRef<Set<string>>(new Set());
  const dailyHLRef = useRef<{ at: number; hl: Map<string, { high: number; low: number }> }>({ at: 0, hl: new Map() });
  const firingRef = useRef<Set<string>>(new Set());
  const unsubFeedsRef = useRef<Array<() => void>>([]);
  // Phase 59: subscribeAlerts writes a REF (no setState) — the old effect dep
  // `[alertsRef.current.length]` never re-ran when an alert for a NEW symbol
  // was added, leaving that alert without a live feed until an unrelated
  // re-render. A version counter state makes the change explicit.
  const [alertsVersion, setAlertsVersion] = useState(0);
  const alertsSymbolsKeyRef = useRef("");

  // ---- alert records (cross-device via RTDB) -------------------------------
  useEffect(() => subscribeAlerts((list) => {
    alertsRef.current = list;
    // Phase 59: bump a version state when the watched SYMBOL SET changes so
    // the feed effect below re-syncs (the old `[alertsRef.current.length]`
    // dep never fired — new alerts got no live feed)
    const key = [...new Set(list.filter((a) => a.kind === "price" || a.kind === "dailyHL").map((a) => a.symbol))].sort().join(",");
    if (key !== alertsSymbolsKeyRef.current) {
      alertsSymbolsKeyRef.current = key;
      setAlertsVersion((v) => v + 1);
    }
  }), []);

  // ---- live feeds for every symbol a price/dailyHL alert watches ----------
  useEffect(() => {
    const symbols = [...new Set(alertsRef.current.filter((a) => a.kind === "price" || a.kind === "dailyHL").map((a) => a.symbol))];
    for (const off of unsubFeedsRef.current) { try { off(); } catch { /* already gone */ } }
    unsubFeedsRef.current = [];
    for (const symbol of symbols) {
      try {
        const off = subscribeFeed(symbol, "1m", (u) => {
          // P77 hotfix — an empty-store feed delivery can carry no lastBar
          if (!u.lastBar) return;
          pricesRef.current.set(symbol, u.lastBar.close);
          priceBusUpdateMany({ [symbol]: u.lastBar.close });
          const seen = barTimeRef.current.get(symbol);
          if (u.bars.length) {
            const newest = u.bars[u.bars.length - 1].time;
            if (seen != null && newest > seen) barCloseRef.current.add(symbol); // a bar just CLOSED
            barTimeRef.current.set(symbol, newest);
          }
        });
        unsubFeedsRef.current.push(off);
      } catch { /* feed unavailable — the server cron still covers this alert */ }
    }
    return () => {
      for (const off of unsubFeedsRef.current) { try { off(); } catch { /* already gone */ } }
      unsubFeedsRef.current = [];
    };
  }, [alertsVersion]);



  // ---- the evaluator loop ---------------------------------------------------
  useEffect(() => {
    const fire = async (a: TradingAlert, price: number, detail: string, barTime: number | null, barClose: boolean) => {
      const key = `${a.id}:${barTime ?? "t"}`;
      if (firingRef.current.has(key)) return; // double-fire guard across ticks
      const gate = triggerGate({ a, barTime, barClose });
      if (!gate.allowed) return;
      firingRef.current.add(key);
      try {
        const settings = loadAlertSettings();
        const message = fireTitle(a, detail);
        const body = detail;
        // delivery (Part 5): in-app toast + browser notification (respecting
        // the master switches, browser permission and quiet hours) + the
        // unified, synced notification record. Server web-push stays the
        // closed-browser channel.
        const suppressed = !settings.enabled || settings.tradingAlerts === false;
        if (!suppressed) {
          toast({ title: message, description: body });
          if (settings.sound) playAlertBeep();
          if (settings.browser && !inQuietHours(settings)) void browserNotify(message, body);
          appendAlertLog({ id: key, kind: "alert", symbol: a.symbol, title: message });
        }
        await pushSyncedNotif({
          id: `clt-${a.id}-${barTime ?? Date.now()}`,
          category: "alert",
          title: message,
          body,
          url: `/terminal?symbol=${encodeURIComponent(a.symbol)}`,
          symbol: a.symbol,
        });
        await recordTrigger(a.id, price, detail, {
          once: a.frequency === "once",
          barTime: barTime ?? undefined,
          previous: a,
        });
      } finally {
        firingRef.current.delete(key);
      }
    };

    const evaluate = async () => {
      const alerts = alertsRef.current;
      if (!alerts.length) return;
      const now = Date.now();
      const snap = readTerminalSnapshot();
      const drawings = snap?.drawings ?? [];
      const barClosedSymbols = new Set(barCloseRef.current);
      barCloseRef.current.clear();

      for (const a of alerts) {
        if (a.paused || a.done) continue;
        if (a.expiresAt != null && now > a.expiresAt) continue;
        if (a.kind === "price") {
          const price = pricesRef.current.get(a.symbol) ?? null;
          if (price == null) continue;
          const prev = prevPriceRef.current.get(a.symbol) ?? null;
          prevPriceRef.current.set(a.symbol, price);
          const res = evaluatePriceAlert(a, price, prev);
          if (!res.hit) continue;
          const symbolBar = barTimeRef.current.get(a.symbol) ?? null;
          const closed = barClosedSymbols.has(a.symbol);
          if (a.frequency === "oncePerBarClose" && !closed) continue;
          if (a.frequency === "oncePerBar" && a.lastBarTime != null && symbolBar != null && a.lastBarTime >= symbolBar) continue;
          await fire(a, price, res.detail, symbolBar, closed);
        } else if (a.kind === "dailyHL") {
          // previous-day range: cached 1h; crypto daily klines or recorded daily bars
          if (now - dailyHLRef.current.at > 3600_000) {
            dailyHLRef.current = { at: now, hl: new Map() };
            for (const sym of new Set(alerts.filter((x) => x.kind === "dailyHL").map((x) => x.symbol))) {
              const day = quotesSnapshotBars(sym, "1d") ?? [];
              if (day.length >= 2) {
                const prev = day[day.length - 2];
                dailyHLRef.current.hl.set(sym, { high: prev.high, low: prev.low });
              }
            }
          }
          const hl = dailyHLRef.current.hl.get(a.symbol);
          const price = pricesRef.current.get(a.symbol);
          if (!hl || price == null) continue;
          const hit = a.direction === "above" ? price >= hl.high : price <= hl.low;
          if (!hit) continue;
          await fire(a, price, `previous-day ${a.direction === "above" ? "high" : "low"} ${a.direction === "above" ? hl.high : hl.low} — now ${price}`, barTimeRef.current.get(a.symbol) ?? null, barClosedSymbols.has(a.symbol));
        } else if (a.kind === "indicator") {
          // needs the open chart's real OHLC for the alert's symbol+tf —
          // multi-chart workspaces publish one snapshot per panel
          const panel = readTerminalSnapshot(a.symbol, a.timeframe);
          if (!panel || panel.replay) continue;
          const res = evaluateIndicatorAlert(a, panel.bars);
          if (!res?.hit) continue;
          const newest = panel.bars[panel.bars.length - 1]?.time ?? null;
          const closed = barClosedSymbols.has(a.symbol);
          if (a.frequency === "oncePerBarClose" && !closed) continue;
          await fire(a, res.price, res.detail, newest, closed);
        } else if (a.kind === "drawing") {
          const panel = readTerminalSnapshot(a.symbol);
          if (!panel || panel.replay) continue;
          if (alertDrawingMissing(a, drawings)) {
            // the drawing is gone — pause the alert + a SYSTEM notification
            await recordTrigger(a.id, 0, "drawing deleted — alert paused", { previous: a }).catch(() => {});
            await patchAlert(a.id, { paused: true });
            const settings = loadAlertSettings();
            if (settings.enabled && settings.systemNotifs !== false) {
              toast({ title: "Trading alert paused", description: `The drawing behind a ${a.symbol} alert was deleted.` });
              appendAlertLog({ id: `sys-${a.id}-${Date.now()}`, kind: "system", symbol: a.symbol, title: "Trading alert paused — drawing deleted" });
            }
            await pushSyncedNotif({
              id: `sys-${a.id}-${Date.now()}`,
              category: "system",
              title: "Trading alert paused — drawing deleted",
              body: `${a.symbol}: the drawing this alert watched was removed.`,
              url: `/terminal?symbol=${encodeURIComponent(a.symbol)}`,
              symbol: a.symbol,
            });
            continue;
          }
          const drawing = drawings.find((d) => d.id === a.drawing?.drawingId);
          const price = pricesRef.current.get(a.symbol) ?? panel.bars[panel.bars.length - 1]?.close ?? null;
          if (price == null) continue;
          const prev = prevPriceRef.current.get(a.symbol) ?? null;
          prevPriceRef.current.set(a.symbol, price);
          const res = evaluateDrawingAlert(a, drawing, price, prev, panel.bars[panel.bars.length - 1]?.time ?? Date.now() / 1000);
          if (!res?.hit) continue;
          const closed = barClosedSymbols.has(a.symbol);
          if (a.frequency === "oncePerBarClose" && !closed) continue;
          await fire(a, price, res.detail, barTimeRef.current.get(a.symbol) ?? null, closed);
        }
      }
    };

    const timer = setInterval(() => { void evaluate(); }, EVAL_MS);
    return () => clearInterval(timer);
  }, [toast]);

  return null;
}

/** Publish the open chart's snapshot for the engine (called by PriceChart). */
export function publishChartSnapshot(symbol: string, timeframe: Timeframe, bars: Bar[], drawings: Drawing[], replay: boolean): void {
  publishTerminalSnapshot({ symbol, timeframe, bars, drawings, replay, at: Date.now() });
}
