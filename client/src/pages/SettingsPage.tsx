/**
 * Settings page — Language (4 languages), theme and terminal preferences.
 * Saved locally (language/theme) and to Firebase (terminal defaults).
 */
import { Check, Globe2, Palette, Volume2, BarChart2 } from "lucide-react";
import { useLanguage, LANGUAGE_LABELS, type Language } from "@/lib/language-context";
import { useTheme, THEMES, THEME_LABELS, type Theme } from "@/lib/theme-context";
import { useTerminalWorkspace } from "@/hooks/use-terminal-workspace";
import { TIMEFRAMES, CHART_TYPES, type Timeframe, type ChartType } from "@shared/terminal";
import { GroupedOptions } from "@/components/terminal/SymbolOptions";
import { cn } from "@/lib/utils";

export default function SettingsPage() {
  const { t, language, setLanguage } = useLanguage();
  const { theme, setTheme } = useTheme();
  const { settings, update } = useTerminalWorkspace();

  return (
    <div className="container mx-auto max-w-3xl space-y-5 p-4 pb-24">
      {/* ===== Language ===== */}
      <section className="glass-panel rounded-2xl border-border/50 p-5">
        <h2 className="flex items-center gap-2 text-lg font-bold"><Globe2 className="h-5 w-5 text-primary" />{t("language")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t("settingsLanguageHint")}</p>
        <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {(Object.keys(LANGUAGE_LABELS) as Language[]).map((code) => (
            <button
              key={code}
              onClick={() => setLanguage(code)}
              aria-pressed={language === code}
              className={cn(
                "flex flex-col items-center gap-1 rounded-xl border px-3 py-4 text-sm font-semibold transition-all",
                language === code
                  ? "border-primary/60 bg-primary/10 text-primary shadow-[0_0_0_1px_rgba(34,197,94,0.25)]"
                  : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground",
              )}
            >
              <span className="text-2xl" aria-hidden>{LANG_FLAGS[code]}</span>
              {LANGUAGE_LABELS[code]}
              {language === code && <Check className="h-4 w-4 text-primary" />}
            </button>
          ))}
        </div>
      </section>

      {/* ===== Theme ===== */}
      <section className="glass-panel rounded-2xl border-border/50 p-5">
        <h2 className="flex items-center gap-2 text-lg font-bold"><Palette className="h-5 w-5 text-primary" />{t("themeTitle")}</h2>
        <div className="mt-4 flex flex-wrap gap-2">
          {THEMES.map((th: Theme) => (
            <button
              key={th}
              onClick={() => setTheme(th)}
              className={cn(
                "flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-colors",
                theme === th ? "border-primary/60 bg-primary/10 text-primary" : "border-border/60 text-muted-foreground hover:text-foreground",
              )}
            >
              <span className={cn("h-3.5 w-3.5 rounded-full border border-foreground/20", `theme-dot-${th}`)} />
              {THEME_LABELS[th]}
              {theme === th && <Check className="h-3.5 w-3.5" />}
            </button>
          ))}
        </div>
      </section>

      {/* ===== Terminal defaults ===== */}
      <section className="glass-panel rounded-2xl border-border/50 p-5">
        <h2 className="flex items-center gap-2 text-lg font-bold"><BarChart2 className="h-5 w-5 text-primary" />{t("terminalDefaults")}</h2>
        <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">{t("setInstrument")}</span>
            <select value={settings.symbol} onChange={(e) => update({ symbol: e.target.value })} className="num-input h-9">
              <GroupedOptions />
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">{t("setTimeframe")}</span>
            <select value={settings.timeframe} onChange={(e) => update({ timeframe: e.target.value as Timeframe })} className="num-input h-9">
              {TIMEFRAMES.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">{t("setChartType")}</span>
            <select value={settings.chartType} onChange={(e) => update({ chartType: e.target.value as ChartType })} className="num-input h-9">
              {CHART_TYPES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">{t("setRisk")}</span>
            <input type="number" step="0.1" min="0" value={settings.defaultRiskPct} onChange={(e) => update({ defaultRiskPct: Number(e.target.value) })} className="num-input h-9" />
          </label>
          <label className="flex items-center gap-2 pt-5">
            <input type="checkbox" checked={settings.sound} onChange={(e) => update({ sound: e.target.checked })} className="h-4 w-4 accent-[#22c55e]" />
            <span className="flex items-center gap-1 text-sm"><Volume2 className="h-4 w-4 text-muted-foreground" />{t("setSound")}</span>
          </label>
          <label className="flex items-center gap-2 pt-5">
            <input type="checkbox" checked={settings.showVolume} onChange={(e) => update({ showVolume: e.target.checked })} className="h-4 w-4 accent-[#22c55e]" />
            <span className="text-sm">{t("setVolume")}</span>
          </label>
        </div>

        <div className="mt-4">
          <span className="mb-2 block text-xs text-muted-foreground">{t("setCandleColors")}</span>
          <div className="flex flex-wrap items-center gap-3">
            <ColorPick label={t("setBull")} value={settings.colors.up} onChange={(v) => update({ colors: { ...settings.colors, up: v } })} />
            <ColorPick label={t("setBear")} value={settings.colors.down} onChange={(v) => update({ colors: { ...settings.colors, down: v } })} />
            <ColorPick label={t("setAccent")} value={settings.colors.accent} onChange={(v) => update({ colors: { ...settings.colors, accent: v } })} />
            <ColorPick label={t("setBg")} value={settings.colors.bg} onChange={(v) => update({ colors: { ...settings.colors, bg: v } })} />
            <ColorPick label={t("setGrid")} value={settings.colors.grid} onChange={(v) => update({ colors: { ...settings.colors, grid: v } })} />
          </div>
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">{t("settingsSavedNote")}</p>
      </section>
    </div>
  );
}

function ColorPick({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-2 rounded-xl border border-border/60 px-3 py-2 text-xs">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-6 w-8 cursor-pointer rounded border-0 bg-transparent" />
      {label}
    </label>
  );
}

const LANG_FLAGS: Record<Language, string> = { en: "🇬🇧", ru: "🇷🇺", uz: "🇺🇿", ar: "🇸🇦" };
