/**
 * Chart dialogs — settings, layouts, symbol search, indicator parameters and
 * drawing properties, plus the right-click context menu. All functional.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Eye, EyeOff, X } from "lucide-react";
import { INSTRUMENTS } from "@shared/terminal";
import {
  INDICATOR_CATALOG, INDICATOR_CATEGORY_LABELS, INDICATOR_CATEGORY_ORDER, indicatorLabel,
  sanitizeParams, sanitizeStyle, type IndicatorCategory, type IndicatorConfig, type IndicatorStyle, type IndicatorType,
} from "@/lib/indicators-config";
import type { Drawing } from "@/lib/drawings";
import type { LayoutSnapshot } from "@/lib/chart-persistence";
import { loadLayouts, deleteLayout } from "@/lib/chart-persistence";
import { cn } from "@/lib/utils";
import { ColorPicker } from "./ColorPicker";
import { TEXT_LIKE,  magnetModeOf } from "@/lib/drawings";
export { magnetModeOf };

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface ChartSettings {
  grid: boolean;
  countdown: boolean;
  legend: boolean;
  magnet: boolean;
  /** P46 §2 — 0=off · 1=normal · 2=strong (legacy `magnet` boolean maps) */
  magnetMode?: 0 | 1 | 2;
  bidAsk: boolean;
  upColor: string;
  downColor: string;
  // ---- Phase 34 appearance section (instrument settings panel) ----
  bgColor: string;
  gridColor: string;
  crosshairColor: string;
  // ---- P55 §7: fine-grained appearance (undefined = inherit the candle
  // colors / theme text — backward compatible with every saved setting)
  borderColor?: string;
  wickColor?: string;
  textColor?: string;
  // Phase 34: per-instrument override shadows merged from instrument settings
  precision?: number;
  lastPrice?: boolean;
  prevClose?: boolean;
  priceScaleSide?: "right" | "left";
  timezone?: string;
  // ---- drawing defaults (new objects take these) ----
  drawColor: string;
  drawWidth: number;
  drawDash: "solid" | "dashed" | "dotted";
  drawFontSize: number;
}

// TradingView-reference palette: light bullish / gray bearish candles on the
// dark charcoal background (users can restore green/red in chart settings)
// Phase 20: `volume` is no longer a setting — Volume became a real indicator
// (Indicators menu, persisted per user+symbol), off by default.
export const DEFAULT_SETTINGS: ChartSettings = {
  // the chart grid ships OFF for everyone — the background lines stay quiet
  // unless a user turns "Show grid" on in the settings.
  // PHASE 65 (user request) — TradingView-style FIRST-VISIT defaults: clean
  // white chart, classic green/red candles. Users who already saved settings
  // (localStorage it_chart_settings) keep their own values.
  grid: false, countdown: true, legend: true, magnet: true, magnetMode: 1, bidAsk: true,
  upColor: "#22c55e", downColor: "#ef4444",
  bgColor: "#ffffff", gridColor: "#e5e7eb", crosshairColor: "rgba(120,123,134,0.5)",
  drawColor: "#2962ff", drawWidth: 2, drawDash: "solid", drawFontSize: 12,
};

const GRID_OFF_MIGRATION_KEY = "it_grid_default_off";
/**
 * One-time migration: a stored `it_chart_settings` blob written while grid
 * defaulted to ON carries grid:true even for users who never chose it — the
 * marker makes sure this flip runs once and a user's later explicit choice
 * (re-enabling from settings) is respected afterwards.
 */
export function applyGridDefaultOff(s: ChartSettings): ChartSettings {
  try {
    if (localStorage.getItem(GRID_OFF_MIGRATION_KEY) === "1") return s;
    localStorage.setItem(GRID_OFF_MIGRATION_KEY, "1");
  } catch { /* private mode — still flip the default below */ }
  return { ...s, grid: false };
}

/** Phase 34: professional appearance presets — one click re-styles the chart. */
export const APPEARANCE_PRESETS: { id: string; label: string; s: Partial<ChartSettings> }[] = [
  { id: "inspire", label: "InspireTrade", s: { bgColor: "#0a0a0a", gridColor: "#171717", crosshairColor: "rgba(163,163,163,0.45)", upColor: "#e9edf4", downColor: "#9598a1" } },
  { id: "classic", label: "Classic Green", s: { bgColor: "#0a0a0a", gridColor: "#171717", crosshairColor: "rgba(163,163,163,0.45)", upColor: "#22c55e", downColor: "#ef4444" } },
  { id: "midnight", label: "Midnight", s: { bgColor: "#05070d", gridColor: "#101827", crosshairColor: "rgba(148,163,184,0.4)", upColor: "#26a69a", downColor: "#ef5350" } },
  { id: "contrast", label: "High Contrast", s: { bgColor: "#000000", gridColor: "#22262e", crosshairColor: "rgba(255,255,255,0.5)", upColor: "#4ade80", downColor: "#f87171" } },
  // Phase 34b — the five minimal TradingView-style themes from the reference
  // collection: pure black background, one accent bullish color, gray bearish.
  { id: "neon-lime", label: "Neon Lime", s: { bgColor: "#000000", gridColor: "#161616", crosshairColor: "rgba(156,156,156,0.45)", upColor: "#9afc41", downColor: "#9c9c9c" } },
  { id: "dusty-rose", label: "Dusty Rose", s: { bgColor: "#000000", gridColor: "#161616", crosshairColor: "rgba(156,156,156,0.45)", upColor: "#dd8ca0", downColor: "#9c9c9c" } },
  { id: "amber", label: "Amber", s: { bgColor: "#0c0c0c", gridColor: "#171717", crosshairColor: "rgba(156,156,156,0.45)", upColor: "#ffd63d", downColor: "#9c9c9c" } },
  { id: "steel-blue", label: "Steel Blue", s: { bgColor: "#000000", gridColor: "#161616", crosshairColor: "rgba(156,156,156,0.45)", upColor: "#738bae", downColor: "#9c9c9c" } },
  { id: "deep-forest", label: "Deep Forest", s: { bgColor: "#000000", gridColor: "#161616", crosshairColor: "rgba(219,219,219,0.4)", upColor: "#16302b", downColor: "#dbdbdb" } },
  // P77 user request — ICT (Inner Circle Trader) style themes: the color
  // schemes the ICT community actually trades on — deep navy backgrounds,
  // teal/cyan bullish candles against coral bearish ones, tuned for contrast
  // on the session-grid look.
  { id: "ict-classic", label: "ICT Classic", s: { bgColor: "#0b0e14", gridColor: "#1c2333", crosshairColor: "rgba(34,211,238,0.45)", upColor: "#0ecb81", downColor: "#f6465d" } },
  { id: "ict-midnight", label: "ICT Midnight", s: { bgColor: "#131722", gridColor: "#1e222d", crosshairColor: "rgba(120,123,134,0.5)", upColor: "#089981", downColor: "#f23645" } },
  { id: "ict-cyan", label: "ICT Cyan", s: { bgColor: "#050a12", gridColor: "#12202e", crosshairColor: "rgba(34,211,238,0.5)", upColor: "#22d3ee", downColor: "#f43f5e" } },
];

// ---------------------------------------------------------------------------
// Symbol search
// ---------------------------------------------------------------------------

export function SymbolSearchDialog({
  open, current, onClose, onSelect,
}: {
  open: boolean;
  current: string;
  onClose: () => void;
  onSelect: (symbol: string) => void;
}) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (open) { setQ(""); setTimeout(() => inputRef.current?.focus(), 50); } }, [open]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return INSTRUMENTS;
    return INSTRUMENTS.filter((i) => `${i.symbol} ${i.name}`.toLowerCase().includes(needle));
  }, [q]);
  if (!open) return null;
  return (
    <ChartDialog title="Symbol search" onClose={onClose}>
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search symbol or name…"
        className="num-input mb-2"
      />
      <div className="max-h-64 overflow-y-auto">
        {list.map((i) => (
          <button
            key={i.symbol}
            onClick={() => { onSelect(i.symbol); onClose(); }}
            className={cn(
              "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs hover:bg-slate-800",
              i.symbol === current && "bg-sky-500/10 text-sky-300",
            )}
          >
            <span className="font-semibold">{i.symbol}</span>
            <span className="text-slate-400">{i.name}</span>
            <span className="text-[10px] uppercase text-slate-500">{i.assetClass}</span>
          </button>
        ))}
        {!list.length && <p className="py-4 text-center text-xs text-slate-500">No match</p>}
      </div>
    </ChartDialog>
  );
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

export function LayoutsDialog({
  open, uid, onClose, onApply,
  currentSnapshot,
}: {
  open: boolean;
  uid: string | null;
  onClose: () => void;
  onApply: (snap: LayoutSnapshot) => void;
  currentSnapshot: Omit<LayoutSnapshot, "savedAt">;
}) {
  const [layouts, setLayouts] = useState<Record<string, LayoutSnapshot>>({});
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = () => { if (uid) void loadLayouts(uid).then(setLayouts).catch(() => setLayouts({})); };
  useEffect(() => { if (open && uid) refresh(); }, [open, uid]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;
  const save = async () => {
    if (!uid || !name.trim()) return;
    setBusy(true);
    try {
      const { saveLayout } = await import("@/lib/chart-persistence");
      await saveLayout(uid, name.trim().slice(0, 40), currentSnapshot);
      setName("");
      refresh();
    } finally { setBusy(false); }
  };
  const del = async (n: string) => {
    if (!uid) return;
    await deleteLayout(uid, n).catch(() => null);
    refresh();
  };
  return (
    <ChartDialog title="Chart layouts" onClose={onClose}>
      <div className="space-y-2 text-xs">
        <div className="flex gap-1.5">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Layout name…"
            className="num-input"
            onKeyDown={(e) => e.key === "Enter" && void save()}
          />
          <button onClick={() => void save()} disabled={busy || !name.trim() || !uid}
            className="rounded-lg bg-emerald-500 px-3 py-1.5 text-[11px] font-bold text-black disabled:opacity-40">
            Save current
          </button>
        </div>
        <p className="text-[10px] text-slate-500">A layout stores symbol, timeframe, indicators and chart settings.</p>
        <div className="max-h-56 overflow-y-auto">
          {Object.entries(layouts).sort((a, b) => b[1].savedAt - a[1].savedAt).map(([n, snap]) => (
            <div key={n} className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-slate-800">
              <div>
                <div className="font-semibold text-slate-200">{n}</div>
                <div className="text-[10px] text-slate-500">
                  {snap.symbol} · {snap.timeframe} · {snap.indicators?.length ?? 0} indicators
                </div>
              </div>
              <div className="flex gap-1">
                <button onClick={() => { onApply(snap); onClose(); }}
                  className="rounded border border-slate-600 px-2 py-0.5 text-[10px] font-semibold text-sky-300 hover:bg-sky-500/10">Load</button>
                <button onClick={() => void del(n)}
                  className="rounded border border-slate-600 px-2 py-0.5 text-[10px] font-semibold text-red-400 hover:bg-red-500/10">Delete</button>
              </div>
            </div>
          ))}
          {!Object.keys(layouts).length && <p className="py-4 text-center text-slate-500">No saved layouts yet.</p>}
        </div>
      </div>
    </ChartDialog>
  );
}

// ---------------------------------------------------------------------------
// Indicator parameters
// ---------------------------------------------------------------------------

export function IndicatorParamsDialog({
  config, onClose, onSave,
}: {
  config: IndicatorConfig | null;
  onClose: () => void;
  /** style is the optional per-instance line-style override (Phase 36 §2) */
  onSave: (id: string, params: Record<string, number | string>, style?: IndicatorStyle) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [styleDraft, setStyleDraft] = useState<IndicatorStyle>({});
  useEffect(() => {
    if (config) {
      const d: Record<string, string> = {};
      for (const p of INDICATOR_CATALOG[config.type].params) d[p.key] = String(config.params[p.key] ?? p.default);
      setDraft(d);
      setStyleDraft({ ...(config.style || {}) });
    }
  }, [config]);
  if (!config) return null;
  const meta = INDICATOR_CATALOG[config.type];
  const save = () => {
    const raw: Record<string, unknown> = {};
    for (const p of meta.params) {
      const v = draft[p.key];
      if (v !== undefined) raw[p.key] = p.kind === "number" ? Number(v) : v;
    }
    onSave(config.id, sanitizeParams(config.type, raw), sanitizeStyle(styleDraft));
    onClose();
  };
  const reset = () => {
    const d: Record<string, string> = {};
    for (const p of meta.params) d[p.key] = String(p.default);
    setDraft(d);
    setStyleDraft({});
  };
  const styleField = (label: string, node: React.ReactNode) => (
    <label>
      <span className="mb-0.5 block text-[10px] text-slate-400">{label}</span>
      {node}
    </label>
  );
  return (
    <ChartDialog title={meta.label} onClose={onClose}>
      <p className="mb-2 text-[10px] leading-snug text-slate-500">{meta.description}</p>
      <div className="grid grid-cols-2 gap-2 text-xs">
        {meta.params.map((p) => (
          <label key={p.key}>
            <span className="mb-0.5 block text-[10px] text-slate-400">{p.label}</span>
            {p.kind === "select" ? (
              <select
                value={draft[p.key] ?? ""}
                onChange={(e) => setDraft({ ...draft, [p.key]: e.target.value })}
                className="h-7 w-full rounded border border-slate-700 bg-slate-950"
              >
                {(p.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input
                type={p.kind === "number" ? "number" : "color"}
                min={p.min} max={p.max} step={p.step}
                value={draft[p.key] ?? ""}
                onChange={(e) => setDraft({ ...draft, [p.key]: e.target.value })}
                className={p.kind === "number" ? "num-input" : "h-7 w-full rounded border border-slate-700 bg-slate-950"}
              />
            )}
          </label>
        ))}
        {!meta.params.length && <p className="col-span-2 text-slate-500">This indicator has no parameters.</p>}
      </div>
      {/* Phase 36 §2 — per-instance line style (hidden for the volume histogram) */}
      {config.type !== "volume" && (
        <div className="mt-2 border-t border-slate-800 pt-2">
          <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Line style</p>
          <div className="grid grid-cols-3 gap-2 text-xs">
            {styleField("Width", (
              <select
                value={String(styleDraft.width ?? "")}
                onChange={(e) => setStyleDraft({ ...styleDraft, width: e.target.value ? Number(e.target.value) : undefined })}
                className="h-7 w-full rounded border border-slate-700 bg-slate-950"
              >
                <option value="">Default</option>
                {[1, 2, 3, 4].map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            ))}
            {styleField("Dash", (
              <select
                value={styleDraft.dash ?? ""}
                onChange={(e) => setStyleDraft({ ...styleDraft, dash: (e.target.value || undefined) as IndicatorStyle["dash"] })}
                className="h-7 w-full rounded border border-slate-700 bg-slate-950"
              >
                <option value="">Default</option>
                <option value="solid">solid</option>
                <option value="dashed">dashed</option>
                <option value="dotted">dotted</option>
              </select>
            ))}
            {styleField("Opacity", (
              <input
                type="number" min={0.1} max={1} step={0.05}
                value={styleDraft.opacity ?? ""}
                onChange={(e) => setStyleDraft({ ...styleDraft, opacity: e.target.value === "" ? undefined : Number(e.target.value) })}
                className="num-input"
              />
            ))}
          </div>
        </div>
      )}
      <div className="mt-3 flex items-center justify-between">
        {/* Phase 36 §3 — restore the catalog defaults */}
        <button onClick={reset} className="rounded-lg border border-slate-600 px-2 py-1 text-[10px] font-semibold text-slate-400 hover:text-slate-200">
          Restore defaults
        </button>
        <DialogFooter onCancel={onClose} onOk={save} okLabel="Save" />
      </div>
    </ChartDialog>
  );
}

// ---------------------------------------------------------------------------
// Phase 36 — searchable indicator library (§1/§7)
// ---------------------------------------------------------------------------

export function IndicatorLibraryDialog({
  open, onClose, active, volumeNote, onAdd, onConfigure, onToggle, onRemove, onRemoveAll,
}: {
  open: boolean;
  onClose: () => void;
  active: IndicatorConfig[];
  /** honest-volume note for non-crypto feeds (§1) */
  volumeNote?: string;
  onAdd: (type: IndicatorType) => void;
  onConfigure: (id: string) => void;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onRemoveAll: () => void;
}) {
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<"all" | IndicatorCategory>("all");
  useEffect(() => {
    if (open) { setQuery(""); setCat("all"); }
  }, [open]);
  if (!open) return null;
  const q = query.trim().toLowerCase();
  const metas = Object.values(INDICATOR_CATALOG).filter(
    (m) => (cat === "all" || m.category === cat) &&
      (!q || m.label.toLowerCase().includes(q) || m.description.toLowerCase().includes(q)),
  );
  const countByType = new Map<string, number>();
  for (const c of active) countByType.set(c.type, (countByType.get(c.type) || 0) + 1);
  return (
    <ChartDialog title="Indicators" onClose={onClose}>
      {/* search */}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search indicators…"
        className="mb-2 h-8 w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 text-xs outline-none placeholder:text-slate-600 focus:border-slate-500"
      />
      {/* category navigation */}
      <div className="mb-2 flex flex-wrap gap-1">
        <button
          onClick={() => setCat("all")}
          className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold", cat === "all" ? "border-sky-500/50 bg-sky-500/15 text-sky-300" : "border-slate-700 text-slate-400 hover:text-slate-200")}
        >
          All ({Object.keys(INDICATOR_CATALOG).length})
        </button>
        {INDICATOR_CATEGORY_ORDER.map((c) => (
          <button
            key={c}
            onClick={() => setCat(c)}
            className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold", cat === c ? "border-sky-500/50 bg-sky-500/15 text-sky-300" : "border-slate-700 text-slate-400 hover:text-slate-200")}
          >
            {INDICATOR_CATEGORY_LABELS[c]}
          </button>
        ))}
      </div>
      {/* honest-volume note (§1): tick/sample volume is not traded size */}
      {(cat === "volume" || q.includes("volume") || q.includes("obv") || q.includes("mfi") || q.includes("vwap")) && volumeNote && (
        <p className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-snug text-amber-300/90">{volumeNote}</p>
      )}
      {/* library list */}
      <div className="max-h-64 space-y-0.5 overflow-y-auto">
        {metas.length === 0 && (
          <p className="px-1 py-4 text-center text-xs text-slate-600">No indicator matches “{query}”</p>
        )}
        {metas.map((m) => {
          const n = countByType.get(m.type) || 0;
          return (
            <button
              key={m.type}
              onClick={() => { onAdd(m.type); }}
              className="flex w-full items-start justify-between gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-slate-800"
              title={m.description}
            >
              <span className="min-w-0">
                <span className="flex items-center gap-1.5">
                  <span className="text-[11px] font-semibold text-slate-200">{m.label}</span>
                  <span className="rounded bg-slate-800 px-1 text-[9px] uppercase text-slate-500">{m.pane === "main" ? "overlay" : "pane"}</span>
                  {n > 0 && <span className="rounded bg-sky-500/15 px-1 text-[9px] font-bold text-sky-300">×{n}</span>}
                </span>
                <span className="mt-0.5 block text-[10px] leading-snug text-slate-500">{m.description}</span>
              </span>
              <Plus className="mt-1 h-3.5 w-3.5 shrink-0 text-emerald-400" />
            </button>
          );
        })}
      </div>
      {/* active list */}
      <div className="mt-2 border-t border-slate-800 pt-2">
        <div className="mb-1 flex items-center justify-between">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Active · {active.length}</p>
          {active.length > 0 && (
            <button
              onClick={() => { if (window.confirm("Remove ALL indicators from this chart?")) { onRemoveAll(); } }}
              className="text-[10px] font-semibold text-red-400 hover:text-red-300"
            >
              Remove all
            </button>
          )}
        </div>
        <div className="max-h-28 space-y-0.5 overflow-y-auto">
          {active.length === 0 && <p className="px-1 py-2 text-center text-[11px] text-slate-600">No active indicators yet — add one above.</p>}
          {active.map((cfg) => (
            <div key={cfg.id} className="flex items-center gap-1 rounded px-1 py-0.5">
              <button onClick={() => onConfigure(cfg.id)} className="min-w-0 flex-1 truncate text-left text-[11px] text-slate-300 hover:text-sky-300" title="Edit parameters">
                {indicatorLabel(cfg)}
              </button>
              <button onClick={() => onToggle(cfg.id)} title={cfg.visible ? "Hide" : "Show"} className="text-slate-500 hover:text-slate-200">
                {cfg.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
              </button>
              <button onClick={() => onRemove(cfg.id)} title="Remove" className="text-slate-500 hover:text-red-400">
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </ChartDialog>
  );
}

// ---------------------------------------------------------------------------
// Drawing properties
// ---------------------------------------------------------------------------

export function DrawingPropsDialog({
  drawing, onClose, onSave,
}: {
  drawing: Drawing | null;
  onClose: () => void;
  onSave: (id: string, patch: Partial<Pick<Drawing, "style" | "text" | "hidden">>) => void;
}) {
  const [color, setColor] = useState("#38bdf8");
  const [width, setWidth] = useState(2);
  const [dash, setDash] = useState<Drawing["style"]["dash"]>("solid");
  const [text, setText] = useState("");
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (drawing) {
      setColor(drawing.style.color);
      setWidth(drawing.style.width);
      setDash(drawing.style.dash);
      setText(drawing.text ?? "");
      setVisible(!drawing.hidden);
    }
  }, [drawing]);
  if (!drawing) return null;
  return (
    <ChartDialog title="Drawing properties" onClose={onClose}>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <label><span className="mb-0.5 block text-[10px] text-slate-400">Color</span>
          <div className="pt-1"><ColorPicker value={color} onChange={setColor} title="Color" placement="bottom" /></div></label>
        <label><span className="mb-0.5 block text-[10px] text-slate-400">Line width</span>
          <select value={width} onChange={(e) => setWidth(Number(e.target.value))} className="num-input">
            {[1, 2, 3, 4].map((w) => <option key={w} value={w}>{w}px</option>)}
          </select></label>
        <label><span className="mb-0.5 block text-[10px] text-slate-400">Line style</span>
          <select value={dash} onChange={(e) => setDash(e.target.value as Drawing["style"]["dash"])} className="num-input">
            <option value="solid">Solid</option>
            <option value="dashed">Dashed</option>
            <option value="dotted">Dotted</option>
          </select></label>
        {/* PHASE 65 §4 — annotation support for EVERY drawing type: a
            multiline text field ("Strong Resistance\nSupply Zone"). For the
            dedicated text tools it is the object's own content; for all other
            tools it is the attached annotation that moves with the object. */}
        <label className="col-span-2"><span className="mb-0.5 block text-[10px] text-slate-400">Text annotation</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={200}
            placeholder="Add a description (multiline supported)…"
            className="num-input w-full resize-y" /></label>
        <label className="col-span-2 flex cursor-pointer items-center justify-between pt-1">
          <span className="text-slate-300">Visible on chart</span>
          <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} className="h-4 w-4 accent-sky-500" />
        </label>
      </div>
      <div className="mt-3">
        <DialogFooter
          onCancel={onClose}
          onOk={() => {
            // send ONLY the fields the user actually touched — the patch
            // deep-merges into the live drawing, so concurrent edits (e.g. a
            // move while the dialog is open) are never reverted by a stale
            // snapshot spread
            const style: Partial<Drawing["style"]> = {};
            if (color !== drawing.style.color) style.color = color;
            if (width !== drawing.style.width) style.width = width;
            if (dash !== drawing.style.dash) style.dash = dash;
            const patch: Parameters<typeof onSave>[1] = {};
            if (Object.keys(style).length) patch.style = style as Drawing["style"];
            if (!visible !== (drawing.hidden ?? false)) patch.hidden = !visible;
            // PHASE 65 §4 — every drawing type saves (or clears) its annotation
            if (text !== (drawing.text ?? "")) patch.text = text.length ? text.slice(0, 200) : undefined;
            onSave(drawing.id, patch);
            onClose();
          }}
          okLabel="Save"
        />
      </div>
    </ChartDialog>
  );
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

export interface ContextMenuState {
  x: number; y: number;
  /** clientX/clientY for positioning */
  clientX: number; clientY: number;
  hitDrawingId: string | null;
  /** the hit drawing's visibility — labels the hide/show action */
  hitHidden?: boolean;
  /** PHASE 65 §4 — the hit drawing carries an annotation */
  hitHasText?: boolean;
  /** market coordinates at the click — for add-hline/add-text */
  time: number | null;
  price: number | null;
}

export function ChartContextMenu({
  state, onClose, actions,
}: {
  state: ContextMenuState | null;
  onClose: () => void;
  actions: {
    addHLine: (price: number) => void;
    addText: (time: number, price: number) => void;
    deleteDrawing: (id: string) => void;
    duplicateDrawing: (id: string) => void;
    /** P66 §7 — z-order also lives in the context menu (parity with the
     *  object tree; no separate settings UI per tool) */
    bringToFront: (id: string) => void;
    sendToBack: (id: string) => void;
    toggleHide: (id: string) => void;
    /** PHASE 65 §4 — open the properties dialog on the annotation field */
    editDrawingText: (id: string) => void;
    /** clear the attached annotation */
    removeDrawingText: (id: string) => void;
    clearDrawings: () => void;
    /** Phase 36 §6 — Remove All Indicators (with confirmation inside) */
    clearIndicators: () => void;
    resetChart: () => void;
    /** PHASE 47 — open the trading-alert dialog prefilled at this price */
    addAlert?: (price: number) => void;
  };
}) {
  // Close on OUTSIDE pointerdown only. The capture-phase listener used to
  // close on EVERY pointerdown — including the one on a menu item — which
  // unmounted the menu before pointerup, so onClick never fired and
  // "Delete drawing" (and every other action) silently did nothing.
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!state) return;
    const close = (e: PointerEvent) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      onClose();
    };
    const closeAny = () => onClose();
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("wheel", closeAny, true);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("wheel", closeAny, true);
    };
  }, [state, onClose]);
  if (!state) return null;
  const items: { label: string; danger?: boolean; onClick: () => void }[] = [];
  if (state.hitDrawingId) {
    items.push({ label: state.hitHidden ? "Show drawing" : "Hide drawing", onClick: () => actions.toggleHide(state.hitDrawingId!) });
    items.push({ label: "Duplicate drawing", onClick: () => actions.duplicateDrawing(state.hitDrawingId!) });
    items.push({ label: "Bring to front", onClick: () => actions.bringToFront(state.hitDrawingId!) });
    items.push({ label: "Send to back", onClick: () => actions.sendToBack(state.hitDrawingId!) });
    // PHASE 65 §4 — annotation actions on ANY drawing: add/edit opens the
    // properties dialog on the (multiline) text field; remove clears it
    items.push({ label: "Add/Edit annotation…", onClick: () => actions.editDrawingText(state.hitDrawingId!) });
    if (state.hitHasText) items.push({ label: "Remove annotation", danger: true, onClick: () => actions.removeDrawingText(state.hitDrawingId!) });
    items.push({ label: "Delete drawing", danger: true, onClick: () => actions.deleteDrawing(state.hitDrawingId!) });
  }
  if (state.price != null) {
    items.push({ label: "Add horizontal line", onClick: () => actions.addHLine(state.price!) });
    if (actions.addAlert) items.push({ label: "Add price alert", onClick: () => actions.addAlert!(state.price!) });
  }
  if (state.time != null && state.price != null) {
    items.push({ label: "Add text annotation", onClick: () => actions.addText(state.time!, state.price!) });
  }
  items.push({ label: "Clear all drawings", danger: true, onClick: actions.clearDrawings });
  items.push({ label: "Remove all indicators", danger: true, onClick: actions.clearIndicators });
  items.push({ label: "Reset chart view", onClick: actions.resetChart });

  const style: React.CSSProperties = {
    left: Math.min(state.clientX, window.innerWidth - 190),
    top: Math.min(state.clientY, window.innerHeight - items.length * 30 - 20),
  };
  return (
    <div ref={menuRef} style={style} className="fixed z-50 w-44 rounded-lg border border-slate-700 bg-slate-900 py-1 shadow-2xl">
      {items.map((it) => (
        <button
          key={it.label}
          onClick={() => { it.onClick(); onClose(); }}
          className={cn(
            "block w-full px-3 py-1.5 text-left text-xs hover:bg-slate-800",
            it.danger ? "text-red-400" : "text-slate-300",
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared shell
// ---------------------------------------------------------------------------

function ChartDialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onPointerDown={onClose}>
      <div
        className="w-[360px] max-w-[92vw] rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-2xl"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-bold text-slate-100">{title}</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function DialogFooter({ onCancel, onOk, okLabel }: { onCancel: () => void; onOk: () => void; okLabel: string }) {
  return (
    <div className="flex justify-end gap-1.5">
      <button onClick={onCancel} className="rounded-lg border border-slate-600 px-3 py-1.5 text-[11px] font-semibold text-slate-400 hover:text-slate-200">Cancel</button>
      <button onClick={onOk} className="rounded-lg bg-emerald-500 px-3 py-1.5 text-[11px] font-bold text-black hover:bg-emerald-400">{okLabel}</button>
    </div>
  );
}
