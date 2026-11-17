/**
 * Chart dialogs — settings, layouts, symbol search, indicator parameters and
 * drawing properties, plus the right-click context menu. All functional.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { INSTRUMENTS } from "@shared/terminal";
import {
  INDICATOR_CATALOG, sanitizeParams, type IndicatorConfig,
} from "@/lib/indicators-config";
import type { Drawing } from "@/lib/drawings";
import type { LayoutSnapshot } from "@/lib/chart-persistence";
import { loadLayouts, deleteLayout } from "@/lib/chart-persistence";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface ChartSettings {
  grid: boolean;
  countdown: boolean;
  legend: boolean;
  magnet: boolean;
  volume: boolean;
  bidAsk: boolean;
  upColor: string;
  downColor: string;
}

export const DEFAULT_SETTINGS: ChartSettings = {
  grid: true, countdown: true, legend: true, magnet: false, volume: true, bidAsk: true,
  upColor: "#22c55e", downColor: "#ef4444",
};

export function SettingsDialog({
  open, settings, onClose, onSave,
}: {
  open: boolean;
  settings: ChartSettings;
  onClose: () => void;
  onSave: (s: ChartSettings) => void;
}) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => { if (open) setDraft(settings); }, [open, settings]);
  if (!open) return null;
  const toggles: [keyof ChartSettings, string][] = [
    ["grid", "Show grid"], ["legend", "OHLC legend"], ["countdown", "Candle-close countdown"],
    ["magnet", "Magnet crosshair"], ["volume", "Volume histogram"], ["bidAsk", "Bid / Ask price lines"],
  ];
  return (
    <ChartDialog title="Chart settings" onClose={onClose}>
      <div className="space-y-2 text-xs">
        {toggles.map(([key, label]) => (
          <label key={key} className="flex cursor-pointer items-center justify-between">
            <span className="text-slate-300">{label}</span>
            <input
              type="checkbox"
              checked={Boolean(draft[key])}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })}
              className="h-4 w-4 accent-sky-500"
            />
          </label>
        ))}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <label><span className="mb-0.5 block text-[10px] text-slate-400">Up candle</span>
            <input type="color" value={draft.upColor} onChange={(e) => setDraft({ ...draft, upColor: e.target.value })} className="h-7 w-full rounded border border-slate-700 bg-slate-950" /></label>
          <label><span className="mb-0.5 block text-[10px] text-slate-400">Down candle</span>
            <input type="color" value={draft.downColor} onChange={(e) => setDraft({ ...draft, downColor: e.target.value })} className="h-7 w-full rounded border border-slate-700 bg-slate-950" /></label>
        </div>
        <DialogFooter
          onCancel={onClose}
          onOk={() => { onSave(draft); onClose(); }}
          okLabel="Apply"
        />
      </div>
    </ChartDialog>
  );
}

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
  onSave: (id: string, params: Record<string, number | string>) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    if (config) {
      const d: Record<string, string> = {};
      for (const p of INDICATOR_CATALOG[config.type].params) d[p.key] = String(config.params[p.key] ?? p.default);
      setDraft(d);
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
    onSave(config.id, sanitizeParams(config.type, raw));
    onClose();
  };
  return (
    <ChartDialog title={meta.label} onClose={onClose}>
      <div className="grid grid-cols-2 gap-2 text-xs">
        {meta.params.map((p) => (
          <label key={p.key}>
            <span className="mb-0.5 block text-[10px] text-slate-400">{p.label}</span>
            <input
              type={p.kind === "number" ? "number" : "color"}
              min={p.min} max={p.max} step={p.step}
              value={draft[p.key] ?? ""}
              onChange={(e) => setDraft({ ...draft, [p.key]: e.target.value })}
              className={p.kind === "number" ? "num-input" : "h-7 w-full rounded border border-slate-700 bg-slate-950"}
            />
          </label>
        ))}
        {!meta.params.length && <p className="col-span-2 text-slate-500">This indicator has no parameters.</p>}
      </div>
      <div className="mt-3">
        <DialogFooter onCancel={onClose} onOk={save} okLabel="Save" />
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
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-7 w-full rounded border border-slate-700 bg-slate-950" /></label>
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
        {drawing.type === "text" && (
          <label className="col-span-2"><span className="mb-0.5 block text-[10px] text-slate-400">Text</span>
            <input value={text} onChange={(e) => setText(e.target.value)} className="num-input" /></label>
        )}
        <label className="col-span-2 flex cursor-pointer items-center justify-between pt-1">
          <span className="text-slate-300">Visible on chart</span>
          <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} className="h-4 w-4 accent-sky-500" />
        </label>
      </div>
      <div className="mt-3">
        <DialogFooter
          onCancel={onClose}
          onOk={() => { onSave(drawing.id, { style: { ...drawing.style, color, width, dash }, hidden: !visible, ...(drawing.type === "text" ? { text: text.slice(0, 200) } : {}) }); onClose(); }}
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
    toggleHide: (id: string) => void;
    clearDrawings: () => void;
    resetChart: () => void;
  };
}) {
  useEffect(() => {
    if (!state) return;
    const close = () => onClose();
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("wheel", close, true);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("wheel", close, true);
    };
  }, [state, onClose]);
  if (!state) return null;
  const items: { label: string; danger?: boolean; onClick: () => void }[] = [];
  if (state.hitDrawingId) {
    items.push({ label: state.hitHidden ? "Show drawing" : "Hide drawing", onClick: () => actions.toggleHide(state.hitDrawingId!) });
    items.push({ label: "Delete drawing", danger: true, onClick: () => actions.deleteDrawing(state.hitDrawingId!) });
  }
  if (state.price != null) {
    items.push({ label: "Add horizontal line", onClick: () => actions.addHLine(state.price!) });
  }
  if (state.time != null && state.price != null) {
    items.push({ label: "Add text annotation", onClick: () => actions.addText(state.time!, state.price!) });
  }
  items.push({ label: "Clear all drawings", danger: true, onClick: actions.clearDrawings });
  items.push({ label: "Reset chart view", onClick: actions.resetChart });

  const style: React.CSSProperties = {
    left: Math.min(state.clientX, window.innerWidth - 190),
    top: Math.min(state.clientY, window.innerHeight - items.length * 30 - 20),
  };
  return (
    <div style={style} className="fixed z-50 w-44 rounded-lg border border-slate-700 bg-slate-900 py-1 shadow-2xl">
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
