/**
 * Dev-only replay harness (never shipped): mounts the REAL useReplay hook +
 * PriceChart replay props and drives a full replay session on public Binance
 * data — Start → ready → play → step. Used to verify the replay pipeline
 * end-to-end in a real browser without the auth gate.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PriceChart } from "@/components/terminal/PriceChart";
import { ReplayControls, ReplayBadge } from "@/components/terminal/ReplayWorkspace";
import { useReplay } from "@/hooks/use-replay";
import type { Timeframe } from "@shared/terminal";
import "./index.css";

function ReplayHarness() {
  const r = useReplay();
  const [symbol, setSymbol] = useState("BTCUSD");
  const [tf, setTf] = useState<Timeframe>("5m");
  const [select, setSelect] = useState(false);
  const [log, setLog] = useState<string[]>(["boot"]);

  const push = (m: string) => setLog((p) => [...p.slice(-8), m]);

  const start = async () => {
    const d = new Date(Date.now() - 14 * 86400000);
    d.setUTCHours(0, 0, 0, 0);
    push(`start ${symbol} ${tf} ${d.toISOString()}`);
    await r.loadSession(symbol, tf, d.toISOString().slice(0, 16), 100000);
    push(`phase=${r.phase} bars=${r.bars.length} err=${r.error ?? "none"}`);
  };

  return (
    <div className="h-[100dvh] w-full flex flex-col gap-2 p-2">
      <div className="flex items-center gap-2 text-xs">
        <button id="btn-start" onClick={() => void start()} className="rounded bg-sky-600 px-3 py-1 text-white">Start</button>
        <button id="btn-select" onClick={() => { setSelect((v) => !v); push(`select=${!select}`); }} className="rounded bg-amber-600 px-3 py-1 text-white">Select</button>
        <button id="btn-play" onClick={() => { r.play(); push(`play phase=${r.phase}`); }} className="rounded bg-emerald-600 px-3 py-1 text-white">Play</button>
        <button id="btn-pause" onClick={() => { r.pause(); push("pause"); }} className="rounded bg-slate-700 px-3 py-1 text-white">Pause</button>
        <button id="btn-step" onClick={() => { r.stepForward(); push(`step cursor=${r.cursor}`); }} className="rounded bg-slate-700 px-3 py-1 text-white">Step</button>
        <button onClick={() => setSymbol(symbol === "BTCUSD" ? "ETHUSD" : "BTCUSD")} className="rounded bg-slate-700 px-3 py-1 text-white">sym:{symbol}</button>
        <span data-testid="phase">{r.phase}</span>
        <span data-testid="bars">{r.bars.length}</span>
        <span data-testid="cursor">{r.cursor}</span>
        <span data-testid="playing">{String(r.playing)}</span>
        <span data-testid="error">{r.error ?? "—"}</span>
        <span data-testid="progress">{r.progressText ?? "—"}</span>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded border border-slate-800 bg-[#0b1220]">
        <PriceChart
          symbol={symbol}
          timeframe={tf}
          marks={[]}
          accountId={null}
          positions={[]}
          onModifyPosition={async () => undefined}
          onSymbolChange={() => {}}
          onTimeframeChange={(t) => setTf(t)}
          replayBars={r.phase === "ready" ? r.bars : null}
          replayCursor={r.phase === "ready" ? r.cursor : null}
          replayForming={r.phase === "ready" ? r.forming?.bar ?? null : null}
          replayStatus={r.phase === "ready" ? `REPLAY · ${r.playing ? "playing" : "paused"}` : null}
          replaySelect={select}
          onReplaySelect={async (t) => {
            push(`clicked=${t}`);
            setSelect(false);
            const res = await r.startFromCandle(symbol, tf, t, 100000);
            push(`from-candle ok=${res.ok} err=${res.error ?? "none"} phase=${r.phase} bars=${r.bars.length}`);
          }}
          onReplaySelectCancel={() => { setSelect(false); push("select-cancel"); }}
        />
        {r.phase === "ready" && <ReplayBadge />}
      </div>
      {r.phase === "ready" && <ReplayControls r={r} />}
      <div id="log" className="text-[10px] text-slate-500">{log.join(" | ")}</div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<ReplayHarness />);
