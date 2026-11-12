/**
 * HeatmapPanel — market-wide daily performance heatmap + currency strength
 * meter. % changes come from REAL quotes: Binance 24h tickers (crypto) and
 * the /api/quotes batch proxy (forex/metals/indices, delayed). Click a tile
 * to open that instrument's chart. Currency strength = average of the
 * signed daily moves of every quoted pair containing the currency.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { authedFetch } from "@/lib/api";
import { INSTRUMENTS, getInstrument } from "@shared/terminal";
import { cn } from "@/lib/utils";

interface QuoteRow { symbol: string; price: number | null; previousClose: number | null; changePct?: number | null }

const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF"];

function heatColor(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return "bg-muted/40 text-muted-foreground";
  const a = Math.min(0.85, Math.abs(pct) / 2 + 0.12);
  return pct >= 0 ? `bg-emerald-500/${Math.round(a * 100)}` : `bg-red-500/${Math.round(a * 100)}`;
}

export function HeatmapPanel({ onSelect }: { onSelect: (symbol: string) => void }) {
  const [view, setView] = useState<"pct" | "abs">("pct");

  const q = useQuery({
    queryKey: ["heatmap"],
    queryFn: async (): Promise<Record<string, QuoteRow>> => {
      const out: Record<string, QuoteRow> = {};
      // crypto: Binance 24h ticker (real 24h change, no key)
      const cryptoSyms = INSTRUMENTS.filter((i) => i.feed === "binance");
      try {
        const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(cryptoSyms.map((i) => i.binance)))}`);
        const arr: any[] = await res.json();
        for (const row of arr) {
          const inst = INSTRUMENTS.find((i) => i.binance === row.symbol);
          if (inst) out[inst.symbol] = { symbol: inst.symbol, price: +row.lastPrice, previousClose: +(+row.lastPrice - +row.priceChange).toFixed(8), changePct: +row.priceChangePercent };
        }
      } catch { /* crypto tiles stay empty */ }
      // everything else: Yahoo batch proxy (previousClose included)
      const rest = INSTRUMENTS.filter((i) => i.feed === "quotes");
      try {
        const res = await authedFetch<{ quotes: { symbol: string; price: number | null; previousClose: number | null }[] }>(
          `/api/quotes?symbols=${encodeURIComponent(rest.map((i) => i.yahoo).join(","))}`);
        for (const qt of res.quotes ?? []) {
          const inst = INSTRUMENTS.find((i) => i.yahoo === qt.symbol);
          if (!inst) continue;
          const pct = qt.price != null && qt.previousClose ? ((qt.price - qt.previousClose) / qt.previousClose) * 100 : null;
          out[inst.symbol] = { symbol: inst.symbol, price: qt.price, previousClose: qt.previousClose, changePct: pct != null ? Math.round(pct * 100) / 100 : null };
        }
      } catch { /* proxy unavailable */ }
      return out;
    },
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  const rows = q.data ?? {};

  // currency strength: signed contribution of each pair containing the currency
  const strength = useMemo(() => {
    const acc: Record<string, { sum: number; n: number }> = {};
    for (const c of CURRENCIES) acc[c] = { sum: 0, n: 0 };
    for (const inst of INSTRUMENTS) {
      const row = rows[inst.symbol];
      const pct = row?.changePct;
      if (pct == null || !Number.isFinite(pct)) continue;
      const base = inst.symbol.slice(0, 3);
      const quote = inst.symbol.slice(3, 6);
      if (!(base in acc) && !(quote in acc)) continue;
      if (base in acc) { acc[base].sum += pct; acc[base].n++; }
      if (quote in acc) { acc[quote].sum -= pct; acc[quote].n++; }
    }
    return CURRENCIES
      .map((c) => ({ c, v: acc[c].n ? acc[c].sum / acc[c].n : null }))
      .sort((a, b) => (b.v ?? -99) - (a.v ?? -99));
  }, [rows]);

  const sorted = useMemo(() => {
    const list = INSTRUMENTS.map((i) => ({ inst: i, pct: rows[i.symbol]?.changePct ?? null })).filter((x) => x.pct != null);
    return list.sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
  }, [rows]);

  const maxAbs = Math.max(0.5, ...sorted.map((s) => Math.abs(s.pct ?? 0)));

  return (
    <div className="space-y-3 text-[11px]">
      <div className="flex items-center justify-between">
        <div className="font-bold">Market heatmap</div>
        <button onClick={() => q.refetch()} className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
          <RefreshCw className={cn("h-3 w-3", q.isFetching && "animate-spin")} />refresh
        </button>
      </div>
      {q.isError && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-red-300">Live quotes unavailable right now — retry in a moment.</div>}

      {/* tiles */}
      <div className="grid grid-cols-4 gap-1">
        {INSTRUMENTS.map((inst) => {
          const row = rows[inst.symbol];
          const pct = row?.changePct ?? null;
          const scale = 0.12 + (pct != null ? Math.min(0.73, Math.abs(pct) / maxAbs * 0.73) : 0);
          return (
            <button key={inst.symbol} onClick={() => onSelect(inst.symbol)}
              className={cn("rounded-lg border border-border/30 px-1 py-1.5 text-center transition-transform hover:scale-[1.03]",
                pct == null ? "bg-muted/40" : pct >= 0 ? `bg-emerald-500/${Math.round(scale * 100)}` : `bg-red-500/${Math.round(scale * 100)}`)}
              title={`${inst.name} · ${row?.price ?? "—"}`}>
              <div className="truncate text-[10px] font-bold">{inst.symbol}</div>
              <div className={cn("font-number text-[10px] font-bold", pct == null ? "text-muted-foreground" : pct >= 0 ? "text-emerald-300" : "text-red-300")}>
                {pct == null ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`}
              </div>
            </button>
          );
        })}
      </div>

      {/* strongest / weakest */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-emerald-500/30 bg-card/40 p-2">
          <div className="mb-1 text-[9px] font-bold uppercase tracking-wide text-emerald-400">Strongest today</div>
          {sorted.slice(0, 3).map((s) => (
            <button key={s.inst.symbol} onClick={() => onSelect(s.inst.symbol)} className="flex w-full items-center justify-between py-0.5 hover:text-emerald-300">
              <span className="font-semibold">{s.inst.symbol}</span>
              <b className="font-number text-emerald-400">+{s.pct?.toFixed(2)}%</b>
            </button>
          ))}
          {!sorted.length && <div className="text-muted-foreground">—</div>}
        </div>
        <div className="rounded-xl border border-red-500/30 bg-card/40 p-2">
          <div className="mb-1 text-[9px] font-bold uppercase tracking-wide text-red-400">Weakest today</div>
          {sorted.slice(-3).reverse().map((s) => (
            <button key={s.inst.symbol} onClick={() => onSelect(s.inst.symbol)} className="flex w-full items-center justify-between py-0.5 hover:text-red-300">
              <span className="font-semibold">{s.inst.symbol}</span>
              <b className="font-number text-red-400">{s.pct?.toFixed(2)}%</b>
            </button>
          ))}
          {!sorted.length && <div className="text-muted-foreground">—</div>}
        </div>
      </div>

      {/* currency strength meter */}
      <div className="rounded-xl border border-border/50 bg-card/40 p-2.5">
        <div className="mb-1.5 flex items-center justify-between">
          <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Currency strength (avg signed move of its pairs)</div>
          <div className="flex rounded-lg border border-border/60 text-[9px]">
            <button onClick={() => setView("pct")} className={cn("px-2 py-0.5", view === "pct" && "bg-emerald-500/20 text-emerald-400")}>bar</button>
          </div>
        </div>
        <div className="space-y-1">
          {strength.map(({ c, v }) => (
            <div key={c} className="flex items-center gap-2">
              <b className="w-9">{c}</b>
              <div className="relative h-3 flex-1 rounded bg-muted/40">
                <div className="absolute left-1/2 top-0 h-full w-px bg-border" />
                {v != null && (
                  <div className={cn("absolute top-0 h-full rounded", v >= 0 ? "bg-emerald-500/60" : "bg-red-500/60")}
                    style={v >= 0 ? { left: "50%", width: `${Math.min(50, (v / maxAbs) * 50)}%` } : { right: "50%", width: `${Math.min(50, (Math.abs(v) / maxAbs) * 50)}%` }} />
                )}
              </div>
              <span className={cn("w-14 text-right font-number", v == null ? "text-muted-foreground" : v >= 0 ? "text-emerald-400" : "text-red-400")}>
                {v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`}
              </span>
            </div>
          ))}
        </div>
      </div>
      <p className="text-[9px] text-muted-foreground">
        Crypto: real 24h Binance ticker. Forex/metals/indices: delayed Yahoo quotes via the server proxy. Currency strength is the average signed daily move of the pairs containing that currency (base +, quote −).
      </p>
    </div>
  );
}
