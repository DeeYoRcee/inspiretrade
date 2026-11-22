/**
 * Phase 34 — InstrumentSettingsPanel: per-instrument terminal settings in a
 * right-side sheet, styled after the existing terminal dialogs (dark chrome,
 * hand-rolled — not the app Dialog, matching TerminalSettingsDialog).
 *
 * Persistence follows the existing patterns exactly:
 *  - per instrument: instrument-settings store (LS mirror + RTDB
 *    `users/{uid}/instrumentSettings/{symbol}`, 400 ms debounce, keyed per
 *    symbol — EURUSD never leaks into XAUUSD)
 *  - global appearance: `it_chart_settings` blob + "it_chart_settings_changed"
 *    broadcast, scale/cursor mode via "it_chart_aux_changed"
 */
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { RotateCcw, X } from "lucide-react";
import { getInstrument } from "@shared/terminal";
import {
  DEFAULT_SETTINGS, APPEARANCE_PRESETS, applyGridDefaultOff, type ChartSettings,
  magnetModeOf,
} from "@/components/terminal/chart/dialogs";
import {
  getInstrumentSettings, updateInstrumentSettings, resetInstrumentSettings, useInstrumentSettings,
  type InstrumentSettings,
} from "@/lib/instrument-settings";

const CHART_TYPE_TILES: { id: InstrumentSettings["chartType"]; label: string }[] = [
  { id: "candles", label: "Candles" },
  { id: "hollow", label: "Hollow" },
  { id: "bars", label: "Bars" },
  { id: "baseline", label: "Baseline" },
  { id: "line", label: "Line" },
  { id: "area", label: "Area" },
  { id: "heikin", label: "Heikin Ashi" },
];

const TF_TILES = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1W"] as const;

const TIMEZONES = [
  { v: "", label: "Viewer local (default)" },
  { v: "UTC", label: "UTC" },
  { v: "America/New_York", label: "New York" },
  { v: "Europe/London", label: "London" },
  { v: "Europe/Berlin", label: "Berlin / Frankfurt" },
  { v: "Asia/Tashkent", label: "Tashkent" },
  { v: "Asia/Dubai", label: "Dubai" },
  { v: "Asia/Almaty", label: "Almaty" },
  { v: "Asia/Tokyo", label: "Tokyo" },
];

function readGlobalSettings(): ChartSettings {
  try { return applyGridDefaultOff({ ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("it_chart_settings") || "{}") }); }
  catch { return { ...DEFAULT_SETTINGS }; }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2.5 border-t border-slate-800/70 pt-4 first:border-t-0 first:pt-0">
      <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">{title}</p>
      {children}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-slate-200">{label}</p>
        {hint && <p className="text-[11px] leading-tight text-slate-500">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex overflow-hidden rounded-lg border border-slate-700/70">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`px-2.5 py-1.5 text-xs font-semibold transition-colors ${value === o.v ? "bg-primary/20 text-primary" : "text-slate-400 hover:bg-slate-800/60"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`relative h-5.5 w-10 rounded-full transition-colors ${on ? "bg-primary" : "bg-slate-700"}`}
      style={{ height: 22 }}
    >
      <span className={`absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition-all ${on ? "left-[20px]" : "left-0.5"}`} />
    </button>
  );
}

function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  // hex only for the native picker; rgba crosshair values fall back to a swatch
  const hex = /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#16213a";
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-6 w-6 overflow-hidden rounded-md border border-slate-700/70" style={{ background: value }}>
        <input type="color" value={hex} onChange={(e) => onChange(e.target.value)} className="h-full w-full cursor-pointer opacity-0" aria-label="color" />
      </span>
      <span className="w-16 truncate font-mono text-[10px] text-slate-500">{value}</span>
    </span>
  );
}

export function InstrumentSettingsPanel({ symbol, open, onClose }: { symbol: string; open: boolean; onClose: () => void }) {
  const inst = getInstrument(symbol);
  const per = useInstrumentSettings(symbol);
  const [global, setGlobal] = useState<ChartSettings>(() => readGlobalSettings());

  useEffect(() => {
    if (open) setGlobal(readGlobalSettings());
  }, [open]);

  if (!open) return null;

  const setPer = (patch: InstrumentSettings) => updateInstrumentSettings(symbol, patch);
  const setGlobalCfg = (patch: Partial<ChartSettings>) => {
    const next = { ...global, ...patch };
    setGlobal(next);
    try { localStorage.setItem("it_chart_settings", JSON.stringify(next)); } catch { /* private mode */ }
    window.dispatchEvent(new CustomEvent("it_chart_settings_changed", { detail: next }));
  };
  const setAux = (detail: Record<string, unknown>) => window.dispatchEvent(new CustomEvent("it_chart_aux_changed", { detail }));

  return (
    <div className="fixed inset-0 z-[80]">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} />
      <motion.aside
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-slate-700/60 bg-[#0b1220]/97 shadow-2xl"
      >
        {/* header */}
        <div className="flex items-center justify-between gap-3 border-b border-slate-800/70 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-slate-100">{inst?.symbol || symbol}</p>
            <p className="text-[11px] text-slate-500">
              {inst?.name ? `${inst.name} · ` : ""}{inst ? `${inst.digits} decimals · ${inst.session || "24/7"}` : "instrument"}
            </p>
          </div>
          <button onClick={onClose} className="rounded-md border border-slate-700/70 p-1.5 text-slate-400 hover:text-slate-200" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* body */}
        <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
          <Section title="Chart type">
            <div className="grid grid-cols-4 gap-1.5">
              {CHART_TYPE_TILES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setPer({ chartType: t.id })}
                  className={`rounded-lg border px-1 py-2 text-[11px] font-semibold transition-colors ${
                    (per.chartType ?? undefined) === t.id
                      ? "border-primary/60 bg-primary/15 text-primary"
                      : "border-slate-700/60 text-slate-400 hover:border-slate-500 hover:text-slate-200"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-slate-500">Applies to {symbol} when its chart opens; the toolbar keeps the global default.</p>
          </Section>

          <Section title="Default timeframe">
            <div className="flex flex-wrap gap-1.5">
              {TF_TILES.map((tf) => (
                <button
                  key={tf}
                  onClick={() => setPer({ timeframe: tf })}
                  className={`rounded-lg border px-2.5 py-1.5 text-xs font-bold transition-colors ${
                    per.timeframe === tf
                      ? "border-primary/60 bg-primary/15 text-primary"
                      : "border-slate-700/60 text-slate-400 hover:border-slate-500 hover:text-slate-200"
                  }`}
                >
                  {tf}
                </button>
              ))}
            </div>
          </Section>

          <Section title="Price">
            <Row label="Bid / Ask lines" hint="Server-consistent spread around the mid">
              <Toggle on={per.bidAsk ?? true} onChange={(v) => setPer({ bidAsk: v })} />
            </Row>
            <Row label="Last price line" hint="Close line + axis label on the chart">
              <Toggle on={per.lastPrice ?? true} onChange={(v) => setPer({ lastPrice: v })} />
            </Row>
            <Row label="Previous day close" hint="Dotted PDC line from the daily history">
              <Toggle on={per.prevClose ?? false} onChange={(v) => setPer({ prevClose: v })} />
            </Row>
            <Row label="Precision" hint={`Instrument default: ${inst?.digits ?? 2} decimals`}>
              <Seg
                value={per.precision == null ? "auto" : String(per.precision)}
                options={[
                  { v: "auto", label: "Auto" },
                  ...[1, 2, 3, 4, 5].map((n) => ({ v: String(n), label: String(n) })),
                ]}
                onChange={(v) => setPer({ precision: v === "auto" ? undefined : Number(v) })}
              />
            </Row>
            <Row label="Price scale side">
              <Seg
                value={per.priceScaleSide ?? "right"}
                options={[{ v: "right" as const, label: "Right" }, { v: "left" as const, label: "Left" }]}
                onChange={(v) => setPer({ priceScaleSide: v })}
              />
            </Row>
            <Row label="Scale mode" hint="Absolute / logarithmic / percentage">
              <Seg
                value={(localStorage.getItem("it_chart_scale") as "normal" | "log" | "percent") || "normal"}
                options={[{ v: "normal" as const, label: "Abs" }, { v: "log" as const, label: "Log" }, { v: "percent" as const, label: "%" }]}
                onChange={(v) => {
                  try { localStorage.setItem("it_chart_scale", v); } catch { /* private mode */ }
                  setAux({ scaleMode: v });
                }}
              />
            </Row>
          </Section>

          <Section title="Time axis">
            <Row label="Timezone" hint="Presentation only — data stays UTC">
              <select
                value={per.timezone ?? ""}
                onChange={(e) => setPer({ timezone: e.target.value })}
                className="num-input h-8 rounded-lg text-xs font-semibold text-slate-200"
              >
                {TIMEZONES.map((tz) => <option key={tz.v || "local"} value={tz.v}>{tz.label}</option>)}
              </select>
            </Row>
          </Section>

          <Section title="Appearance">
            <div className="flex flex-wrap gap-1.5">
              {APPEARANCE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setGlobalCfg(p.s)}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-700/60 px-2.5 py-1.5 text-xs font-semibold text-slate-300 transition-colors hover:border-primary/50 hover:text-primary"
                >
                  <span className="relative h-3 w-6 shrink-0 overflow-hidden rounded-sm border border-slate-700" style={{ background: p.s.bgColor }}>
                    <span className="absolute left-1 top-0 h-2.5 w-1.5 rounded-[1px]" style={{ background: p.s.upColor }} />
                    <span className="absolute right-1 top-0.5 h-2 w-1.5 rounded-[1px]" style={{ background: p.s.downColor }} />
                  </span>
                  {p.label}
                </button>
              ))}
            </div>
            <Row label="Grid" hint="Background grid lines">
              <Toggle on={per.grid ?? global.grid} onChange={(v) => setPer({ grid: v })} />
            </Row>
            <Row label="Magnet crosshair" hint="Snap the crosshair to OHLC values">
              <Toggle on={magnetModeOf(global) > 0} onChange={(v) => setGlobalCfg({ magnet: v, magnetMode: v ? 1 : 0 })} />
            </Row>
            <Row label="Bullish color"><ColorInput value={global.upColor} onChange={(v) => setGlobalCfg({ upColor: v })} /></Row>
            <Row label="Bearish color"><ColorInput value={global.downColor} onChange={(v) => setGlobalCfg({ downColor: v })} /></Row>
            <Row label="Background"><ColorInput value={global.bgColor} onChange={(v) => setGlobalCfg({ bgColor: v })} /></Row>
            <Row label="Grid color"><ColorInput value={global.gridColor} onChange={(v) => setGlobalCfg({ gridColor: v })} /></Row>
            <Row label="Crosshair"><ColorInput value={global.crosshairColor} onChange={(v) => setGlobalCfg({ crosshairColor: v })} /></Row>
          </Section>

          <Section title="Reset">
            <button
              onClick={() => resetInstrumentSettings(symbol)}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-destructive/40 px-3 py-2.5 text-sm font-semibold text-destructive transition-colors hover:bg-destructive/10"
            >
              <RotateCcw className="h-4 w-4" />
              Reset {symbol} to default
            </button>
            <p className="text-[11px] text-slate-500">Clears every per-instrument override for {symbol}. Global appearance keeps its values.</p>
          </Section>
        </div>
      </motion.aside>
    </div>
  );
}

// keep the read-only getter referenced for callers that preload a symbol's prefs
void getInstrumentSettings;
