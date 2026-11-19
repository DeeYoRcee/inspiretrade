/**
 * TerminalSettingsDialog — the unified terminal settings surface (Phase 21 §5/§6).
 *
 * Left category navigation, right content, live search across the visible
 * section, per-section reset and a confirmed reset-all. Every control is
 * wired to its real store: terminal-settings (general/appearance/trading),
 * the chart's own stores (it_chart_settings / it_chart_scale /
 * it_cursor_mode — changes broadcast live to the open chart), per-instrument
 * overrides (instrument-settings) and the alerts store (notifications.ts).
 * Data & Connectivity and Shortcuts are honest read-only surfaces.
 */
import { useEffect, useMemo, useState } from "react";
import { INSTRUMENTS, TIMEFRAMES, getInstrument } from "@shared/terminal";
import { cn } from "@/lib/utils";
import {
  DEFAULT_TERMINAL_SETTINGS, useTerminalSettings, updateTerminalSettings,
  resetTerminalSettings, type TerminalSettingsSection,
} from "@/lib/terminal-settings";
import {
  useInstrumentSettings, updateInstrumentSettings, resetInstrumentSettings,
  type InstrumentSettings,
} from "@/lib/instrument-settings";
import { loadAlertSettings, saveAlertSettings } from "@/lib/notifications";
import { useTheme, THEMES, THEME_LABELS } from "@/lib/theme-context";
import { useQuotes } from "@/lib/quotes-context";
import { marketStatus } from "@/lib/market-status";
import type { ChartSettings } from "@/components/terminal/chart/dialogs";
import { DEFAULT_SETTINGS } from "@/components/terminal/chart/dialogs";

const SECTIONS = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "chart", label: "Chart" },
  { id: "instrument", label: "Instrument" },
  { id: "trading", label: "Trading" },
  { id: "notifications", label: "Notifications" },
  { id: "data", label: "Data & Connectivity" },
  { id: "shortcuts", label: "Shortcuts" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

// tiny dark primitives (match the chart dialog chrome) ----------------------

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5" data-setting-row={label.toLowerCase()}>
      <div className="min-w-0">
        <p className="text-xs text-slate-200">{label}</p>
        {hint && <p className="text-[10px] leading-snug text-slate-500">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 rounded-full transition-colors",
        checked ? "bg-emerald-500" : "bg-slate-700",
      )}
    >
      <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all", checked ? "left-4.5 translate-x-0" : "left-0.5")} style={{ left: checked ? 18 : 2 }} />
    </button>
  );
}

function Select({ value, onChange, options, label }: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  label: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 min-w-[110px] rounded border border-slate-700 bg-slate-950 px-1.5 text-xs text-slate-200 focus:outline-none"
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function TextField({ value, onChange, placeholder, label, width }: {
  value: string; onChange: (v: string) => void; placeholder?: string; label: string; width?: string;
}) {
  return (
    <input
      aria-label={label}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={cn("h-7 rounded border border-slate-700 bg-slate-950 px-2 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none", width || "w-40")}
    />
  );
}

function ColorField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <input
      type="color"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 w-14 cursor-pointer rounded border border-slate-700 bg-slate-950"
    />
  );
}

function SectionHeader({ title, onReset }: { title: string; onReset?: () => void }) {
  return (
    <div className="mb-1 flex items-center justify-between">
      <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{title}</h4>
      {onReset && (
        <button onClick={onReset} className="text-[10px] font-semibold text-slate-500 hover:text-red-400">Reset section</button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// main dialog
// ---------------------------------------------------------------------------

export function TerminalSettingsDialog({ open, onClose, symbol }: {
  open: boolean;
  onClose: () => void;
  /** the terminal's current instrument — the Instrument section preselects it */
  symbol: string;
}) {
  const ts = useTerminalSettings();
  const { theme, setTheme } = useTheme();
  const [section, setSection] = useState<SectionId>("general");
  const [q, setQ] = useState("");
  const [chartCfg, setChartCfg] = useState<ChartSettings>(loadChartCfg);
  const [scaleMode, setScaleMode] = useState(() => localStorage.getItem("it_chart_scale") || "normal");
  const [cursorMode, setCursorMode] = useState(() => localStorage.getItem("it_cursor_mode") || "cross");
  const [alerts, setAlerts] = useState(() => loadAlertSettings());
  const [instrSymbol, setInstrSymbol] = useState(symbol);
  const [confirmResetAll, setConfirmResetAll] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => { if (open) { setInstrSymbol(symbol); setQ(""); } }, [open, symbol]);
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => tick((n) => n + 1), 5000); // freshness labels
    return () => clearInterval(t);
  }, [open]);

  if (!open) return null;

  const matches = (label: string) => !q.trim() || label.toLowerCase().includes(q.trim().toLowerCase());
  const Show = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) =>
    matches(label) ? <Row label={label} hint={hint}>{children}</Row> : null;

  // ---- chart settings writers (broadcast to the open chart) ----
  const saveChartCfg = (patch: Partial<ChartSettings>) => {
    const next = { ...chartCfg, ...patch };
    setChartCfg(next);
    try { localStorage.setItem("it_chart_settings", JSON.stringify(next)); } catch { /* private mode */ }
    window.dispatchEvent(new CustomEvent("it_chart_settings_changed", { detail: next }));
  };
  const saveScale = (v: string) => {
    setScaleMode(v);
    try { localStorage.setItem("it_chart_scale", v); } catch { /* private mode */ }
    window.dispatchEvent(new CustomEvent("it_chart_aux_changed", { detail: { scaleMode: v } }));
  };
  const saveCursor = (v: string) => {
    setCursorMode(v);
    try { localStorage.setItem("it_cursor_mode", v); } catch { /* private mode */ }
    window.dispatchEvent(new CustomEvent("it_chart_aux_changed", { detail: { cursorMode: v } }));
  };
  const saveAlerts = (patch: Partial<typeof alerts>) => {
    const next = { ...alerts, ...patch };
    setAlerts(next);
    saveAlertSettings(next);
  };

  const resetSection = (id: SectionId) => {
    if (id === "general" || id === "appearance" || id === "trading") resetTerminalSettings(id as TerminalSettingsSection);
    if (id === "chart") { saveChartCfg({ ...DEFAULT_SETTINGS }); saveScale("normal"); saveCursor("cross"); }
    if (id === "instrument") resetInstrumentSettings(instrSymbol);
    if (id === "notifications") saveAlerts({ enabled: true, browser: false, calEnabled: true, calMinutesBefore: 30 });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onPointerDown={onClose}>
      <div
        className="flex h-[560px] max-h-[94vh] w-[860px] max-w-[96vw] overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* left nav */}
        <div className="flex w-44 shrink-0 flex-col border-r border-slate-800 bg-slate-950/60">
          <div className="border-b border-slate-800 p-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search settings…"
              className="h-7 w-full rounded border border-slate-700 bg-slate-950 px-2 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none"
            />
          </div>
          <nav className="flex-1 overflow-y-auto p-1.5">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                className={cn(
                  "mb-0.5 flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-xs font-semibold transition-colors",
                  section === s.id ? "bg-sky-500/15 text-sky-300" : "text-slate-400 hover:bg-slate-800/70 hover:text-slate-200",
                )}
              >
                {s.label}
              </button>
            ))}
          </nav>
          <div className="border-t border-slate-800 p-2">
            <button
              onClick={() => setConfirmResetAll(true)}
              className="w-full rounded-md border border-red-900/60 px-2 py-1.5 text-[11px] font-semibold text-red-400 hover:bg-red-500/10"
            >
              Reset all settings
            </button>
          </div>
        </div>

        {/* right content */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
            <h3 className="text-sm font-bold text-slate-100">{SECTIONS.find((s) => s.id === section)?.label} settings</h3>
            <button onClick={onClose} className="px-2 text-slate-500 hover:text-slate-200">✕</button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-2">
            {section === "general" && (
              <div className="divide-y divide-slate-800/60">
                <SectionHeader title="Terminal defaults" onReset={() => resetSection("general")} />
                <Show label="Default instrument">
                  <Select label="Default instrument" value={ts.general.defaultSymbol}
                    options={INSTRUMENTS.map((i) => ({ value: i.symbol, label: `${i.symbol} — ${i.name}` }))}
                    onChange={(v) => updateTerminalSettings({ general: { defaultSymbol: v } })} />
                </Show>
                <Show label="Default timeframe">
                  <Select label="Default timeframe" value={ts.general.defaultTf}
                    options={TIMEFRAMES.map((tf) => ({ value: tf, label: tf.toUpperCase() }))}
                    onChange={(v) => updateTerminalSettings({ general: { defaultTf: v as typeof ts.general.defaultTf } })} />
                </Show>
                <Show label="Timezone" hint="IANA name (e.g. Asia/Tashkent) — empty = browser zone">
                  <TextField label="Timezone" value={ts.general.timezone} placeholder="(browser default)"
                    onChange={(v) => updateTerminalSettings({ general: { timezone: v.trim() } })} />
                </Show>
                <Show label="Number format" hint="Grouped shows 1 234.56 with thin spaces">
                  <Select label="Number format" value={ts.general.numberFormat}
                    options={[{ value: "plain", label: "Plain" }, { value: "grouped", label: "Grouped" }]}
                    onChange={(v) => updateTerminalSettings({ general: { numberFormat: v as "plain" | "grouped" } })} />
                </Show>
                <Show label="Language" hint="Managed in the navbar language menu and Settings page (en/ru/uz/ar)">
                  <span className="text-[10px] text-slate-500">see Language section</span>
                </Show>
              </div>
            )}

            {section === "appearance" && (
              <div className="divide-y divide-slate-800/60">
                <SectionHeader title="Look & feel" onReset={() => resetSection("appearance")} />
                <Show label="Theme">
                  <Select label="Theme" value={theme}
                    options={THEMES.map((t) => ({ value: t, label: THEME_LABELS[t] || t }))}
                    onChange={(v) => setTheme(v as typeof theme)} />
                </Show>
                <Show label="Font size" hint={`${ts.appearance.fontSize}px base UI text`}>
                  <input type="range" min={12} max={16} step={1} value={ts.appearance.fontSize}
                    onChange={(e) => updateTerminalSettings({ appearance: { fontSize: Number(e.target.value) } })}
                    className="w-32 accent-sky-500" aria-label="Font size" />
                </Show>
                <Show label="Interface density">
                  <Select label="Interface density" value={ts.appearance.density}
                    options={[{ value: "compact", label: "Compact" }, { value: "cozy", label: "Cozy" }]}
                    onChange={(v) => updateTerminalSettings({ appearance: { density: v as "compact" | "cozy" } })} />
                </Show>
                <Show label="Animated theme backdrops" hint="Video backgrounds for Money Rain / F1 / Knight themes">
                  <Toggle label="Animated theme backdrops" checked={ts.appearance.themeBackdrop}
                    onChange={(v) => updateTerminalSettings({ appearance: { themeBackdrop: v } })} />
                </Show>
              </div>
            )}

            {section === "chart" && (
              <div className="divide-y divide-slate-800/60">
                <SectionHeader title="Global chart" onReset={() => resetSection("chart")} />
                <Show label="Show grid"><Toggle label="Show grid" checked={chartCfg.grid} onChange={(v) => saveChartCfg({ grid: v })} /></Show>
                <Show label="OHLC legend"><Toggle label="OHLC legend" checked={chartCfg.legend} onChange={(v) => saveChartCfg({ legend: v })} /></Show>
                <Show label="Candle-close countdown"><Toggle label="Candle-close countdown" checked={chartCfg.countdown} onChange={(v) => saveChartCfg({ countdown: v })} /></Show>
                <Show label="Magnet crosshair"><Toggle label="Magnet crosshair" checked={chartCfg.magnet} onChange={(v) => saveChartCfg({ magnet: v })} /></Show>
                <Show label="Bid/Ask price lines"><Toggle label="Bid/Ask price lines" checked={chartCfg.bidAsk} onChange={(v) => saveChartCfg({ bidAsk: v })} /></Show>
                <Show label="Price scale">
                  <Select label="Price scale" value={scaleMode}
                    options={[{ value: "normal", label: "Normal" }, { value: "log", label: "Logarithmic" }, { value: "percent", label: "Percent" }]}
                    onChange={saveScale} />
                </Show>
                <Show label="Crosshair">
                  <Select label="Crosshair" value={cursorMode}
                    options={[{ value: "cross", label: "Cross" }, { value: "dot", label: "Dot" }, { value: "arrow", label: "Arrow" }]}
                    onChange={saveCursor} />
                </Show>
                <Show label="Up candle (global default)" hint="Per-instrument colors live in the Instrument section">
                  <ColorField label="Up candle" value={chartCfg.upColor} onChange={(v) => saveChartCfg({ upColor: v })} />
                </Show>
                <Show label="Down candle (global default)">
                  <ColorField label="Down candle" value={chartCfg.downColor} onChange={(v) => saveChartCfg({ downColor: v })} />
                </Show>
                <Show label="Historical loading" hint="Charts load up to 1000 recent bars; metals self-record + Twelve Data backfill fills gaps">
                  <span className="text-[10px] text-slate-500">automatic</span>
                </Show>
                <Show label="Drawing defaults" hint="Color/width/style/one-shot live in the chart's own settings dialog">
                  <span className="text-[10px] text-slate-500">chart toolbar ⚙</span>
                </Show>
              </div>
            )}

            {section === "instrument" && <InstrumentSection instrSymbol={instrSymbol} setInstrSymbol={setInstrSymbol} matches={matches} onReset={() => resetSection("instrument")} />}

            {section === "trading" && (
              <div className="divide-y divide-slate-800/60">
                <SectionHeader title="Order defaults" onReset={() => resetSection("trading")} />
                <Show label="Default order type">
                  <Select label="Default order type" value={ts.trading.defaultOrderType}
                    options={[{ value: "market", label: "Market" }, { value: "limit", label: "Limit" }]}
                    onChange={(v) => updateTerminalSettings({ trading: { defaultOrderType: v as "market" | "limit" } })} />
                </Show>
                <Show label="Default lot size" hint="Pre-filled in the ticket (instrument override wins)">
                  <TextField label="Default lot size" value={ts.trading.defaultLot}
                    onChange={(v) => updateTerminalSettings({ trading: { defaultLot: v } })} width="w-24" />
                </Show>
                <Show label="Default risk %" hint="Used by the ticket's size-by-risk helper">
                  <TextField label="Default risk %" value={ts.trading.defaultRisk}
                    onChange={(v) => updateTerminalSettings({ trading: { defaultRisk: v } })} width="w-24" />
                </Show>
                <Show label="Confirm orders" hint="Ask before every market order">
                  <Toggle label="Confirm orders" checked={ts.trading.confirmOrders}
                    onChange={(v) => updateTerminalSettings({ trading: { confirmOrders: v } })} />
                </Show>
                <Show label="One-click trading" hint="Fire market orders instantly — confirmation is skipped (event warnings still confirm)">
                  <Toggle label="One-click trading" checked={ts.trading.oneClick}
                    onChange={(v) => updateTerminalSettings({ trading: { oneClick: v } })} />
                </Show>
                <Show label="Entry sound on fill" hint="Plays your selected entry sound when an order fills (pick the sound on the Settings page)">
                  <Toggle label="Entry sound on fill" checked={ts.trading.entrySoundOnOrder}
                    onChange={(v) => updateTerminalSettings({ trading: { entrySoundOnOrder: v } })} />
                </Show>
              </div>
            )}

            {section === "notifications" && (
              <div className="divide-y divide-slate-800/60">
                <SectionHeader title="Alerts" onReset={() => resetSection("notifications")} />
                <Show label="Price & news alerts"><Toggle label="Price & news alerts" checked={alerts.enabled} onChange={(v) => saveAlerts({ enabled: v })} /></Show>
                <Show label="Browser notifications" hint="Show push notifications even when this tab is in the background">
                  <Toggle label="Browser notifications" checked={alerts.browser}
                    onChange={(v) => {
                      if (v && typeof Notification !== "undefined" && Notification.permission !== "granted") {
                        void Notification.requestPermission();
                      }
                      saveAlerts({ browser: v });
                    }} />
                </Show>
                <Show label="Economic calendar alerts"><Toggle label="Economic calendar alerts" checked={alerts.calEnabled} onChange={(v) => saveAlerts({ calEnabled: v })} /></Show>
                <Show label="Minutes before release">
                  <Select label="Minutes before release" value={String(alerts.calMinutesBefore)}
                    options={[5, 15, 30, 60].map((m) => ({ value: String(m), label: `${m} min` }))}
                    onChange={(v) => saveAlerts({ calMinutesBefore: Number(v) as 5 | 15 | 30 | 60 })} />
                </Show>
              </div>
            )}

            {section === "data" && <DataSection symbol={instrSymbol} matches={matches} />}
            {section === "shortcuts" && <ShortcutsSection matches={matches} />}
          </div>
        </div>

        {confirmResetAll && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60" onClick={() => setConfirmResetAll(false)}>
            <div className="w-72 rounded-lg border border-slate-700 bg-slate-900 p-4" onClick={(e) => e.stopPropagation()}>
              <p className="mb-2 text-sm font-bold text-slate-100">Reset ALL terminal settings?</p>
              <p className="mb-4 text-xs text-slate-400">
                General, appearance, trading, chart, instrument overrides and alerts return to their defaults. This cannot be undone.
              </p>
              <div className="flex justify-end gap-2">
                <button onClick={() => setConfirmResetAll(false)} className="rounded-lg border border-slate-600 px-3 py-1.5 text-[11px] font-semibold text-slate-400 hover:text-slate-200">Cancel</button>
                <button
                  onClick={() => {
                    resetTerminalSettings();
                    resetInstrumentSettings(instrSymbol);
                    saveChartCfg({ ...DEFAULT_SETTINGS });
                    saveScale("normal");
                    saveCursor("cross");
                    setConfirmResetAll(false);
                  }}
                  className="rounded-lg bg-red-500 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-red-400"
                >Reset everything</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// per-instrument section (§4) — every field affects ONLY the chosen symbol
// ---------------------------------------------------------------------------

function InstrumentSection({ instrSymbol, setInstrSymbol, matches, onReset }: {
  instrSymbol: string;
  setInstrSymbol: (s: string) => void;
  matches: (label: string) => boolean;
  onReset: () => void;
}) {
  const per = useInstrumentSettings(instrSymbol);
  const inst = getInstrument(instrSymbol);
  const set = (patch: Partial<InstrumentSettings>) => updateInstrumentSettings(instrSymbol, patch);
  const Show = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) =>
    matches(label) ? <Row label={label} hint={hint}>{children}</Row> : null;
  return (
    <div className="divide-y divide-slate-800/60">
      <div className="flex items-center justify-between py-1.5">
        <Row label="Instrument" hint="These settings apply ONLY to this instrument">
          <Select label="Instrument" value={instrSymbol}
            options={INSTRUMENTS.map((i) => ({ value: i.symbol, label: `${i.symbol} — ${i.name}` }))}
            onChange={setInstrSymbol} />
        </Row>
        <button onClick={onReset} className="shrink-0 pl-3 text-[10px] font-semibold text-slate-500 hover:text-red-400">Reset instrument</button>
      </div>
      {inst && (
        <>
          <Show label="Default chart type">
            <Select label="Chart type" value={per.chartType || ""}
              options={[{ value: "", label: "Global default" }, { value: "candles", label: "Candles" }, { value: "hollow", label: "Hollow" }, { value: "line", label: "Line" }, { value: "area", label: "Area" }, { value: "heikin", label: "Heikin Ashi" }, { value: "renko", label: "Renko" }]}
              onChange={(v) => set({ chartType: (v || undefined) as InstrumentSettings["chartType"] })} />
          </Show>
          <Show label="Default timeframe" hint="Applied whenever this instrument's chart opens">
            <Select label="Timeframe" value={per.timeframe || ""}
              options={[{ value: "", label: "Global default" }, ...TIMEFRAMES.map((tf) => ({ value: tf, label: tf.toUpperCase() }))]}
              onChange={(v) => set({ timeframe: (v || undefined) as InstrumentSettings["timeframe"] })} />
          </Show>
          <Show label="Up candle color">
            <ColorField label="Up candle" value={per.upColor || DEFAULT_SETTINGS.upColor} onChange={(v) => set({ upColor: v })} />
          </Show>
          <Show label="Down candle color">
            <ColorField label="Down candle" value={per.downColor || DEFAULT_SETTINGS.downColor} onChange={(v) => set({ downColor: v })} />
          </Show>
          <Show label="Override colors" hint="Off = the colors above follow the global chart settings">
            <Toggle label="Override colors" checked={per.upColor != null || per.downColor != null}
              onChange={(v) => set(v ? { upColor: DEFAULT_SETTINGS.upColor, downColor: DEFAULT_SETTINGS.downColor } : { upColor: undefined, downColor: undefined })} />
          </Show>
          <Show label="Grid"><Toggle label="Grid" checked={per.grid ?? true} onChange={(v) => set({ grid: v })} /></Show>
          <Show label="Bid/Ask lines"><Toggle label="Bid/Ask lines" checked={per.bidAsk ?? true} onChange={(v) => set({ bidAsk: v })} /></Show>
          <Show label="Default lot size"><TextField label="Default lot" value={per.defaultLot || ""} placeholder="global" width="w-24" onChange={(v) => set({ defaultLot: v || undefined })} /></Show>
          <Show label="Default risk %"><TextField label="Default risk" value={per.defaultRisk || ""} placeholder="global" width="w-24" onChange={(v) => set({ defaultRisk: v || undefined })} /></Show>
          <Show label="Default stop (pips)" hint="Pre-fills the ticket's SL once a live price arrives">
            <TextField label="Default stop pips" value={per.slPips || ""} placeholder="—" width="w-24" onChange={(v) => set({ slPips: v || undefined })} />
          </Show>
          <Show label="Default target (pips)">
            <TextField label="Default target pips" value={per.tpPips || ""} placeholder="—" width="w-24" onChange={(v) => set({ tpPips: v || undefined })} />
          </Show>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// data & connectivity (read-only, honest)
// ---------------------------------------------------------------------------

function DataSection({ symbol, matches }: { symbol: string; matches: (label: string) => boolean }) {
  const { rows, updatedAt } = useQuotes();
  const inst = getInstrument(symbol);
  const row = rows[symbol];
  const age = updatedAt ? Math.round((Date.now() - updatedAt) / 1000) : null;
  const Show = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) =>
    matches(label) ? <Row label={label} hint={hint}>{children}</Row> : null;
  const status = marketStatus(symbol);
  const feeds: { name: string; detail: string; live: boolean }[] = [
    { name: "Crypto", detail: "Binance — real-time WebSocket stream", live: true },
    { name: "Metals", detail: "gold-api 1s poll + self-recorded 1m candles, Twelve Data gap-fill", live: true },
    { name: "Forex majors", detail: "TrueFX genuine bid/ask via the server quotes service", live: true },
    { name: "Indices", detail: "Yahoo Finance daily bars — delayed reference data", live: false },
  ];
  return (
    <div className="divide-y divide-slate-800/60">
      <SectionHeader title="Current instrument" />
      <Show label={inst ? `${inst.symbol} provider` : "Provider"}>
        <span className="text-xs text-slate-300">{inst ? (inst.feedLabel || (inst.feed === "binance" ? "Binance" : "Quotes proxy")) : "—"}</span>
      </Show>
      <Show label="Market status">
        <span className={cn("text-xs font-semibold", status === "open" ? "text-emerald-400" : "text-slate-400")}>{status === "open" ? "Open" : "Closed"}</span>
      </Show>
      <Show label="Quote freshness">
        <span className="text-xs text-slate-300">{age == null ? "—" : `${age}s snapshot · ${row ? "data ok" : "waiting for first snapshot"}`}</span>
      </Show>
      <Show label="Reconnection" hint="Streams reconnect with exponential backoff; REST resync covers gaps">
        <span className="text-[10px] text-slate-500">automatic</span>
      </Show>
      <SectionHeader title="Provider limitations" />
      <Show label="Free-feed delays" hint="Metals spot polls ~1s with a 16-30s provider stamp lag; indices are delayed bars; Twelve Data free tier fills 1m history with a short delay">
        <span className="text-[10px] text-slate-500">known limits</span>
      </Show>
      <div className="pt-2">
        {feeds.map((f) => (
          <div key={f.name} className="flex items-center justify-between border-b border-slate-800/60 py-1.5">
            <div className="min-w-0">
              <p className="text-xs text-slate-200">{f.name}</p>
              <p className="text-[10px] text-slate-500">{f.detail}</p>
            </div>
            <span className={cn("shrink-0 text-[10px] font-bold uppercase", f.live ? "text-emerald-400" : "text-amber-400")}>{f.live ? "Live" : "Delayed"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// shortcuts (read-only reference — the binding map is stable)
// ---------------------------------------------------------------------------

const SHORTCUTS: [string, string][] = [
  ["/", "Open instrument search"],
  ["1 … 9, 0", "Switch timeframe (1m → 1M)"],
  ["Ctrl/Cmd + Z", "Undo last drawing"],
  ["Ctrl/Cmd + Shift + Z / Ctrl+Y", "Redo"],
  ["Esc", "Back to cursor tool"],
  ["Ctrl/Cmd + C / V / D", "Copy / paste / duplicate selection"],
  ["T H V R F X P E I M", "Drawing tools (trend, hline, vline, rect, fib, brush, path, ellipse, ink, measure)"],
  ["Ctrl/Cmd + click", "Multi-select objects"],
];

function ShortcutsSection({ matches }: { matches: (label: string) => boolean }) {
  return (
    <div className="divide-y divide-slate-800/60">
      <SectionHeader title="Keyboard" />
      {SHORTCUTS.filter(([k, d]) => matches(`${k} ${d}`)).map(([k, d]) => (
        <div key={k} className="flex items-center justify-between gap-3 py-1.5">
          <p className="text-xs text-slate-300">{d}</p>
          <kbd className="shrink-0 rounded border border-slate-700 bg-slate-950 px-2 py-0.5 font-mono text-[10px] text-slate-300">{k}</kbd>
        </div>
      ))}
      <p className="pt-2 text-[10px] leading-snug text-slate-500">
        Chart tool bindings are fixed for muscle-memory safety; timeframe keys mirror TradingView's number-row behavior.
      </p>
    </div>
  );
}

// helpers -------------------------------------------------------------------

function loadChartCfg(): ChartSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("it_chart_settings") || "{}") };
  } catch { return DEFAULT_SETTINGS; }
}
