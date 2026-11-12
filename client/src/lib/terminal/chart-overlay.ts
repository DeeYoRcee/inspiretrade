/**
 * ChartOverlay — canvas renderer for analysis visuals drawn OVER the price
 * chart: session boxes (Sydney/Tokyo/London/NY), previous day/week high/low
 * lines and volume profiles with POC/VAH/VAL. All geometry is resolved
 * through the live lightweight-charts time/price scales, so the overlay
 * tracks pan/zoom perfectly.
 */
import type { IChartApi, ISeriesApi } from "lightweight-charts";
import type { Bar } from "@shared/terminal";
import { getSession, sessionBoundsUTC, prevDayHighLow, prevWeekHighLow, isInSession, SESSIONS } from "./sessions";
import { buildVolumeProfile, type VolumeProfileResult } from "./volume-analysis";

export interface OverlayConfig {
  sessions: string[];
  prevLevels: { day: boolean; week: boolean };
  volumeProfile: { mode: "visible" | "session"; sessionId: string; bins: number; levels: boolean } | null;
}

export const DEFAULT_OVERLAY: OverlayConfig = { sessions: [], prevLevels: { day: false, week: false }, volumeProfile: null };

export const SESSION_COLORS: Record<string, string> = {
  sydney: "34,211,238", tokyo: "244,63,94", london: "59,130,246", newyork: "251,146,60",
};

export class ChartOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private getChart: () => IChartApi | null;
  private getSeries: () => ISeriesApi<"Candlestick"> | null;
  private getBars: () => Bar[];       // full series (session windows, prev levels)
  private getDisplay: () => Bar[];    // visible/displayed slice (profiles, replay-aware)
  cfg: OverlayConfig = DEFAULT_OVERLAY;
  private ro: ResizeObserver;

  constructor(
    canvas: HTMLCanvasElement,
    getChart: () => IChartApi | null,
    getSeries: () => ISeriesApi<"Candlestick"> | null,
    getBars: () => Bar[],
    getDisplay: () => Bar[],
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.getChart = getChart;
    this.getSeries = getSeries;
    this.getBars = getBars;
    this.getDisplay = getDisplay;
    this.ro = new ResizeObserver(() => this.syncSize());
    if (canvas.parentElement) this.ro.observe(canvas.parentElement);
    this.syncSize();
  }

  syncSize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, parent.clientWidth * dpr);
    this.canvas.height = Math.max(1, parent.clientHeight * dpr);
    this.canvas.style.width = `${parent.clientWidth}px`;
    this.canvas.style.height = `${parent.clientHeight}px`;
    this.render();
  }

  private xFor(t: number): number | null {
    const chart = this.getChart();
    if (!chart) return null;
    const x = chart.timeScale().timeToCoordinate(t as any);
    return x == null ? null : x;
  }

  private yFor(price: number): number | null {
    const s = this.getSeries();
    if (!s) return null;
    try {
      const y = s.priceToCoordinate(price);
      return y == null ? null : y;
    } catch { return null; }
  }

  render() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const chart = this.getChart();
    if (!chart) return;
    const bars = this.getBars();
    if (!bars.length) return;

    // ---- session boxes ------------------------------------------------------
    for (const id of this.cfg.sessions) {
      const s = getSession(id);
      if (!s) continue;
      const daySec = 86400;
      const firstDay = Math.floor(bars[0].time / daySec) * daySec;
      const lastDay = Math.floor(bars[bars.length - 1].time / daySec) * daySec + daySec;
      for (let day = firstDay; day <= lastDay; day += daySec) {
        const b = sessionBoundsUTC(s, day + 43200);
        if (!b) continue;
        const x1 = this.xFor(b.openUTC);
        const x2 = this.xFor(b.closeUTC);
        if (x1 == null || x2 == null || x2 <= x1) continue;
        const color = SESSION_COLORS[id] ?? "148,163,184";
        ctx.fillStyle = `rgba(${color},0.05)`;
        ctx.fillRect(x1, 0, x2 - x1, h);
        ctx.fillStyle = `rgba(${color},0.5)`;
        ctx.fillRect(x1, 0, 1, h);
        ctx.fillRect(x2 - 1, 0, 1, h);
        if (x2 - x1 > 46) {
          ctx.font = "10px system-ui, sans-serif";
          ctx.fillStyle = `rgba(${color},0.9)`;
          ctx.fillText(s.label, x1 + 4, 12);
        }
      }
    }

    // ---- previous day / week high-low ---------------------------------------
    const level = (price: number, color: string, label: string) => {
      const y = this.yFor(price);
      if (y == null || y < 0 || y > h) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = "9px system-ui, sans-serif";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = color;
      ctx.fillText(label, w - tw - 6, y - 3);
      ctx.restore();
    };
    if (this.cfg.prevLevels.day) {
      const dhl = prevDayHighLow(bars);
      if (dhl) { level(dhl.high, "rgba(148,163,184,0.8)", "PDH"); level(dhl.low, "rgba(148,163,184,0.8)", "PDL"); }
    }
    if (this.cfg.prevLevels.week) {
      const whl = prevWeekHighLow(bars);
      if (whl) { level(whl.high, "rgba(250,204,21,0.75)", "PWH"); level(whl.low, "rgba(250,204,21,0.75)", "PWL"); }
    }

    // ---- volume profile -----------------------------------------------------
    const vp = this.cfg.volumeProfile;
    if (vp) {
      let slice: Bar[] = this.getDisplay();
      if (vp.mode === "session") {
        const s = getSession(vp.sessionId) ?? SESSIONS[0];
        const b = sessionBoundsUTC(s, Date.now() / 1000);
        slice = b ? bars.filter((x) => x.time >= b.openUTC && x.time < b.closeUTC) : [];
      }
      const prof: VolumeProfileResult | null = buildVolumeProfile(slice, vp.bins);
      if (prof && prof.total > 0) {
        const areaW = Math.min(160, w * 0.24);
        const maxRow = Math.max(...prof.rows.map((r) => r.volume), 1);
        const step = (prof.hi - prof.lo) / prof.rows.length;
        for (const r of prof.rows) {
          const yTop = this.yFor(r.price + step / 2);
          const yBot = this.yFor(r.price - step / 2);
          if (yTop == null || yBot == null) continue;
          const bw = (r.volume / maxRow) * areaW;
          ctx.fillStyle = "rgba(96,165,250,0.35)";
          ctx.fillRect(w - areaW + (areaW - bw), yTop, bw, Math.max(1, yBot - yTop - 1));
        }
        if (vp.levels) {
          const marker = (price: number, color: string, label: string) => {
            const y = this.yFor(price);
            if (y == null) return;
            ctx.save();
            ctx.strokeStyle = color; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(w - areaW - 30, y); ctx.lineTo(w, y); ctx.stroke();
            ctx.setLineDash([]);
            ctx.font = "9px system-ui, sans-serif";
            ctx.fillStyle = color;
            ctx.fillText(label, w - areaW - 28, y - 2);
            ctx.restore();
          };
          marker(prof.poc, "rgba(250,204,21,0.95)", "POC");
          marker(prof.vah, "rgba(148,163,184,0.9)", "VAH");
          marker(prof.val, "rgba(148,163,184,0.9)", "VAL");
        }
      }
    }
  }

  destroy() {
    this.ro.disconnect();
  }
}

/** Whether the current instant is inside a session (for the sessions panel). */
export function sessionActiveNow(id: string): boolean {
  const s = getSession(id);
  return !!s && isInSession(s, Date.now() / 1000);
}
