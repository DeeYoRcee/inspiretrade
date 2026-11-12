/**
 * ReplayJournalDialog (§8) — after a simulated replay trade closes, record
 * the qualitative review (strategy, entry/exit reasons, market structure,
 * psychology, mistakes, lessons, chart screenshot) and save it into the
 * EXISTING InspireTrade journal (`trades/{uid}` via useAddTrade) — no
 * duplicate journal system. Auto-filled fields come from the engine record.
 */
import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Camera, Trash2 } from "lucide-react";
import { useAddTrade } from "@/hooks/use-trades";
import { getInstrument } from "@shared/terminal";
import type { ReplayClosedTrade } from "@/lib/terminal/replay-engine";
import { cn } from "@/lib/utils";

export interface JournalDraft {
  trade: ReplayClosedTrade;
  sessionId: string;
  symbol: string;
  timeframe: string;
  captureChart: () => string | null;
}

const FIELDS: { key: "tradingStrategy" | "entryReason" | "exitReason" | "marketStructure" | "psychology" | "mistakes" | "lessons"; label: string; placeholder: string }[] = [
  { key: "tradingStrategy", label: "Strategy", placeholder: "e.g. London breakout continuation…" },
  { key: "entryReason", label: "Entry reason", placeholder: "Why did you enter?" },
  { key: "exitReason", label: "Exit reason", placeholder: "Why did you exit?" },
  { key: "marketStructure", label: "Market structure", placeholder: "Trend / range / key levels…" },
  { key: "psychology", label: "Psychological condition", placeholder: "Calm, FOMO, revenge-trade…" },
  { key: "mistakes", label: "Mistakes", placeholder: "What went wrong?" },
  { key: "lessons", label: "Lessons learned", placeholder: "What will you do differently?" },
];

export function ReplayJournalDialog({ draft, onClose }: { draft: JournalDraft | null; onClose: () => void }) {
  const addTrade = useAddTrade();
  const [notes, setNotes] = useState<Partial<Record<(typeof FIELDS)[number]["key"], string>>>({});
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  const t = draft?.trade;
  const digits = useMemo(() => (draft ? getInstrument(draft.symbol)?.digits ?? 4 : 4), [draft]);
  const rr = t?.rrAtEntry ?? (t && t.entry && draft ? null : null);

  if (!draft || !t) return null;

  const capture = () => {
    const data = draft.captureChart();
    if (data) setScreenshot(data);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await addTrade.mutateAsync({
        assetName: draft.symbol,
        entryPrice: t.entry,
        exitPrice: t.exit,
        lotSize: t.lots,
        profit: t.pnl,
        type: t.side === "buy" ? "BUY" : "SELL",
        category: getInstrument(draft.symbol)?.assetClass === "crypto" ? "CRYPTO" : "FOREX",
        timestamp: t.entryTime * 1000,
        imageBase64: screenshot ?? undefined,
        instrumentSymbol: draft.symbol,
        instrumentName: getInstrument(draft.symbol)?.name ?? draft.symbol,
        replay: true,
        replaySessionId: draft.sessionId,
        exitTime: t.exitTime * 1000,
        slPrice: null,
        tpPrice: null,
        riskReward: rr,
        ...notes,
      } as any);
      setDone(true);
      setTimeout(onClose, 900);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-border/60 bg-[#0d1117] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Journal this replay trade</DialogTitle>
        </DialogHeader>

        {/* auto-saved trade facts */}
        <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-border/50 bg-card/40 p-2.5 text-[10px]">
          <Fact label="Instrument" value={`${draft.symbol} ${draft.timeframe}`} />
          <Fact label="Direction" value={t.side === "buy" ? "LONG" : "SHORT"} />
          <Fact label="Lots" value={String(t.lots)} />
          <Fact label="Entry" value={t.entry.toFixed(digits)} />
          <Fact label="Exit" value={t.exit.toFixed(digits)} />
          <Fact label="P/L" value={`${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}`} />
          <Fact label="Entry time" value={new Date(t.entryTime * 1000).toLocaleString()} />
          <Fact label="Exit time" value={new Date(t.exitTime * 1000).toLocaleString()} />
          <Fact label="Exit by" value={t.reason.toUpperCase()} />
          <Fact label="Pips" value={String(t.pips)} />
          <Fact label="R:R planned" value={rr != null ? `1:${rr}` : "—"} />
          <Fact label="Fees" value={`$${t.fees.toFixed(2)}`} />
        </div>

        <div className="space-y-1.5">
          {FIELDS.map((f) => (
            <label key={f.key} className="block">
              <span className="text-[10px] text-muted-foreground">{f.label}</span>
              <textarea rows={2} value={notes[f.key] ?? ""} placeholder={f.placeholder}
                onChange={(e) => setNotes((n) => ({ ...n, [f.key]: e.target.value }))}
                className="num-input mt-0.5 w-full" />
            </label>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button onClick={capture} className="flex items-center gap-1 rounded-lg border border-border/60 px-2 py-1.5 text-[10px] font-bold text-muted-foreground hover:text-foreground">
            <Camera className="h-3 w-3" />Capture chart
          </button>
          {screenshot && (
            <div className="flex items-center gap-1.5">
              <img src={screenshot} alt="chart" className="h-10 w-16 rounded border border-border/50 object-cover" />
              <button onClick={() => setScreenshot(null)} className="text-muted-foreground hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
            </div>
          )}
        </div>

        <button onClick={save} disabled={saving || done}
          className={cn("w-full rounded-lg py-2 text-xs font-black", done ? "bg-emerald-500/25 text-emerald-300" : "bg-sky-500/25 text-sky-300 hover:bg-sky-500/35")}>
          {done ? "Saved to journal ✓" : saving ? "Saving…" : "Save to journal"}
        </button>
        <p className="text-[9px] text-muted-foreground">Saved into your existing InspireTrade journal (tagged “replay”), so it appears in your normal journal, stats and calendar.</p>
      </DialogContent>
    </Dialog>
  );
}

const Fact = ({ label, value }: { label: string; value: string }) => (
  <div>
    <div className="text-[9px] uppercase text-muted-foreground">{label}</div>
    <div className="font-number truncate">{value}</div>
  </div>
);
