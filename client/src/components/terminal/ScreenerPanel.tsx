/**
 * ScreenerPanel — runs multiple simultaneous filters over every supported
 * instrument's real bars (TTL-cached 5 min). Sortable results table and
 * named filter configurations saved to Firebase.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Plus, Save, Trash2 } from "lucide-react";
import { ref, get, set, remove } from "firebase/database";
import { db } from "@/lib/firebase";
import { useAuth } from "@/hooks/use-auth";
import { INSTRUMENTS, TIMEFRAMES, type Timeframe } from "@shared/terminal";
import { loadBarsMany } from "@/lib/terminal/data-feeds";
import { FILTER_CATALOG, runScreener, newFilter, type ScreenerFilter, type ScreenerRow } from "@/lib/terminal/screener";
import { Stat } from "./ToolDrawer";
import { cn } from "@/lib/utils";

interface Preset { id: string; name: string; timeframe: string; filters: ScreenerFilter[] }

export function ScreenerPanel({ onSelect }: { onSelect: (symbol: string) => void }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [filters, setFilters] = useState<ScreenerFilter[]>([{ ...newFilter(), kind: "rsi", op: "below", value: 30, p1: 14 }]);
  const [timeframe, setTimeframe] = useState<Timeframe>("1h");
  const [rows, setRows] = useState<ScreenerRow[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState("");
  const [presetName, setPresetName] = useState("");

  const scan = async () => {
    if (!filters.length) return;
    setScanning(true);
    setRows(null);
    try {
      // crypto loads directly; quotes instruments go through the authed proxy
      const symbols = INSTRUMENTS.map((i) => i.symbol);
      const byClass: Record<string, string[]> = { direct: [], proxy: [] };
      for (const s of symbols) {
        (INSTRUMENTS.find((i) => i.symbol === s)?.feed === "binance" ? byClass.direct : byClass.proxy).push(s);
      }
      setProgress("Loading crypto history…");
      const direct = await loadBarsMany(byClass.direct, timeframe, 500);
      setProgress("Loading forex/metals/indices history (delayed feed)…");
      const proxy = await loadBarsMany(byClass.proxy, timeframe, 500);
      setProgress("");
      const all = { ...direct, ...proxy };
      setRows(runScreener(all, filters));
    } catch (e: any) {
      setProgress("");
      setRows([]);
    } finally {
      setScanning(false);
    }
  };

  // saved configurations
  const presetsQ = useQuery({
    queryKey: ["screenerPresets", user?.uid],
    enabled: !!user,
    queryFn: async (): Promise<Preset[]> => {
      const snap = await get(ref(db, `terminalScreener/${user!.uid}`));
      return snap.exists() ? Object.values<Preset>(snap.val()).sort((a: Preset, b: Preset) => b.id.localeCompare(a.id)) : [];
    },
  });

  const savePreset = async () => {
    if (!user || !presetName.trim()) return;
    const id = Date.now().toString(36);
    await set(ref(db, `terminalScreener/${user.uid}/${id}`), { id, name: presetName.trim(), timeframe, filters } as Preset);
    setPresetName("");
    qc.invalidateQueries({ queryKey: ["screenerPresets", user.uid] });
  };
  const deletePreset = async (id: string) => {
    if (!user) return;
    await remove(ref(db, `terminalScreener/${user.uid}/${id}`));
    qc.invalidateQueries({ queryKey: ["screenerPresets", user.uid] });
  };

  const patchFilter = (id: string, p: Partial<ScreenerFilter>) =>
    setFilters((l) => l.map((f) => (f.id === id ? { ...f, ...p } : f)));

  const passed = rows?.filter((r) => r.passed) ?? [];

  return (
    <div className="space-y-3 text-[11px]">
      <div className="flex items-center gap-1.5">
        <b>Market screener</b>
        <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as Timeframe)} className="num-input ml-auto h-7 w-20">
          {TIMEFRAMES.filter((t) => t !== "1W" && t !== "1M").map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <button onClick={scan} disabled={scanning} className="flex h-7 items-center gap-1 rounded-lg bg-emerald-500/20 px-2.5 font-bold text-emerald-400 hover:bg-emerald-500/30 disabled:opacity-40">
          <Play className="h-3 w-3" />{scanning ? "Scanning…" : "Scan market"}
        </button>
      </div>
      {progress && <div className="rounded-lg border border-border/50 bg-card/40 px-2 py-1.5 text-muted-foreground">{progress}</div>}

      {/* filter builder */}
      <section className="space-y-1.5 rounded-xl border border-border/50 bg-card/40 p-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Filters (all must match)</span>
          <button onClick={() => setFilters((l) => [...l, newFilter()])} className="flex items-center gap-0.5 text-emerald-400"><Plus className="h-3 w-3" />add</button>
        </div>
        {filters.map((f) => {
          const spec = FILTER_CATALOG.find((s) => s.kind === f.kind)!;
          return (
            <div key={f.id} className="flex items-center gap-1">
              <select value={f.kind} onChange={(e) => {
                const s2 = FILTER_CATALOG.find((x) => x.kind === e.target.value)!;
                patchFilter(f.id, { kind: s2.kind, op: s2.ops[0], p1: s2.p1 === "period" ? 14 : s2.p1 === "fast" ? 9 : s2.p1 === "bars" ? 10 : 0, p2: s2.p2 === "slow" ? 21 : s2.p2 === "level" ? 30 : 0 });
              }} className="num-input h-7 min-w-0 flex-1">
                {FILTER_CATALOG.map((s) => <option key={s.kind} value={s.kind}>{s.label}</option>)}
              </select>
              <select value={f.op} onChange={(e) => patchFilter(f.id, { op: e.target.value as ScreenerFilter["op"] })} className="num-input h-7 w-20">
                {spec.ops.map((o) => <option key={o} value={o}>{o === "above" ? ">" : o === "below" ? "<" : o === "crossUp" ? "↑ cross" : "↓ cross"}</option>)}
              </select>
              <input type="number" step="any" value={f.value} onChange={(e) => patchFilter(f.id, { value: Number(e.target.value) })} title="value" className="num-input h-7 w-16" />
              {spec.p1 && spec.p1 !== "value %" && <input type="number" value={f.p1} onChange={(e) => patchFilter(f.id, { p1: Number(e.target.value) })} title={spec.p1} className="num-input h-7 w-12" />}
              {spec.p2 && <input type="number" value={f.p2} onChange={(e) => patchFilter(f.id, { p2: Number(e.target.value) })} title={spec.p2} className="num-input h-7 w-12" />}
              <button onClick={() => setFilters((l) => l.filter((x) => x.id !== f.id))} className="text-muted-foreground hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
            </div>
          );
        })}
      </section>

      {/* results */}
      {rows && (
        <section className="rounded-xl border border-border/50 bg-card/40 p-2.5">
          <div className="mb-1.5 grid grid-cols-3 gap-1.5">
            <Stat label="Scanned" value={rows.length} />
            <Stat label="Matched" value={passed.length} tone={passed.length ? "up" : "neutral"} />
            <Stat label="Timeframe" value={timeframe} />
          </div>
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-[#0d1117]"><tr className="text-[9px] uppercase text-muted-foreground">
                {(["symbol", "price", "changePct", "rsi", "atrPct", "volPct"] as const).map((k) => (
                  <th key={k} className="px-1 py-1 text-left font-medium">{k === "volPct" ? "Vol σ%" : k}</th>
                ))}
              </tr></thead>
              <tbody className="font-number">
                {[...rows].sort((a, b) => Number(b.passed) - Number(a.passed)).map((r) => (
                  <tr key={r.symbol} className={cn("cursor-pointer border-t border-border/30 hover:bg-card", !r.passed && "opacity-45")}
                    onClick={() => r.passed && onSelect(r.symbol)} title={r.passed ? "Open chart" : `Failed: ${r.failed.join(", ")}`}>
                    <td className="py-1"><b className={r.passed ? "text-emerald-400" : ""}>{r.symbol}</b></td>
                    <td>{r.price > 1000 ? r.price.toFixed(0) : r.price.toFixed(r.price > 10 ? 2 : 4)}</td>
                    <td className={r.changePct >= 0 ? "text-emerald-400" : "text-red-400"}>{r.changePct >= 0 ? "+" : ""}{r.changePct}%</td>
                    <td>{r.rsi ?? "—"}</td>
                    <td>{r.atrPct ?? "—"}%</td>
                    <td>{r.volatilityPct ?? "—"}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[9px] text-muted-foreground">Rows without enough history for a filter fail that filter honestly. Crypto = live Binance bars; others = delayed Yahoo bars.</p>
        </section>
      )}

      {/* saved configurations */}
      <section className="rounded-xl border border-border/50 bg-card/40 p-2.5">
        <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Saved configurations</div>
        <div className="flex gap-1.5">
          <input value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="Configuration name…" className="num-input h-7 flex-1" />
          <button onClick={savePreset} disabled={!presetName.trim() || !user} className="flex h-7 items-center gap-1 rounded-lg border border-emerald-500/40 px-2 font-bold text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-40"><Save className="h-3 w-3" />Save</button>
        </div>
        <div className="mt-1.5 space-y-1">
          {(presetsQ.data ?? []).map((p) => (
            <div key={p.id} className="flex items-center gap-2 rounded-md border border-border/40 bg-card/40 px-2 py-1">
              <b>{p.name}</b>
              <span className="text-muted-foreground">{p.timeframe} · {p.filters.length} filters</span>
              <button onClick={() => { setFilters(p.filters); setTimeframe(p.timeframe as Timeframe); }} className="ml-auto rounded border border-border/60 px-1.5 text-[10px] text-muted-foreground hover:text-foreground">Load</button>
              <button onClick={() => deletePreset(p.id)} className="text-muted-foreground hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
            </div>
          ))}
          {!presetsQ.data?.length && <div className="text-muted-foreground">No saved configurations yet.</div>}
        </div>
      </section>
    </div>
  );
}
