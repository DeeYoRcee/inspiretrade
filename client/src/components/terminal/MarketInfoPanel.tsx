import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, RotateCcw, Settings2 } from "lucide-react";
import { getInstrument, TF_SECONDS, type Timeframe, type Bar } from "@shared/terminal";
import { bucketStart } from "@shared/feed-validation";
import { SPREAD_PIPS } from "@shared/trading-engine";
import { useServerQuote, type ServerQuote } from "@/hooks/use-server-quote";
import { useQuotes } from "@/lib/quotes-context";
import { usePrice } from "@/lib/price-store";
import { marketStatus } from "@/lib/market-status";
import { loadFeed } from "@/lib/market-data";
import { sessionsFor, nextSessionStart, fmtDuration, type SessionId } from "@/lib/market-sessions";
import { cn } from "@/lib/utils";

/**
 * MarketInfoPanel — P56: the professional market information rail panel.
 *
 * Every number is real provider/engine data or an honest "—":
 *  - Bid/Ask/spread: the ENGINE's quote (useServerQuote — the same service
 *    that fills orders, 3s poll, source+live labels; stale marked stale).
 *  - Daily O/H/L/prev-close/change: the shared quotes snapshot (provider
 *    daily bars — the watchlist's own source, no duplicate subscriptions).
 *  - Sessions: DST-correct windows (Intl tz database, market-sessions.ts);
 *    session O/H/L from the instrument's real 1h bars (loadFeed one-shot).
 *  - Countdown: shared TF_SECONDS/bucketStart boundaries — the exact rule
 *    the chart candle grid uses; suppressed while the market is closed.
 *  - Volume: provider bars only, labeled per basis (exchange vs tick);
 *    unavailable → "—", never fabricated.
 */

const LS_PREFS = "it_market_panel_prefs";

type SectionId = "quote" | "daily" | "sessions" | "countdown" | "volume" | "info";

const DEFAULT_PREFS: Record<SectionId, boolean> = {
  quote: true, daily: true, sessions: true, countdown: true, volume: true, info: true,
};

function loadPrefs(): Record<SectionId, boolean> {
  try {
    const raw = localStorage.getItem(LS_PREFS);
    if (raw) return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Record<SectionId, boolean>>) };
  } catch { /* private mode */ }
  return { ...DEFAULT_PREFS };
}

function savePrefs(p: Record<SectionId, boolean>): void {
  try { localStorage.setItem(LS_PREFS, JSON.stringify(p)); } catch { /* private mode */ }
}

function Section({ id, title, prefs, onToggle, children, badge }: {
  id: SectionId;
  title: string;
  prefs: Record<SectionId, boolean>;
  onToggle: (id: SectionId) => void;
  children: React.ReactNode;
  badge?: string;
}) {
  const [open, setOpen] = useState(true);
  if (!prefs[id]) return null;
  return (
    <div className="rounded-lg border border-slate-800/70">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-1.5 px-2 py-1.5" aria-expanded={open}>
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{title}</span>
        {badge && <span className="rounded bg-slate-800 px-1 py-0.5 text-[9px] font-semibold text-slate-400">{badge}</span>}
        <span className="ms-auto flex items-center gap-1">
          <span
            role="button"
            tabIndex={0}
            aria-label={`Toggle ${title} section`}
            onClick={(e) => { e.stopPropagation(); onToggle(id); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onToggle(id); } }}
            className={cn("rounded p-0.5 text-slate-600 transition-colors hover:text-sky-300", prefs[id] ? "opacity-100" : "opacity-40")}
          >
            <Settings2 className="h-3 w-3" />
          </span>
          {open ? <ChevronUp className="h-3 w-3 text-slate-500" /> : <ChevronDown className="h-3 w-3 text-slate-500" />}
        </span>
      </button>
      {open && <div className="border-t border-slate-800/60 p-2">{children}</div>}
    </div>
  );
}

function Row({ k, v, mono = true, tone }: { k: string; v: string; mono?: boolean; tone?: "up" | "down" }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-[3px]">
      <span className="text-[10px] text-slate-500">{k}</span>
      <span className={cn("text-[11px] font-medium", mono && "font-number", tone === "up" && "text-emerald-400", tone === "down" && "text-red-400", !tone && "text-slate-200")}>{v}</span>
    </div>
  );
}

/** 1h history (one-shot per symbol) — session O/H/L + volume basis */
function useHourBars(symbol: string): { bars: Bar[]; ready: boolean } {
  const [bars, setBars] = useState<Bar[]>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    setBars([]);
    setReady(false);
    void loadFeed(symbol, "1h")
      .then((r) => { if (alive) { setBars(r.bars ?? []); setReady(true); } })
      .catch(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, [symbol]);
  return { bars, ready };
}

/** candle-close countdown from the chart's own boundary rule (§5) */
function useCountdown(symbol: string, tf: Timeframe, closed: boolean): string {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  return useMemo(() => {
    if (closed) return "—";
    const sec = TF_SECONDS[tf];
    if (!sec) return "—";
    const now = Date.now();
    const bucketMs = sec * 1000;
    const start = (bucketStart(Math.floor(now / 1000), sec) ?? Math.floor(now / sec)) * 1000;
    const end = start + bucketMs;
    const left = Math.max(0, Math.floor((end - now) / 1000));
    const h = Math.floor(left / 3600);
    const m = Math.floor((left % 3600) / 60);
    const s = left % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }, [symbol, tf, closed, Math.floor(Date.now() / 1000)]); // eslint-disable-line react-hooks/exhaustive-deps
}

function sessionOhlc(bars: Bar[], startUtc: number, endUtc: number): { o: number; h: number; l: number } | null {
  const inWindow = bars.filter((b) => b.time >= startUtc / 1000 && b.time < endUtc / 1000);
  if (!inWindow.length) return null;
  return {
    o: inWindow[0].open,
    h: Math.max(...inWindow.map((b) => b.high)),
    l: Math.min(...inWindow.map((b) => b.low)),
  };
}

const SESSION_ORDER: SessionId[] = ["tokyo", "london", "newyork"];

export function MarketInfoPanel({ symbol, timeframe }: { symbol: string; timeframe?: Timeframe }) {
  const inst = getInstrument(symbol);
  const quote = useServerQuote(symbol);
  const midBus = usePrice(symbol);
  const { rows, updatedAt: snapAt } = useQuotes();
  const row = rows[symbol] || null;
  const { bars, ready } = useHourBars(symbol);
  const [prefs, setPrefs] = useState(loadPrefs);
  const prevBidRef = useRef<number | null>(null);
  const [dir, setDir] = useState<"up" | "down" | null>(null);

  const toggle = (id: SectionId) => setPrefs((p) => { const n = { ...p, [id]: !p[id] }; savePrefs(n); return n; });
  const resetPrefs = () => { setPrefs({ ...DEFAULT_PREFS }); savePrefs({ ...DEFAULT_PREFS }); };

  const closed = marketStatus(symbol) !== "open";
  const d = inst?.digits ?? 2;
  const pip = inst?.pipSize ?? 0.0001;

  // movement indicator from the last real bid (§1 price movement)
  useEffect(() => {
    if (quote?.bid == null) return;
    if (prevBidRef.current != null && quote.bid !== prevBidRef.current) {
      setDir(quote.bid > prevBidRef.current ? "up" : "down");
    }
    prevBidRef.current = quote.bid;
  }, [quote?.bid]);

  // freshness: the engine quote's own stamp (§9 — stale data is never "live")
  const quoteAge = quote?.time ? Math.max(0, Math.round((Date.now() - quote.time) / 1000)) : null;
  const stale = quoteAge != null && quoteAge > 90;
  const spread = quote ? Math.abs(quote.ask - quote.bid) : null;
  const spreadPips = spread != null && pip > 0 ? spread / pip : null;
  const countdown = useCountdown(symbol, timeframe ?? "5m", closed);
  const sessions = useMemo(() => sessionsFor(Date.now()), [Math.floor(Date.now() / 60000)]); // eslint-disable-line react-hooks/exhaustive-deps
  const nextSess = useMemo(() => nextSessionStart(Date.now()), [Math.floor(Date.now() / 60000)]); // eslint-disable-line react-hooks/exhaustive-deps
  const [, tick1s] = useState(0);
  useEffect(() => { const t = setInterval(() => tick1s((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  // volume — provider bars only, labeled per basis (§8)
  const dayStartUtcSec = Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000);
  const todayBars = bars.filter((b) => b.time >= dayStartUtcSec);
  const dayVolume = todayBars.reduce((s: number, b: Bar) => s + (b.volume || 0), 0);
  const lastVol = todayBars.at(-1)?.volume;
  const prevVols = todayBars.slice(-13, -1).map((b) => b.volume ?? 0).filter((v) => v > 0);
  const volAvg = prevVols.length ? prevVols.reduce((a: number, b: number) => a + b, 0) / prevVols.length : null;
  const volumeLabel = inst?.feed === "binance" ? "Exchange volume (Binance)" : "Provider volume (bar basis)";

  if (!inst) return <p className="p-3 text-[11px] text-slate-500">Unknown instrument</p>;

  const connTone = quote == null ? "connecting" : stale ? "stale" : quote.live ? "live" : "delayed";

  return (
    <div className="space-y-1.5 p-2 text-[11px]">
      {/* header: symbol + connection status (§9) */}
      <div className="flex items-center gap-2">
        <p className="text-sm font-bold text-slate-100">{symbol}</p>
        <span className={cn(
          "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase",
          connTone === "live" && "bg-emerald-500/15 text-emerald-400",
          connTone === "delayed" && "bg-amber-500/15 text-amber-400",
          connTone === "stale" && "bg-red-500/15 text-red-400",
          connTone === "connecting" && "bg-slate-800 text-slate-400",
        )}>
          <span className={cn("h-1.5 w-1.5 rounded-full",
            connTone === "live" && "animate-pulse bg-emerald-400",
            connTone === "delayed" && "bg-amber-400",
            connTone === "stale" && "bg-red-400",
            connTone === "connecting" && "animate-pulse bg-slate-500")} />
          {connTone === "connecting" ? "connecting" : connTone === "stale" ? "stale data" : connTone}
        </span>
        <span className="ms-auto text-[9px] text-slate-600">{quote?.source ?? row?.source ?? ""}</span>
        <button onClick={resetPrefs} title="Restore default panel sections" className="rounded p-1 text-slate-600 hover:text-slate-300">
          <RotateCcw className="h-3 w-3" />
        </button>
      </div>

      {/* §1 bid/ask/last + §2 spread */}
      <Section id="quote" title="Quote" prefs={prefs} onToggle={toggle}>
        <div className="grid grid-cols-3 gap-1 text-center">
          <div className="rounded-md bg-slate-900/60 p-1.5">
            <p className="text-[9px] uppercase text-slate-500">Bid</p>
            <p className={cn("font-number text-xs font-semibold", dir === "down" ? "text-red-400" : "text-slate-200")}>
              {quote ? quote.bid.toFixed(d) : midBus != null ? "—" : "—"}
            </p>
          </div>
          <div className="rounded-md bg-slate-900/60 p-1.5">
            <p className="text-[9px] uppercase text-slate-500">Last</p>
            <p className="font-number text-xs font-semibold text-slate-100">{row?.price != null ? row.price.toFixed(d) : midBus != null ? midBus.toFixed(d) : "—"}</p>
          </div>
          <div className="rounded-md bg-slate-900/60 p-1.5">
            <p className="text-[9px] uppercase text-slate-500">Ask</p>
            <p className={cn("font-number text-xs font-semibold", dir === "up" ? "text-emerald-400" : "text-slate-200")}>
              {quote ? quote.ask.toFixed(d) : "—"}
            </p>
          </div>
        </div>
        <div className="mt-1 flex items-baseline justify-between">
          <span className="text-[10px] text-slate-500">Spread</span>
          <span className="font-number text-[11px] font-semibold text-slate-200">
            {spread != null ? `${spread.toFixed(d)}${spreadPips != null ? ` · ${spreadPips.toFixed(1)} pips` : ""}` : "—"}
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] text-slate-500">Updated</span>
          <span className={cn("text-[10px]", stale ? "text-red-400" : "text-slate-400")}>
            {quoteAge == null ? "waiting…" : quoteAge < 5 ? "just now" : `${quoteAge}s ago${stale ? " · stale" : ""}`}
          </span>
        </div>
        <p className="mt-1 text-[9px] leading-snug text-slate-600">
          {quote ? `Engine quote — what a market order gets${quote.live ? " (live)" : " (provider delayed)"}` : "Engine quote unavailable — no estimated prices shown."}
        </p>
      </Section>

      {/* §3 daily statistics */}
      <Section id="daily" title="Daily statistics" prefs={prefs} onToggle={toggle} badge="daily bars">
        <Row k="Daily open" v={row?.open != null ? row.open.toFixed(d) : "—"} />
        <Row k="Day high" v={row?.high != null ? row.high.toFixed(d) : "—"} />
        <Row k="Day low" v={row?.low != null ? row.low.toFixed(d) : "—"} />
        <Row k="Prev close" v={row?.prevClose != null ? row.prevClose.toFixed(d) : "—"} />
        <Row
          k="Day change"
          v={row?.changeAbs != null ? `${row.changeAbs >= 0 ? "+" : "−"}${Math.abs(row.changeAbs).toFixed(d)}${row.changePct != null ? ` (${row.changePct >= 0 ? "+" : "−"}${Math.abs(row.changePct).toFixed(2)}%)` : ""}` : "—"}
          tone={row?.changeAbs != null ? (row.changeAbs >= 0 ? "up" : "down") : undefined}
        />
        <Row k="Current" v={row?.price != null ? row.price.toFixed(d) : "—"} />
        <p className="mt-1 text-[9px] text-slate-600">Provider daily bars · snapshot {snapAt ? `${Math.max(0, Math.round((Date.now() - snapAt) / 1000))}s ago` : "—"}</p>
      </Section>

      {/* §4/§6 sessions */}
      <Section id="sessions" title="Sessions" prefs={prefs} onToggle={toggle} badge="DST-aware">
        <div className="mb-1.5 grid grid-cols-3 gap-1">
          {SESSION_ORDER.map((id) => {
            const sess = sessions.find((x) => x.id === id)!;
            return (
              <div key={id} className={cn("rounded-md border p-1 text-center", sess.open ? "border-emerald-600/50 bg-emerald-500/10" : "border-slate-800 bg-slate-900/40")}>
                <p className={cn("text-[9px] font-bold", sess.open ? "text-emerald-400" : "text-slate-500")}>{sess.label}</p>
                <p className="text-[8px] text-slate-600">{sess.open ? "OPEN" : "closed"}</p>
              </div>
            );
          })}
        </div>
        {sessions.map((sess) => {
          const ohlc = ready ? sessionOhlc(bars, sess.startUtc, sess.endUtc) : null;
          return (
            <div key={sess.id} className="border-b border-slate-800/50 py-1 last:border-b-0">
              <div className="flex items-baseline justify-between">
                <span className={cn("text-[10px] font-semibold", sess.open ? "text-emerald-400" : "text-slate-400")}>{sess.label}</span>
                <span className="font-number text-[10px] text-slate-400">{ohlc ? `${ohlc.l.toFixed(d)} – ${ohlc.h.toFixed(d)}` : "—"}</span>
              </div>
              <p className="text-[8px] text-slate-600">
                {new Date(sess.startUtc).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}–{new Date(sess.endUtc).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · range {ohlc ? (ohlc.h - ohlc.l).toFixed(d) : "—"}
              </p>
            </div>
          );
        })}
        <p className="mt-1 text-[9px] text-slate-600">
          {nextSess ? `${nextSess.label} opens in ${fmtDuration(nextSess.at - Date.now())}` : "No session open today"}
        </p>
      </Section>

      {/* §5 candle countdown */}
      <Section id="countdown" title="Candle close" prefs={prefs} onToggle={toggle} badge={(timeframe ?? "5m").toUpperCase()}>
        <div className="text-center">
          <p className="font-number text-lg font-bold text-sky-300">{countdown}</p>
          <p className="text-[9px] text-slate-600">{closed ? "market closed — no candle will close" : `until the ${timeframe ?? "5m"} candle closes`}</p>
        </div>
      </Section>

      {/* §8 volume / activity */}
      <Section id="volume" title="Volume" prefs={prefs} onToggle={toggle}>
        {ready && dayVolume > 0 ? (
          <>
            <Row k="Today" v={dayVolume >= 1e6 ? `${(dayVolume / 1e6).toFixed(2)}M` : dayVolume >= 1e3 ? `${(dayVolume / 1e3).toFixed(1)}K` : dayVolume.toFixed(0)} />
            <Row
              k="Last bar vs avg"
              v={lastVol != null && volAvg ? `${(lastVol / volAvg).toFixed(2)}×` : "—"}
              tone={lastVol != null && volAvg ? (lastVol > volAvg ? "up" : "down") : undefined}
            />
            <p className="mt-1 text-[9px] text-slate-600">{volumeLabel}</p>
          </>
        ) : (
          <>
            <Row k="Today" v="—" />
            <p className="mt-1 text-[9px] text-slate-600">No reliable volume for this instrument — not fabricated.</p>
          </>
        )}
      </Section>

      {/* §7 instrument info */}
      <Section id="info" title="Instrument" prefs={prefs} onToggle={toggle}>
        <Row k="Name" v={inst.name} mono={false} />
        <Row k="Asset class" v={inst.assetClass === "metal" ? "Metal" : inst.assetClass} mono={false} />
        {inst.underlier && <Row k="Market" v={inst.underlier} mono={false} />}
        {inst.quote && <Row k="Quote currency" v={inst.quote} mono={false} />}
        <Row k="Precision" v={`${d} decimals`} />
        {inst.pipSize != null && <Row k="Pip size" v={String(inst.pipSize)} />}
        {inst.tickSize != null && <Row k="Min increment" v={String(inst.tickSize)} />}
        {inst.contractSize != null && <Row k="Contract size" v={inst.contractSize.toLocaleString()} />}
        <Row k="Session" v={inst.assetClass === "crypto" ? "24/7" : inst.session || "Sun 22:00 – Fri 21:00 UTC"} mono={false} />
        <Row k="Trading status" v={closed ? "Closed" : "Open"} mono={false} tone={closed ? undefined : "up"} />
        <Row k="Data source" v={quote?.source ?? row?.source ?? (inst.feedLabel || inst.feed)} mono={false} />
      </Section>
    </div>
  );
}
