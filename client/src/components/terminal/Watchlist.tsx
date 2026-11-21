/**
 * Watchlist — the left rail of the professional terminal (Phase 21 §2).
 *
 * MULTI-LIST watchlists with real provider quotes: create/rename/delete
 * lists, drag-and-drop ordering, favorites, sort (manual/symbol/change),
 * compact/expanded display, search-within — all persisted (LS mirror + RTDB
 * per user via lib/watchlists). Rows subscribe to the shared price store so
 * the open chart's live ticks update their row without re-rendering the list.
 * MarketInfoPanel (§3) shows every field the providers actually supply —
 * nothing invented.
 */
import { useEffect, useMemo, useState } from "react";
import {
  GripVertical, ListPlus, Pencil, Search,
  Star, Trash2, X,
} from "lucide-react";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { getInstrument } from "@shared/terminal";
import { SPREAD_PIPS } from "@shared/trading-engine";
import { usePrice } from "@/lib/price-store";
import { useQuotes } from "@/lib/quotes-context";
import { marketStatus } from "@/lib/market-status";
import {
  useWatchlists, addToList, removeFromList, reorderList, createList, renameList,
  deleteList, setActiveList, toggleFavorite,
} from "@/lib/watchlists";
import { useTerminalSettings } from "@/lib/terminal-settings";
import { formatPriceValue } from "@/lib/number-format";
import { cn } from "@/lib/utils";

type SortMode = "manual" | "symbol" | "changePct" | "changeAbs";

const PREFS_KEY = "it_watchlist_prefs";

function loadPrefs(): { sort: SortMode; compact: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    return {
      sort: ["manual", "symbol", "changePct", "changeAbs"].includes(raw.sort) ? raw.sort : "manual",
      compact: raw.compact === true,
    };
  } catch { return { sort: "manual", compact: false }; }
}

/** Mini daily-close line — real provider data only (QuoteRow.spark); when
 *  there is not enough history yet a neutral dotted placeholder keeps the
 *  column aligned instead of inventing a line (Phase 35 §2). */
function Spark({ points, tone }: { points: number[]; tone: boolean | null }) {
  const w = 44, h = 14, pad = 2;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = (w - pad * 2) / (points.length - 1);
  const d = points
    .map((v, i) => `${(pad + i * step).toFixed(1)},${(h - pad - ((v - min) / span) * (h - pad * 2)).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0" aria-hidden>
      <polyline
        points={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={tone === null ? "text-slate-500" : tone ? "text-emerald-400/80" : "text-red-400/80"}
      />
    </svg>
  );
}

function WatchRow({
  symbol, active, compact, sortable, index, listId, favorite, otherLists, onSelect,
}: {
  symbol: string;
  active: boolean;
  compact: boolean;
  sortable: boolean;
  index: number;
  listId: string;
  favorite: boolean;
  otherLists: { id: string; name: string }[];
  onSelect: (s: string) => void;
}) {
  const inst = getInstrument(symbol);
  const live = usePrice(symbol);
  const { rows } = useQuotes();
  const { general } = useTerminalSettings();
  const grouped = general.numberFormat === "grouped";
  const row = rows[symbol] || null;
  const price = live ?? row?.price ?? null;
  const d = inst?.digits ?? 2;
  const pct = row?.changePct ?? null;
  const abs = row?.changeAbs ?? null;
  const status = marketStatus(symbol);

  if (!inst) return null;
  const tone = pct == null && abs == null ? null : (pct ?? abs ?? 0) >= 0;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
      <div
      draggable={sortable}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/watchlist-index", String(index));
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => { if (sortable) e.preventDefault(); }}
      onDrop={(e) => {
        if (!sortable) return;
        e.preventDefault();
        const from = Number(e.dataTransfer.getData("text/watchlist-index"));
        if (Number.isFinite(from)) reorderList(listId, from, index);
      }}
      onClick={() => onSelect(symbol)}
      className={cn(
        "wl-row group flex w-full cursor-pointer items-center gap-1.5 px-2 py-1.5 text-left transition-colors",
        active ? "bg-sky-500/15 shadow-[inset_2px_0_0_0_rgb(56_189_248)]" : "hover:bg-slate-800/70",
      )}
    >
      {sortable && <GripVertical className="h-3 w-3 shrink-0 cursor-grab text-slate-600 opacity-0 transition-opacity group-hover:opacity-100" />}
      <button
        onClick={(e) => { e.stopPropagation(); toggleFavorite(symbol); }}
        title={favorite ? "Remove from favorites" : "Add to favorites"}
        className={cn("shrink-0", favorite ? "text-amber-400" : "text-slate-600 hover:text-slate-400")}
      >
        <Star className={cn("h-3 w-3", favorite && "fill-amber-400")} />
      </button>
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate font-bold leading-tight", compact ? "text-[11px]" : "text-[11px]", active ? "text-sky-300" : "text-slate-200")}>
          {symbol}
          <span className={cn("ml-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle", status === "open" ? "bg-emerald-400" : "bg-slate-600")} title={status === "open" ? "Market open" : "Market closed"} />
        </span>
        {!compact && <span className="block truncate text-[9px] text-slate-500">{inst.name}</span>}
      </span>
      {!compact && (
        row?.spark && row.spark.length >= 2
          ? <Spark points={row.spark} tone={tone} />
          : <span className="shrink-0 text-center text-[9px] tracking-widest text-slate-700" style={{ width: 44 }}>···</span>
      )}
      <span className="shrink-0 text-right">
        <span className="block font-number text-[11px] font-semibold tabular-nums text-slate-100">
          {formatPriceValue(price, d, grouped)}
        </span>
        <span className={cn("block font-number text-[9px] tabular-nums", pct == null && abs == null ? "text-slate-500" : (pct ?? abs ?? 0) >= 0 ? "text-emerald-400" : "text-red-400")}>
          {pct != null ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%` : abs != null ? `${abs >= 0 ? "+" : ""}${abs.toFixed(d)}` : "—"}
          {!compact && abs != null && pct != null ? ` (${abs >= 0 ? "+" : ""}${abs.toFixed(d)})` : ""}
        </span>
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); removeFromList(listId, symbol); }}
        title="Remove from this watchlist"
        className="shrink-0 text-slate-600 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
      </div>
      </ContextMenuTrigger>
      {/* Phase 35 §4 — row context menu: chart / favorite / list management */}
      <ContextMenuContent className="w-52">
        <ContextMenuItem onClick={() => onSelect(symbol)}>Open in chart</ContextMenuItem>
        <ContextMenuItem onClick={() => toggleFavorite(symbol)}>
          {favorite ? "Remove from favorites" : "Add to favorites"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>Add to list…</ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-44">
            {otherLists.length === 0 && (
              <p className="px-2 py-1.5 text-[11px] text-slate-500">No other lists yet</p>
            )}
            {otherLists.map((l) => (
              <ContextMenuItem key={l.id} onClick={() => addToList(l.id, symbol)}>
                {l.name}
              </ContextMenuItem>
            ))}
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={() => {
                const name = window.prompt("New watchlist name");
                if (name) {
                  const id = createList(name);
                  if (id) addToList(id, symbol);
                }
              }}
            >
              New list…
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem
          className="text-red-400 focus:text-red-300"
          onClick={() => removeFromList(listId, symbol)}
        >
          Remove from this list
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function Watchlist({
  symbol, onSymbolChange, onBrowse, className,
}: {
  symbol: string;
  onSymbolChange: (s: string) => void;
  /** opens the instrument explorer (empty-state CTA) */
  onBrowse?: () => void;
  className?: string;
}) {
  const doc = useWatchlists();
  const ts = useTerminalSettings();
  const [q, setQ] = useState("");
  const [prefs, setPrefs] = useState(loadPrefs);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [, tick] = useState(0); // refresh market-status dots every 30s

  useEffect(() => { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); }, [prefs]);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const active = doc.lists.find((l) => l.id === doc.activeId) || doc.lists[0];

  const visible = useMemo(() => {
    if (!active) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return active.symbols;
    return active.symbols.filter((s) => {
      const i = getInstrument(s);
      return i && `${i.symbol} ${i.name}`.toLowerCase().includes(needle);
    });
  }, [active, q]);

  // snapshot-aware sorting: A-Z alphabetizes, change% / change sort on the
  // quotes snapshot, favorites always float to the top, manual keeps DnD order
  const { rows } = useQuotes();
  const finalList = useMemo(() => {
    if (prefs.sort === "symbol") return [...visible].sort((a, b) => a.localeCompare(b));
    if (prefs.sort !== "changePct" && prefs.sort !== "changeAbs") return visible;
    const val = (s: string) => (prefs.sort === "changePct" ? rows[s]?.changePct : rows[s]?.changeAbs);
    return [...visible].sort((a, b) => {
      const fa = doc.favorites.includes(a) ? 0 : 1;
      const fb = doc.favorites.includes(b) ? 0 : 1;
      if (fa !== fb) return fa - fb;
      const va = val(a), vb = val(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return vb - va;
    });
  }, [visible, prefs.sort, rows, doc.favorites]);

  const grouped = prefs.sort === "manual" && !q ? groupByClass(finalList) : null;
  const otherLists = doc.lists.filter((l) => l.id !== active.id).map((l) => ({ id: l.id, name: l.name }));

  return (
    <div className={cn("flex h-full min-h-0 flex-col border-slate-800 bg-[#0b1220]", className)}>
      {/* list switcher row */}
      <div className="flex items-center gap-1 border-b border-slate-800 px-2 py-1.5">
        {editing ? (
          <>
            <input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { renameList(active.id, draftName); setEditing(false); }
                if (e.key === "Escape") setEditing(false);
              }}
              className="h-6 w-full rounded border border-slate-600 bg-slate-950 px-1.5 text-[11px] text-slate-100 focus:outline-none"
            />
            <button onClick={() => { renameList(active.id, draftName); setEditing(false); }} className="text-emerald-400 hover:text-emerald-300" title="Save name">✓</button>
            <button onClick={() => setEditing(false)} className="text-slate-500 hover:text-slate-300" title="Cancel"><X className="h-3 w-3" /></button>
          </>
        ) : (
          <>
            <select
              value={doc.activeId}
              onChange={(e) => setActiveList(e.target.value)}
              className="h-6 min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-1 text-[11px] font-semibold text-slate-200 focus:outline-none"
            >
              {doc.lists.map((l) => (
                <option key={l.id} value={l.id}>{l.name} ({l.symbols.length})</option>
              ))}
            </select>
            <button
              onClick={() => { setDraftName(active.name); setEditing(true); }}
              title="Rename this watchlist"
              className="text-slate-500 hover:text-slate-200"
            ><Pencil className="h-3 w-3" /></button>
            <button
              onClick={() => setConfirmDelete(true)}
              title="Delete this watchlist"
              className={cn("text-slate-500 hover:text-red-400", doc.lists.length <= 1 && "pointer-events-none opacity-30")}
            ><Trash2 className="h-3 w-3" /></button>
            <button
              onClick={() => { const name = window.prompt("New watchlist name"); if (name) createList(name); }}
              title="Create a new watchlist"
              className="text-slate-500 hover:text-emerald-400"
            ><ListPlus className="h-3 w-3" /></button>
          </>
        )}
      </div>

      {/* search + sort + density row */}
      <div className="flex items-center gap-1 border-b border-slate-800 px-2 py-1">
        <Search className="h-3 w-3 shrink-0 text-slate-500" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search in list…"
          className="h-5 w-full min-w-0 bg-transparent text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none"
        />
        <select
          value={prefs.sort}
          onChange={(e) => setPrefs((p) => ({ ...p, sort: e.target.value as SortMode }))}
          title="Sort"
          className="h-5 shrink-0 rounded border border-slate-700 bg-slate-950 px-0.5 text-[10px] text-slate-300 focus:outline-none"
        >
          <option value="manual">Manual</option>
          <option value="symbol">A-Z</option>
          <option value="changePct">Change %</option>
          <option value="changeAbs">Change</option>
        </select>
        <button
          onClick={() => setPrefs((p) => ({ ...p, compact: !p.compact }))}
          title={prefs.compact ? "Expanded rows" : "Compact rows"}
          className={cn("shrink-0 text-[9px] font-bold uppercase tracking-wide", prefs.compact ? "text-sky-300" : "text-slate-500 hover:text-slate-300")}
        >
          {prefs.compact ? "C" : "E"}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {grouped ? (
          ASSET_CLASS_ORDER.map((c) => {
            const syms = grouped[c];
            if (!syms?.length) return null;
            return (
              <div key={c}>
                <p className="border-b border-slate-800/60 px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-slate-500">
                  {c} <span className="ml-1 font-normal">{syms.length}</span>
                </p>
                {syms.map((s, idx) => (
                  <WatchRow key={s} symbol={s} index={idx} listId={active.id} active={s === symbol} compact={prefs.compact}
                    sortable favorite={doc.favorites.includes(s)} otherLists={otherLists} onSelect={onSymbolChange} />
                ))}
              </div>
            );
          })
        ) : (
          finalList.map((s, idx) => (
            <WatchRow key={s} symbol={s} index={idx} listId={active.id} active={s === symbol} compact={prefs.compact}
              sortable favorite={doc.favorites.includes(s)} otherLists={otherLists} onSelect={onSymbolChange} />
          ))
        )}
        {/* Phase 35 §4 — useful empty state for new lists */}
        {!finalList.length && (
          <div className="flex flex-col items-center gap-2 p-6 text-center">
            <ListPlus className="h-5 w-5 text-slate-600" />
            <p className="text-[11px] leading-4 text-slate-500">
              {q ? "No match in this list" : "This watchlist is empty — browse instruments to fill it."}
            </p>
            {!q && onBrowse && (
              <button
                onClick={onBrowse}
                className="rounded-md border border-slate-700 px-2.5 py-1 text-[10px] font-semibold text-sky-300 transition-colors hover:bg-sky-500/10"
              >
                Browse instruments
              </button>
            )}
          </div>
        )}
      </div>

      {confirmDelete && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 p-3" onClick={() => setConfirmDelete(false)}>
          <div className="w-56 rounded-lg border border-slate-700 bg-slate-900 p-3" onClick={(e) => e.stopPropagation()}>
            <p className="mb-2 text-[11px] font-semibold text-slate-200">Delete “{active.name}”?</p>
            <p className="mb-3 text-[10px] text-slate-500">The list is removed for this account. Instruments are not affected.</p>
            <div className="flex justify-end gap-1.5">
              <button onClick={() => setConfirmDelete(false)} className="rounded border border-slate-600 px-2 py-1 text-[10px] text-slate-400 hover:text-slate-200">Cancel</button>
              <button onClick={() => { deleteList(active.id); setConfirmDelete(false); }} className="rounded bg-red-500 px-2 py-1 text-[10px] font-bold text-white hover:bg-red-400">Delete</button>
            </div>
          </div>
        </div>
      )}
      {/* density hint from the global settings (compact/cozy row spacing) */}
      <span className="hidden">{ts.appearance.density}</span>
    </div>
  );
}

const ASSET_CLASS_ORDER = ["Forex", "Metals", "Crypto", "Indices"] as const;

function groupByClass(symbols: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of symbols) {
    const inst = getInstrument(s);
    if (!inst) continue;
    const label = inst.assetClass === "metal" ? "Metals" : inst.assetClass === "crypto" ? "Crypto" : inst.assetClass === "forex" ? "Forex" : "Indices";
    (out[label] ||= []).push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// MarketInfoPanel — instrument details rail panel (§3): every field comes
// from the catalog spec or a real provider quote — unavailable values stay
// "—", never invented.
// ---------------------------------------------------------------------------

export function MarketInfoPanel({ symbol }: { symbol: string }) {
  const inst = getInstrument(symbol);
  const mid = usePrice(symbol);
  const { rows, updatedAt } = useQuotes();
  const row = rows[symbol] || null;
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  if (!inst) return <p className="p-3 text-[11px] text-slate-500">Unknown instrument</p>;
  const spread = (SPREAD_PIPS[symbol] ?? 2) * inst.pipSize;
  const bid = mid != null ? mid - spread / 2 : null;
  const ask = mid != null ? mid + spread / 2 : null;
  const status = marketStatus(symbol);
  const d = inst.digits;
  const sessionLabel = inst.assetClass === "crypto" ? "24/7" : inst.assetClass === "index" ? "Exchange regular hours" : "Sun 22:00 — Fri 21:00 UTC";
  const feedLabel = inst.feed === "binance" ? "Binance" : inst.feedLabel || "Quotes proxy";
  const live = inst.feed === "binance" || inst.underlier === "spot";
  const age = row?.at ? Math.max(0, Math.round((Date.now() - row.at) / 1000)) : null;
  const rowsList: [string, string][] = [
    ["Name", inst.name],
    ["Asset class", inst.assetClass === "metal" ? "Metal" : inst.assetClass],
    ["Market", inst.underlier === "spot" ? "Spot" : inst.underlier],
    ["Data feed", `${feedLabel} · ${live ? "live" : "delayed"}`],
    ["Status", status === "open" ? "Open" : "Closed"],
    ["Session", sessionLabel],
    ["Daily open", row?.open != null ? row.open.toFixed(d) : "—"],
    ["Daily high", row?.high != null ? row.high.toFixed(d) : "—"],
    ["Daily low", row?.low != null ? row.low.toFixed(d) : "—"],
    ["Prev close", row?.prevClose != null ? row.prevClose.toFixed(d) : "—"],
    ["Day change", row?.changeAbs != null ? `${row.changeAbs >= 0 ? "+" : "−"}${Math.abs(row.changeAbs).toFixed(d)}${row.changePct != null ? ` (${row.changePct >= 0 ? "+" : "−"}${Math.abs(row.changePct).toFixed(2)}%)` : ""}` : "—"],
    ["Quote updated", age != null ? (age < 5 ? "just now" : `${age}s ago`) : updatedAt ? "snapshot" : "—"],
    ["Price precision", `${d} digits`],
    ["Pip size", String(inst.pipSize)],
    ["Contract size", String(inst.contractSize)],
    ["Quote currency", inst.quote],
    ["Spread (engine)", `${SPREAD_PIPS[symbol] ?? 2} pips`],
  ];
  return (
    <div className="p-2 text-[11px]">
      <p className="mb-1 flex items-center gap-2 text-sm font-bold text-slate-100">
        {symbol}
        <span className={cn("inline-block h-2 w-2 rounded-full", status === "open" ? "bg-emerald-400" : "bg-slate-600")} />
        <span className="text-[10px] font-normal text-slate-500">{status === "open" ? "Open" : "Closed"}</span>
      </p>
      <div className="mb-2 grid grid-cols-3 gap-1 rounded-lg border border-slate-800 p-1.5 text-center">
        <div><p className="text-[9px] uppercase text-slate-500">Bid</p><p className="font-number font-semibold text-red-400">{bid != null ? bid.toFixed(d) : "—"}</p></div>
        <div><p className="text-[9px] uppercase text-slate-500">Mid</p><p className="font-number font-semibold text-slate-100">{mid != null ? mid.toFixed(d) : "—"}</p></div>
        <div><p className="text-[9px] uppercase text-slate-500">Ask</p><p className="font-number font-semibold text-emerald-400">{ask != null ? ask.toFixed(d) : "—"}</p></div>
      </div>
      <dl className="space-y-1">
        {rowsList.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2 border-b border-slate-800/60 py-1">
            <dt className="text-slate-500">{k}</dt>
            <dd className="text-right font-medium text-slate-200">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
