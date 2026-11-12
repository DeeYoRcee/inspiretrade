/**
 * VolumePanel — controls the chart's volume-analysis overlays: volume
 * profile (visible / fixed-today / session range) with POC/VAH/VAL, anchored
 * VWAP and volume delta. Volume semantics are stated honestly per feed:
 * crypto = real traded volume + real taker-buy delta (Binance); indices &
 * metals = futures contract volume; forex = aggregated TICK volume (no
 * central tape exists — delta is reported as unavailable, never estimated).
 */
import { useQuery } from "@tanstack/react-query";
import { Anchor, X } from "lucide-react";
import { INSTRUMENTS, type Timeframe } from "@shared/terminal";
import { loadBarsCached } from "@/lib/terminal/data-feeds";
import { buildVolumeProfile, volumeDelta, volumeSource } from "@/lib/terminal/volume-analysis";
import { SESSIONS } from "@/lib/terminal/sessions";
import { Stat, Sparkline } from "./ToolDrawer";
import type { OverlayConfig } from "@/lib/terminal/chart-overlay";
import { cn } from "@/lib/utils";

export function VolumePanel({ symbol, timeframe, overlay, setOverlay, anchor, setAnchor }: {
  symbol: string;
  timeframe: Timeframe;
  overlay: OverlayConfig;
  setOverlay: (o: OverlayConfig) => void;
  anchor: number | null;
  setAnchor: (t: number | null) => void;
}) {
  const inst = INSTRUMENTS.find((i) => i.symbol === symbol);
  const barsQ = useQuery({
    queryKey: ["volumeBars", symbol, timeframe],
    queryFn: () => loadBarsCached(symbol, timeframe, 1000),
    staleTime: 60_000,
  });
  const bars = barsQ.data ?? [];
  const src = volumeSource(inst?.assetClass ?? "forex");

  const vpOn = !!overlay.volumeProfile;
  const delta = volumeDelta(bars);
  const prof = vpOn ? buildVolumeProfile(bars, overlay.volumeProfile!.bins) : null;

  const setVp = (p: Partial<NonNullable<OverlayConfig["volumeProfile"]>>) =>
    setOverlay({ ...overlay, volumeProfile: { mode: "visible", sessionId: "london", bins: 24, levels: true, ...(overlay.volumeProfile ?? {}), ...p } });

  return (
    <div className="space-y-3 text-[11px]">
      <div className="rounded-xl border border-border/50 bg-card/40 p-2.5">
        <div className="flex items-center justify-between">
          <b>Volume profile</b>
          <button onClick={() => setOverlay({ ...overlay, volumeProfile: vpOn ? null : { mode: "visible", sessionId: "london", bins: 24, levels: true } })}
            className={cn("rounded-lg border px-2 py-1 text-[10px] font-bold", vpOn ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-400" : "border-border/60 text-muted-foreground hover:text-foreground")}>
            {vpOn ? "ON CHART" : "OFF"}
          </button>
        </div>
        {vpOn && (
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            <label className="space-y-0.5">
              <span className="text-[9px] uppercase text-muted-foreground">Range</span>
              <select value={overlay.volumeProfile!.mode} onChange={(e) => setVp({ mode: e.target.value as "visible" | "session" })} className="num-input h-7 w-full">
                <option value="visible">Visible chart</option>
                <option value="session">Today's session</option>
              </select>
            </label>
            <label className="space-y-0.5">
              <span className="text-[9px] uppercase text-muted-foreground">Session</span>
              <select value={overlay.volumeProfile!.sessionId} onChange={(e) => setVp({ sessionId: e.target.value })} disabled={overlay.volumeProfile!.mode !== "session"} className="num-input h-7 w-full disabled:opacity-40">
                {SESSIONS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
            <label className="space-y-0.5">
              <span className="text-[9px] uppercase text-muted-foreground">Bins</span>
              <input type="number" min="8" max="60" value={overlay.volumeProfile!.bins} onChange={(e) => setVp({ bins: Math.max(8, Math.min(60, Number(e.target.value) || 24)) })} className="num-input h-7 w-full" />
            </label>
            <label className="col-span-3 flex items-center gap-2">
              <input type="checkbox" checked={overlay.volumeProfile!.levels} onChange={(e) => setVp({ levels: e.target.checked })} className="accent-emerald-500" />
              <span className="text-muted-foreground">Show POC / VAH / VAL on chart</span>
            </label>
          </div>
        )}
        {prof && (
          <div className="mt-2 grid grid-cols-4 gap-1.5">
            <Stat label="POC" value={prof.poc.toFixed(prof.poc > 100 ? 1 : 4)} />
            <Stat label="VAH" value={prof.vah.toFixed(prof.vah > 100 ? 1 : 4)} />
            <Stat label="VAL" value={prof.val.toFixed(prof.val > 100 ? 1 : 4)} />
            <Stat label="Total vol" value={prof.total > 1e6 ? `${(prof.total / 1e6).toFixed(1)}M` : prof.total > 1e3 ? `${(prof.total / 1e3).toFixed(1)}K` : prof.total.toFixed(0)} />
          </div>
        )}
      </div>

      <div className="rounded-xl border border-border/50 bg-card/40 p-2.5">
        <div className="flex items-center justify-between">
          <b className="flex items-center gap-1"><Anchor className="h-3.5 w-3.5 text-amber-400" />Anchored VWAP</b>
          {anchor != null && (
            <button onClick={() => setAnchor(null)} className="flex items-center gap-1 text-muted-foreground hover:text-red-400"><X className="h-3 w-3" />clear</button>
          )}
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">
          {anchor != null
            ? `Anchored at ${new Date(anchor * 1000).toLocaleString()} — amber line on the chart.`
            : "No anchor set. Use the chart right-click menu → “Anchor VWAP here”, or anchor at the latest bar:"}
        </p>
        {anchor == null && bars.length > 0 && (
          <button onClick={() => setAnchor(bars[bars.length - 1].time)} className="mt-1.5 rounded-lg border border-amber-500/40 px-2 py-1 text-[10px] font-bold text-amber-400 hover:bg-amber-500/10">
            Anchor at latest bar ({new Date(bars[bars.length - 1].time * 1000).toLocaleString()})
          </button>
        )}
      </div>

      <div className="rounded-xl border border-border/50 bg-card/40 p-2.5">
        <b>Volume delta (buy vs sell)</b>
        <p className="mt-1 text-[10px] text-muted-foreground">
          Source: <b className={src === "traded" ? "text-emerald-400" : "text-amber-400"}>{src === "traded" ? "real traded volume" : "tick volume (no central tape)"}</b> for {symbol}.
        </p>
        {delta ? (
          <>
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              <Stat label="Buy vol (taker)" value={`${((delta.reduce((s, d) => s + Math.max(0, d.delta), 0) + delta.reduce((s, d) => s + Math.max(0, -d.delta), 0)) / 2 / 1e3).toFixed(1)}K`} />
              <Stat label="Net delta" value={`${delta[delta.length - 1].cum >= 0 ? "+" : ""}${(delta[delta.length - 1].cum / 1e3).toFixed(1)}K`} tone={delta[delta.length - 1].cum >= 0 ? "up" : "down"} />
              <Stat label="Bars" value={delta.length} />
            </div>
            <div className="mt-2">
              <div className="mb-0.5 text-[9px] uppercase text-muted-foreground">Cumulative delta</div>
              <Sparkline points={delta.map((d) => d.cum)} height={70} color={delta[delta.length - 1].cum >= 0 ? "#22c55e" : "#ef4444"} />
            </div>
          </>
        ) : (
          <p className="mt-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-amber-300">
            Delta is not available for this feed — real bid/ask or taker data does not exist here, so no delta is estimated.
          </p>
        )}
      </div>

      <p className="text-[9px] leading-relaxed text-muted-foreground">
        Crypto (Binance): traded volume + taker-buy volume from the real kline stream. Indices/metals (Yahoo): front futures contract volume.
        Forex (Yahoo): aggregated tick volume — commonly used for structure analysis, but it is NOT central-exchange traded volume.
      </p>
    </div>
  );
}
