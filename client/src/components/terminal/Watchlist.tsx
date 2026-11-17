/**
 * Watchlist — the left panel of the professional terminal layout.
 *
 * Every catalog instrument grouped by asset class with REAL live prices:
 * crypto from Binance 24h tickers, metals/forex/indices from the server
 * quotes proxy (daily close vs previous close → real day change). Click a
 * row to load that instrument in the chart + ticket. Rows subscribe to the
 * shared price store, so the open chart's live ticks also update its row
 * without re-rendering the whole list.
 */
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { INSTRUMENTS, getInstrument } from "@shared/terminal";
import { SPREAD_PIPS } from "@shared/trading-engine";
import { fetchWatchlistQuotes, type WatchlistQuote } from "@/lib/market-data";
import { usePrice, priceBusUpdateMany } from "@/lib/price-store";
import { cn } from "@/lib/utils";

const ASSET_CLASSES: { id: string; label: string }[] = [
  { id: "crypto", label: "Crypto" },
  { id: "metal", label: "Metals" },
  { id: "forex", label: "Forex" },
  { id: "index", label: "Indices" },
];

function WatchRow({
  symbol, active, snap, onSelect,
}: {
  symbol: string;
  active: boolean;
  snap: WatchlistQuote | undefined;
  onSelect: (s: string) => void;
}) {
  const inst = getInstrument(symbol);
  const live = usePrice(symbol);
  const price = live ?? snap?.price ?? null;
  const changePct = live != null && snap ? snap.changePct : snap?.changePct ?? null;
  const d = inst?.digits ?? 2;
  return (
    <button
      onClick={() => onSelect(symbol)}
      className={cn(
        "flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left transition-colors",
        active ? "bg-sky-500/15" : "hover:bg-slate-800/70",
      )}
    >
      <span className="min-w-0">
        <span className={cn("block truncate text-[11px] font-bold", active ? "text-sky-300" : "text-slate-200")}>{symbol}</span>
        <span className="block truncate text-[9px] text-slate-500">{inst?.name}</span>
      </span>
      <span className="text-right">
        <span className="block font-number text-[11px] font-semibold tabular-nums text-slate-100">
          {price != null ? price.toFixed(d) : "—"}
        </span>
        <span
          className={cn(
            "block font-number text-[9px] tabular-nums",
            changePct == null ? "text-slate-500" : changePct >= 0 ? "text-emerald-400" : "text-red-400",
          )}
        >
          {changePct != null ? `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%` : "—"}
        </span>
      </span>
    </button>
  );
}

export function Watchlist({
  symbol, onSymbolChange, className,
}: {
  symbol: string;
  onSymbolChange: (s: string) => void;
  className?: string;
}) {
  const [q, setQ] = useState("");
  const [snap, setSnap] = useState<Record<string, WatchlistQuote>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // one snapshot refresh cycle for the whole list (real quotes only)
  useEffect(() => {
    let disposed = false;
    const tick = () => {
      fetchWatchlistQuotes()
        .then((s) => {
          if (!disposed && Object.keys(s).length) {
            setSnap(s);
            // feed the shared price store so ticket/blotter see every symbol too
            const mids: Record<string, number> = {};
            for (const [sym, v] of Object.entries(s)) mids[sym] = v.price;
            priceBusUpdateMany(mids);
          }
        })
        .catch(() => { /* transient — next cycle retries */ });
    };
    tick();
    const t = setInterval(tick, 45_000);
    return () => { disposed = true; clearInterval(t); };
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return INSTRUMENTS;
    return INSTRUMENTS.filter((i) => `${i.symbol} ${i.name}`.toLowerCase().includes(needle));
  }, [q]);

  return (
    <div className={cn("flex h-full min-h-0 flex-col border-slate-800 bg-[#0b1220]", className)}>
      <div className="flex items-center gap-1.5 border-b border-slate-800 px-2 py-1.5">
        <Search className="h-3 w-3 shrink-0 text-slate-500" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search…"
          className="h-6 w-full bg-transparent text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {ASSET_CLASSES.map((c) => {
          const rows = filtered.filter((i) => i.assetClass === c.id);
          if (!rows.length) return null;
          const isCollapsed = collapsed[c.id];
          return (
            <div key={c.id}>
              <button
                onClick={() => setCollapsed((m) => ({ ...m, [c.id]: !m[c.id] }))}
                className="flex w-full items-center gap-1 border-b border-slate-800/60 px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-slate-500 hover:bg-slate-900/60"
              >
                {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                {c.label}
                <span className="ml-auto font-normal">{rows.length}</span>
              </button>
              {!isCollapsed && rows.map((i) => (
                <WatchRow key={i.symbol} symbol={i.symbol} active={i.symbol === symbol} snap={snap[i.symbol]} onSelect={onSymbolChange} />
              ))}
            </div>
          );
        })}
        {!filtered.length && <p className="py-6 text-center text-[11px] text-slate-500">No match</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MarketInfoPanel — instrument details rail panel (real catalog + live quote)
// ---------------------------------------------------------------------------

export function MarketInfoPanel({ symbol }: { symbol: string }) {
  const inst = getInstrument(symbol);
  const mid = usePrice(symbol);
  if (!inst) return <p className="p-3 text-[11px] text-slate-500">Unknown instrument</p>;
  const spread = (SPREAD_PIPS[symbol] ?? 2) * inst.pipSize;
  const bid = mid != null ? mid - spread / 2 : null;
  const ask = mid != null ? mid + spread / 2 : null;
  const rows: [string, string][] = [
    ["Name", inst.name],
    ["Asset class", inst.assetClass],
    ["Price precision", `${inst.digits} digits`],
    ["Pip size", String(inst.pipSize)],
    ["Contract size", String(inst.contractSize)],
    ["Quote currency", inst.quote],
    ["Data feed", inst.feed === "binance" ? "Binance · real-time stream" : "Quotes proxy · delayed"],
    ["Spread (engine)", `${SPREAD_PIPS[symbol] ?? 2} pips`],
  ];
  return (
    <div className="p-2 text-[11px]">
      <p className="mb-1 text-sm font-bold text-slate-100">{symbol}</p>
      <div className="mb-2 grid grid-cols-3 gap-1 rounded-lg border border-slate-800 p-1.5 text-center">
        <div><p className="text-[9px] uppercase text-slate-500">Bid</p><p className="font-number font-semibold text-red-400">{bid != null ? bid.toFixed(inst.digits) : "—"}</p></div>
        <div><p className="text-[9px] uppercase text-slate-500">Mid</p><p className="font-number font-semibold text-slate-100">{mid != null ? mid.toFixed(inst.digits) : "—"}</p></div>
        <div><p className="text-[9px] uppercase text-slate-500">Ask</p><p className="font-number font-semibold text-emerald-400">{ask != null ? ask.toFixed(inst.digits) : "—"}</p></div>
      </div>
      <dl className="space-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2 border-b border-slate-800/60 py-1">
            <dt className="text-slate-500">{k}</dt>
            <dd className="text-right font-medium text-slate-200">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
