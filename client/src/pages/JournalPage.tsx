/**
 * JournalPage — advanced trading journal.
 *
 * Every completed trade (live terminal closes via the blotter's auto-save and
 * replay trades saved with a chart snapshot) lands in trades/{uid} — scoped to
 * the signed-in user by Firebase rules. This page is the review & annotation
 * surface: notes, strategy + setup tags, mistake tracking, emotional state
 * before/after, a 1–5 star rating and screenshots (compressed client-side,
 * stored in the user's own RTDB node).
 */
import { useMemo, useRef, useState } from "react";
import { BookOpen, Save, Trash2, Star, X, Search } from "lucide-react";
import { useTrades, useUpdateTrade, useDeleteTrade, EMOTIONS, MISTAKE_PRESETS, type Trade } from "@/hooks/use-trades";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const money = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (ms?: number) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "—");

export default function JournalPage() {
  const { data: trades = [], isLoading } = useTrades();
  const updateTrade = useUpdateTrade();
  const deleteTrade = useDeleteTrade();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [resultFilter, setResultFilter] = useState<"all" | "win" | "loss">("all");
  const [sourceFilter, setSourceFilter] = useState<"all" | "live" | "replay">("all");

  const filtered = useMemo(() => {
    return trades.filter((t) => {
      if (resultFilter === "win" && t.profit <= 0) return false;
      if (resultFilter === "loss" && t.profit > 0) return false;
      if (sourceFilter === "replay" && !t.replay) return false;
      if (sourceFilter === "live" && t.replay) return false;
      if (query) {
        const q = query.toLowerCase();
        const hay = `${t.assetName} ${t.instrumentSymbol ?? ""} ${t.comment ?? ""} ${(t.tags ?? []).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [trades, query, resultFilter, sourceFilter]);

  const selected = filtered.find((t) => t.id === selectedId) ?? filtered[0] ?? null;
  const summary = useMemo(() => {
    const wins = trades.filter((t) => t.profit > 0).length;
    const net = trades.reduce((s, t) => s + t.profit, 0);
    return { count: trades.length, wins, winRate: trades.length ? Math.round((wins / trades.length) * 1000) / 10 : 0, net };
  }, [trades]);

  const save = (patch: Partial<Trade>) => {
    if (!selected) return;
    updateTrade.mutate({ id: selected.id, patch }, {
      onSuccess: () => toast({ title: "Journal updated" }),
      onError: (e) => toast({ title: "Save failed", description: String(e), variant: "destructive" }),
    });
  };

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4">
      <div className="flex items-center gap-2">
        <BookOpen className="h-5 w-5 text-sky-400" />
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Trading journal</h1>
          <p className="text-xs text-slate-400">
            {summary.count} trades · win rate {summary.winRate}% · net {summary.net >= 0 ? "+" : "−"}${money(Math.abs(summary.net))}
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        {/* list */}
        <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-900/60 p-3">
          <div className="flex items-center gap-2">
            <Search className="h-3.5 w-3.5 text-slate-500" />
            <input
              value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search symbol, notes, tags…"
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100"
            />
          </div>
          <div className="flex gap-1">
            {(["all", "win", "loss"] as const).map((f) => (
              <button key={f} onClick={() => setResultFilter(f)} className={chip(resultFilter === f)}>{f}</button>
            ))}
            <span className="w-2" />
            {(["all", "live", "replay"] as const).map((f) => (
              <button key={f} onClick={() => setSourceFilter(f)} className={chip(sourceFilter === f)}>{f}</button>
            ))}
          </div>
          <div className="max-h-[560px] space-y-1.5 overflow-auto">
            {isLoading && <div className="py-8 text-center text-xs text-slate-500">Loading journal…</div>}
            {!isLoading && filtered.length === 0 && (
              <div className="py-8 text-center text-xs text-slate-500">
                No trades match. Live terminal closes and replay trades are saved here automatically.
              </div>
            )}
            {filtered.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                className={cn(
                  "w-full rounded-md border px-2.5 py-2 text-left",
                  selected?.id === t.id ? "border-sky-600 bg-slate-800/60" : "border-slate-800 hover:bg-slate-800/40",
                )}
              >
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-200">
                    {t.type} {t.instrumentSymbol || t.assetName}
                    {t.replay && <span className="ml-1.5 rounded bg-amber-500/20 px-1 text-[9px] font-bold uppercase text-amber-300">replay</span>}
                  </span>
                  <span className={cn("font-semibold tabular-nums", t.profit >= 0 ? "text-emerald-400" : "text-red-400")}>
                    {t.profit >= 0 ? "+" : "−"}${money(Math.abs(t.profit))}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center justify-between text-[10px] text-slate-500">
                  <span>{fmtDate(t.timestamp)}</span>
                  <span>{t.lotSize.toFixed(2)} lots @ {t.entryPrice}</span>
                </div>
                {(t.rating ?? 0) > 0 && (
                  <div className="mt-1 flex gap-0.5">
                    {Array.from({ length: t.rating! }).map((_, i) => (
                      <Star key={i} className="h-3 w-3 fill-amber-400 text-amber-400" />
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* editor */}
        <div className="rounded-lg border border-slate-800 bg-slate-900/60">
          {!selected ? (
            <div className="flex h-72 items-center justify-center text-sm text-slate-500">Select a trade to review.</div>
          ) : (
            <TradeEditor
              key={selected.id}
              trade={selected}
              onSave={(patch) => save(patch)}
              onDelete={() => {
                deleteTrade.mutate({ tradeId: selected.id, profit: selected.profit }, {
                  onSuccess: () => { setSelectedId(null); toast({ title: "Trade removed from journal" }); },
                });
              }}
              saving={updateTrade.isPending}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function TradeEditor({ trade, onSave, onDelete, saving }: {
  trade: Trade;
  onSave: (patch: Partial<Trade>) => void;
  onDelete: () => void;
  saving: boolean;
}) {
  const [notes, setNotes] = useState(trade.comment ?? "");
  const [strategy, setStrategy] = useState(trade.tradingStrategy ?? "");
  const [entryReason, setEntryReason] = useState(trade.entryReason ?? "");
  const [lessons, setLessons] = useState(trade.lessons ?? "");
  const [tags, setTags] = useState<string[]>(trade.tags ?? []);
  const [tagInput, setTagInput] = useState("");
  const [mistakes, setMistakes] = useState<string[]>(trade.mistakesList ?? []);
  const [emotionBefore, setEmotionBefore] = useState(trade.emotionBefore ?? "");
  const [emotionAfter, setEmotionAfter] = useState(trade.emotionAfter ?? "");
  const [rating, setRating] = useState(trade.rating ?? 0);
  const [screenshots, setScreenshots] = useState<string[]>(trade.screenshots ?? []);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const risk = trade.slPrice != null ? Math.abs(trade.entryPrice - trade.slPrice) : null;
  const reward = trade.tpPrice != null ? Math.abs(trade.tpPrice - trade.entryPrice) : null;
  const rr = risk && reward ? Math.round((reward / risk) * 100) / 100 : trade.riskReward ?? null;

  const addTag = () => {
    const v = tagInput.trim();
    if (v && !tags.includes(v)) setTags([...tags, v]);
    setTagInput("");
  };

  const onFile = async (file: File) => {
    const dataUrl = await compressImage(file);
    if (dataUrl) setScreenshots((prev) => [...prev, dataUrl]);
    else toast({ title: "Could not read that image", variant: "destructive" });
  };

  return (
    <div className="space-y-4 p-4">
      {/* trade facts */}
      <div className="grid grid-cols-2 gap-2 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs sm:grid-cols-4 lg:grid-cols-6">
        <Fact label="Side" value={trade.type} good={trade.type === "BUY"} />
        <Fact label="Instrument" value={trade.instrumentSymbol || trade.assetName} />
        <Fact label="Lots" value={trade.lotSize.toFixed(2)} />
        <Fact label="Entry" value={String(trade.entryPrice)} />
        <Fact label="Exit" value={String(trade.exitPrice)} />
        <Fact label="P/L" value={`${trade.profit >= 0 ? "+" : "−"}$${money(Math.abs(trade.profit))}`} good={trade.profit >= 0} />
        <Fact label="SL" value={trade.slPrice != null ? String(trade.slPrice) : "—"} />
        <Fact label="TP" value={trade.tpPrice != null ? String(trade.tpPrice) : "—"} />
        <Fact label="R:R" value={rr != null ? String(rr) : "—"} />
        <Fact label="Opened" value={fmtDate(trade.timestamp)} />
        <Fact label="Closed" value={fmtDate(trade.exitTime ?? trade.timestamp)} />
        <Fact label="Source" value={trade.replay ? "Replay" : "Live terminal"} />
      </div>

      {/* rating */}
      <div className="flex items-center gap-3">
        <span className="text-[10px] uppercase tracking-wide text-slate-500">Trade rating</span>
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} onClick={() => setRating(rating === n ? 0 : n)} title={`${n} star${n > 1 ? "s" : ""}`}>
              <Star className={cn("h-5 w-5", n <= rating ? "fill-amber-400 text-amber-400" : "text-slate-600")} />
            </button>
          ))}
        </div>
      </div>

      {/* emotions */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Emotional state BEFORE</div>
          <div className="flex flex-wrap gap-1">
            {EMOTIONS.map((e) => <button key={e} onClick={() => setEmotionBefore(emotionBefore === e ? "" : e)} className={chip(emotionBefore === e)}>{e}</button>)}
          </div>
        </div>
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Emotional state AFTER</div>
          <div className="flex flex-wrap gap-1">
            {EMOTIONS.map((e) => <button key={e} onClick={() => setEmotionAfter(emotionAfter === e ? "" : e)} className={chip(emotionAfter === e)}>{e}</button>)}
          </div>
        </div>
      </div>

      {/* strategy + tags */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Strategy</div>
          <input value={strategy} onChange={(e) => setStrategy(e.target.value)} placeholder="e.g. London breakout, pullback continuation…"
            className={inputCls} />
        </div>
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Setup tags</div>
          <div className="flex gap-1">
            <input value={tagInput} onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
              placeholder="type + Enter"
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100" />
            <Button size="sm" variant="outline" onClick={addTag}>Add</Button>
          </div>
          {tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {tags.map((t) => (
                <span key={t} className="flex items-center gap-1 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-200">
                  {t}
                  <button onClick={() => setTags(tags.filter((x) => x !== t))}><X className="h-3 w-3" /></button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* mistakes */}
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Mistakes (click to toggle)</div>
        <div className="flex flex-wrap gap-1">
          {MISTAKE_PRESETS.map((m) => (
            <button
              key={m}
              onClick={() => setMistakes(mistakes.includes(m) ? mistakes.filter((x) => x !== m) : [...mistakes, m])}
              className={cn(mistakes.includes(m) ? chip(true) : chip(false), mistakes.includes(m) && "border-red-500/60 bg-red-500/15 text-red-300")}
            >{m}</button>
          ))}
        </div>
      </div>

      {/* notes */}
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Personal notes</div>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} placeholder="What did you see? How did the trade go?…"
            className={cn(inputCls, "resize-y")} />
        </div>
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Entry reason</div>
          <textarea value={entryReason} onChange={(e) => setEntryReason(e.target.value)} rows={2}
            className={cn(inputCls, "resize-y")} />
          <div className="mt-2 mb-1 text-[10px] uppercase tracking-wide text-slate-500">Lessons</div>
          <textarea value={lessons} onChange={(e) => setLessons(e.target.value)} rows={2}
            className={cn(inputCls, "resize-y")} />
        </div>
      </div>

      {/* screenshots */}
      <div>
        <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-slate-500">
          <span>Screenshots</span>
          <button onClick={() => fileRef.current?.click()} className="text-sky-400 hover:text-sky-300">+ add image</button>
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }} />
        <div className="flex flex-wrap gap-2">
          {trade.imageBase64 && (
            <img src={trade.imageBase64} alt="snapshot" className="h-20 rounded border border-slate-700" />
          )}
          {screenshots.map((s, i) => (
            <div key={i} className="relative">
              <img src={s} alt={`shot ${i + 1}`} className="h-20 rounded border border-slate-700" />
              <button
                onClick={() => setScreenshots(screenshots.filter((_, j) => j !== i))}
                className="absolute -right-1.5 -top-1.5 rounded-full bg-red-600 p-0.5"
              ><X className="h-3 w-3 text-white" /></button>
            </div>
          ))}
          {!trade.imageBase64 && screenshots.length === 0 && (
            <span className="text-xs text-slate-600">No screenshots yet — replay trades attach one automatically.</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-slate-800 pt-3">
        <Button
          onClick={() => onSave({
            comment: notes, tradingStrategy: strategy, entryReason, lessons,
            tags, mistakesList: mistakes,
            emotionBefore: emotionBefore || undefined, emotionAfter: emotionAfter || undefined,
            rating: rating > 0 ? rating : undefined,
            screenshots: screenshots.length ? screenshots : undefined,
          })}
          disabled={saving}
          className="bg-sky-600 hover:bg-sky-500"
        ><Save className="mr-1 h-3.5 w-3.5" /> {saving ? "Saving…" : "Save journal entry"}</Button>
        <Button variant="outline" onClick={onDelete} className="text-red-400 hover:text-red-300">
          <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete trade
        </Button>
        <span className="ml-auto text-[10px] text-slate-600">Stored in Firebase — visible only to you.</span>
      </div>
    </div>
  );
}

async function compressImage(file: File, maxW = 900): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxW / bitmap.width);
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.6);
  } catch { return null; }
}

const chip = (active: boolean) =>
  active
    ? "rounded-full bg-sky-600 px-2 py-0.5 text-[10px] font-medium text-white"
    : "rounded-full border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800";
const inputCls = "w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100";

function Fact({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cn("font-semibold", good === true ? "text-emerald-400" : good === false ? "text-red-400" : "text-slate-100")}>{value}</div>
    </div>
  );
}
