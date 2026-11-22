/**
 * InstrumentExplorer — the professional instrument picker (Phase 21 §1).
 *
 * Replaces the plain SymbolSearchDialog 1:1 (same props) with the full
 * explorer: instant search across symbol+name, category tabs, recently
 * viewed, favorites, add-to-watchlist, live price + day change (real
 * provider data via the quotes snapshot), market status and data freshness.
 * The currently selected instrument is highlighted.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { INSTRUMENTS, type InstrumentSpec } from "@shared/terminal";
import { cn } from "@/lib/utils";
import { useQuotes } from "@/lib/quotes-context";
import { marketStatus } from "@/lib/market-status";
import { useWatchlists, toggleFavorite, touchRecent, addToList } from "@/lib/watchlists";
import { useTerminalSettings } from "@/lib/terminal-settings";
import { formatPriceValue } from "@/lib/number-format";

const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "forex", label: "Forex" },
  { id: "metal", label: "Metals" },
  { id: "crypto", label: "Crypto" },
  { id: "index", label: "Indices" },
] as const;

type CategoryId = (typeof CATEGORIES)[number]["id"];

function fmtPrice(v: number | null, digits: number, grouped: boolean): string {
  return formatPriceValue(v, digits, grouped);
}

function fmtChange(row: { changeAbs: number | null; changePct: number | null }, digits: number) {
  if (row.changeAbs == null && row.changePct == null) return null;
  const abs = row.changeAbs != null ? `${row.changeAbs >= 0 ? "+" : "−"}${Math.abs(row.changeAbs).toFixed(digits)}` : "—";
  const pct = row.changePct != null ? `${row.changePct >= 0 ? "+" : "−"}${Math.abs(row.changePct).toFixed(2)}%` : "—";
  return { abs, pct, up: (row.changeAbs ?? row.changePct ?? 0) >= 0 };
}

function fmtAge(at: number, now: number): string {
  const s = Math.round((now - at) / 1000);
  if (s < 5) return "now";
  if (s < 90) return `${s}s`;
  return `${Math.round(s / 60)}m`;
}

export function InstrumentExplorer({
  open, current, onClose, onSelect,
}: {
  open: boolean;
  current: string;
  onClose: () => void;
  onSelect: (symbol: string) => void;
}) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<CategoryId>("all");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { rows, updatedAt } = useQuotes();
  const doc = useWatchlists();
  const settings = useTerminalSettings();
  const activeList = doc.lists.find((l) => l.id === doc.activeId);
  const [, tick] = useState(0); // re-render every second for freshness labels

  useEffect(() => {
    if (open) { setQ(""); setCat("all"); setTimeout(() => inputRef.current?.focus(), 50); }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [open]);

  const now = Date.now();

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let base = INSTRUMENTS;
    if (cat !== "all") base = base.filter((i) => i.assetClass === cat);
    if (needle) base = base.filter((i) => `${i.symbol} ${i.name}`.toLowerCase().includes(needle));
    return base;
  }, [q, cat]);

  if (!open) return null;

  const select = (symbol: string) => {
    touchRecent(symbol);
    onSelect(symbol);
    onClose();
  };

  const first = list[0];
  const statusOf = (s: string) => marketStatus(s, now);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onPointerDown={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        if (e.key === "Enter" && first) select(first.symbol);
      }}
    >
      <div
        className="flex h-[min(520px,92dvh)] w-[min(620px,94vw)] flex-col rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-2xl"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center gap-2">
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search symbol or name…"
            className="num-input h-8 flex-1"
          />
          <button onClick={onClose} className="px-2 text-slate-500 hover:text-slate-200">✕</button>
        </div>

        <div className="mb-2 flex items-center gap-1">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              onClick={() => setCat(c.id)}
              className={cn(
                "rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors",
                cat === c.id ? "bg-sky-500/15 text-sky-300" : "text-slate-400 hover:bg-slate-800 hover:text-slate-200",
              )}
            >
              {c.label}
            </button>
          ))}
          <span className="ml-auto text-[10px] text-slate-500">
            {updatedAt ? `updated ${fmtAge(updatedAt, now)} ago` : "loading quotes…"}
          </span>
        </div>

        {/* recently viewed — only when not filtering */}
        {!q && doc.recents.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1">
            <span className="mr-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Recent</span>
            {doc.recents.slice(0, 8).map((s) => {
              const inst = INSTRUMENTS.find((i) => i.symbol === s);
              if (!inst) return null;
              return (
                <button
                  key={s}
                  onClick={() => select(s)}
                  className="rounded-full border border-slate-700 px-2 py-0.5 text-[10px] font-semibold text-slate-300 hover:border-sky-600 hover:text-sky-300"
                >
                  {inst.symbol}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {doc.favorites.length > 0 && !q && cat === "all" && (
            <p className="mb-1 mt-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Favorites</p>
          )}
          {list
            .slice()
            .sort((a, b) => {
              const fa = doc.favorites.includes(a.symbol) ? 0 : 1;
              const fb = doc.favorites.includes(b.symbol) ? 0 : 1;
              return fa - fb;
            })
            .map((i) => (
              <ExplorerRow
                key={i.symbol}
                inst={i}
                row={rows[i.symbol] || null}
                current={i.symbol === current}
                favorite={doc.favorites.includes(i.symbol)}
                inList={activeList?.symbols.includes(i.symbol) || false}
                status={statusOf(i.symbol)}
                now={now}
                grouped={settings.general.numberFormat === "grouped"}
                onStar={() => toggleFavorite(i.symbol)}
                onAdd={() => activeList && addToList(activeList.id, i.symbol)}
                onSelect={() => select(i.symbol)}
              />
            ))}
          {!list.length && (
            <p className="py-6 text-center text-xs text-slate-500">No instrument matches “{q}”</p>
          )}
        </div>

        <div className="mt-2 flex items-center justify-between border-t border-slate-800 pt-2 text-[10px] text-slate-500">
          <span>Enter — open first match · Esc — close</span>
          <span>{list.length} instruments</span>
        </div>
      </div>
    </div>
  );
}

function ExplorerRow({
  inst, row, current, favorite, inList, status, now, grouped, onStar, onAdd, onSelect,
}: {
  inst: InstrumentSpec;
  row: { price: number | null; changeAbs: number | null; changePct: number | null; at: number } | null;
  current: boolean;
  favorite: boolean;
  inList: boolean;
  status: "open" | "closed";
  now: number;
  grouped: boolean;
  onStar: () => void;
  onAdd: () => void;
  onSelect: () => void;
}) {
  const chg = row ? fmtChange(row, inst.digits) : null;
  const price = row ? fmtPrice(row.price, inst.digits, grouped) : "—";
  return (
    <div
      onClick={onSelect}
      className={cn(
        "group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors hover:bg-slate-800",
        current && "bg-sky-500/10",
      )}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onStar(); }}
        title={favorite ? "Remove from favorites" : "Add to favorites"}
        className={cn("w-5 text-center text-[13px] leading-none transition-colors", favorite ? "text-amber-400" : "text-slate-600 hover:text-slate-400")}
      >
        {favorite ? "★" : "☆"}
      </button>
      <div className="w-24 shrink-0">
        <span className={cn("font-bold", current ? "text-sky-300" : "text-slate-100")}>{inst.symbol}</span>
      </div>
      <span className="min-w-0 flex-1 truncate text-slate-400">{inst.name}</span>
      <span className="font-number w-24 shrink-0 text-right text-slate-100">{price}</span>
      <span className={cn("w-28 shrink-0 text-right tabular-nums", chg ? (chg.up ? "text-emerald-400" : "text-red-400") : "text-slate-500")}>
        {chg ? `${chg.abs} (${chg.pct})` : "—"}
      </span>
      <span className="flex w-14 shrink-0 items-center justify-end gap-1">
        <span className={cn("h-1.5 w-1.5 rounded-full", status === "open" ? "bg-emerald-400" : "bg-slate-600")} />
        <span className="text-[10px] text-slate-500">{row ? fmtAge(row.at, now) : "—"}</span>
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); if (!inList) onAdd(); }}
        title={inList ? "Already in the active watchlist" : "Add to the active watchlist"}
        disabled={inList}
        className={cn(
          "w-5 text-center text-sm leading-none transition-colors",
          inList ? "text-emerald-500" : "text-slate-600 hover:text-emerald-400",
        )}
      >
        {inList ? "✓" : "+"}
      </button>
    </div>
  );
}
