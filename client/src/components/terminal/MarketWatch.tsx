/**
 * Market Watch — instrument list with live prices (Binance real-time for
 * crypto, delayed Yahoo snapshot for forex/metals/indices), search,
 * favorites, sorting and click-to-load. Data source is labeled per row.
 */
import { useEffect, useMemo, useState } from "react";
import { Star } from "lucide-react";
import { INSTRUMENTS, getInstrument, type AssetClass } from "@shared/terminal";
import { fetchLastPrices } from "@/lib/terminal/data-feeds";
import { cn } from "@/lib/utils";

interface Row {
  symbol: string;
  price: number | null;
  changePct: number | null;
  high?: number | null;
  low?: number | null;
  source: "live" | "delayed" | "demo";
}

export function MarketWatch({
  active, onSelect, className,
}: {
  active: string;
  onSelect: (symbol: string) => void;
  className?: string;
}) {
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [sort, setSort] = useState<"symbol" | "change">("symbol");
  const [favs, setFavs] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("terminal.favs") || "[]"); } catch { return []; }
  });

  useEffect(() => {
    localStorage.setItem("terminal.favs", JSON.stringify(favs));
  }, [favs]);

  const symbols = useMemo(() => INSTRUMENTS.map((i) => i.symbol), []);

  const refresh = async () => {
    // crypto: real-time 24h stats straight from Binance public API
    const out: Record<string, Row> = {};
    const binance = INSTRUMENTS.filter((i) => i.feed === "binance");
    const others = INSTRUMENTS.filter((i) => i.feed === "quotes");
    if (binance.length) {
      try {
        const res = await fetch(
          `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(binance.map((i) => i.binance)))}`,
        );
        const arr: any[] = await res.json();
        const byB = new Map(arr.map((a) => [a.symbol, a]));
        for (const inst of binance) {
          const t = byB.get(inst.binance!);
          out[inst.symbol] = t
            ? { symbol: inst.symbol, price: +t.lastPrice, changePct: +t.priceChangePercent, high: +t.highPrice, low: +t.lowPrice, source: "live" }
            : { symbol: inst.symbol, price: null, changePct: null, source: "live" };
        }
      } catch { /* network */ }
    }
    if (others.length) {
      try {
        const { authedFetch } = await import("@/lib/api");
        const res: any = await authedFetch(`/api/quotes?symbols=${encodeURIComponent(others.map((i) => i.yahoo).join(","))}`);
        for (const q of res?.quotes || []) {
          const inst = others.find((i) => i.yahoo === q.symbol);
          if (!inst) continue;
          const chg = q.price && q.previousClose ? ((q.price - q.previousClose) / q.previousClose) * 100 : null;
          out[inst.symbol] = { symbol: inst.symbol, price: q.price, changePct: chg, source: "delayed" };
        }
      } catch { /* proxy down */ }
    }
    setRows((prev) => ({ ...prev, ...out }));
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const list = useMemo(() => {
    let arr = [...INSTRUMENTS];
    if (sort === "change") {
      arr = [...arr].sort((a, b) => (rows[b.symbol]?.changePct ?? -999) - (rows[a.symbol]?.changePct ?? -999));
    } else {
      arr = [...arr].sort((a, b) => (favs.includes(b.symbol) ? 1 : 0) - (favs.includes(a.symbol) ? 1 : 0) || a.symbol.localeCompare(b.symbol));
    }
    return arr;
  }, [sort, rows, favs]);

  const groups: { label: string; items: typeof INSTRUMENTS }[] = useMemo(() => {
    const favItems = list.filter((i) => favs.includes(i.symbol));
    const rest = list.filter((i) => !favs.includes(i.symbol));
    const byClass = (cls: AssetClass) => rest.filter((i) => i.assetClass === cls);
    return [
      { label: "Favorites", items: favItems },
      { label: "Forex", items: byClass("forex") },
      { label: "Metals", items: byClass("metal") },
      { label: "Crypto", items: byClass("crypto") },
      { label: "Indices", items: byClass("index") },
    ].filter((g) => g.items.length);
  }, [list, favs]);

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex items-center gap-1.5 border-b border-border/40 p-2">
        <button
          onClick={() => setSort(sort === "symbol" ? "change" : "symbol")}
          className="h-8 rounded-lg border border-border/60 px-2 text-[10px] font-semibold text-muted-foreground hover:text-foreground"
          title="Sort"
        >
          {sort === "symbol" ? "A→Z" : "%"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {groups.map((g) => (
          <div key={g.label} className="mb-2">
            <div className="px-1.5 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">{g.label}</div>
            {g.items.map((inst) => {
              const r = rows[inst.symbol];
              const chg = r?.changePct;
              return (
                <button
                  key={inst.symbol}
                  onClick={() => onSelect(inst.symbol)}
                  className={cn(
                    "group flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-card/70",
                    active === inst.symbol && "bg-emerald-500/10 ring-1 ring-emerald-500/40",
                  )}
                >
                  <Star
                    className={cn("h-3 w-3 shrink-0", favs.includes(inst.symbol) ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40 group-hover:text-muted-foreground")}
                    onClick={(e) => {
                      e.stopPropagation();
                      setFavs((f) => (f.includes(inst.symbol) ? f.filter((x) => x !== inst.symbol) : [...f, inst.symbol]));
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold text-foreground">{inst.symbol}</div>
                    <div className="truncate text-[10px] text-muted-foreground">{inst.name}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-number text-xs font-semibold text-foreground">
                      {r?.price != null ? r.price.toFixed(inst.digits) : "—"}
                    </div>
                    <div className={cn("font-number text-[10px] font-semibold", chg == null ? "text-muted-foreground" : chg >= 0 ? "text-emerald-400" : "text-red-400")}>
                      {chg == null ? "" : `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%`}
                    </div>
                  </div>
                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", r?.source === "live" ? "bg-emerald-500" : r?.source === "delayed" ? "bg-amber-500" : "bg-orange-500")} />
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="border-t border-border/40 px-2 py-1 text-[9px] leading-tight text-muted-foreground">
        ● Live — real-time · ● Delayed — Yahoo snapshot (up to 15 min) · No fabricated prices
      </div>
    </div>
  );
}
