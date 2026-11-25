/**
 * Settings page — Language (4 languages) and theme, plus
 * the Phase 21 unified Terminal Settings dialog (general/appearance/chart/
 * instrument/trading/notifications/data/shortcuts).
 */
import { useState } from "react";
import { Check, Globe2, Palette, Settings2 , Lock } from "lucide-react";
import { useLanguage, LANGUAGE_LABELS, LANG_FLAGS, type Language } from "@/lib/language-context";
import { useTheme, useThemeChipGuard, THEMES, THEME_LABELS, isVipTheme, type Theme } from "@/lib/theme-context";
import { TerminalSettingsDialog } from "@/components/terminal/TerminalSettingsDialog";
import { cn } from "@/lib/utils";

export default function SettingsPage() {
  const { t, language, setLanguage } = useLanguage();
  const { theme, setTheme, isVip } = useTheme();
  const guard = useThemeChipGuard();
  const [terminalOpen, setTerminalOpen] = useState(false);

  return (
    <div className="container mx-auto max-w-3xl space-y-5 p-4 pb-24">
      {/* ===== Terminal settings (Phase 21 unified dialog) ===== */}
      <section className="glass-panel rounded-2xl border-border/50 p-5">
        <h2 className="flex items-center gap-2 text-lg font-bold"><Settings2 className="h-5 w-5 text-primary" />{t("terminalSettings")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t("terminalSettingsHint")}</p>
        <button
          onClick={() => setTerminalOpen(true)}
          className="mt-4 inline-flex items-center gap-2 rounded-xl border border-primary/50 bg-primary/10 px-4 py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-primary/15"
        >
          <Settings2 className="h-4 w-4" /> {t("openTerminalSettings")}
        </button>
      </section>

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
        {/* Phase 19: fixed 3-row grid (3 cols mobile / 4 cols desktop) —
            chips keep constant size and every chip reserves the check slot,
            so selecting a theme can never reflow the row ("falling apart") */}
        <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {THEMES.map((th: Theme) => {
            const locked = isVipTheme(th) && !isVip;
            return (
              <button
                key={th}
                onClick={() => { if (!guard(th)) return; setTheme(th); }}
                title={locked ? "Premium theme — unlock on the Premium page" : undefined}
                className={cn(
                  "flex h-11 items-center gap-2 overflow-hidden rounded-xl border px-3 text-sm font-medium transition-colors",
                  locked ? "border-border/40 text-muted-foreground/60" : theme === th ? "border-primary/60 bg-primary/10 text-primary" : "border-border/60 text-muted-foreground hover:text-foreground",
                )}
              >
                <span className={cn("h-3.5 w-3.5 shrink-0 rounded-full border border-foreground/20", `theme-dot-${th}`)} />
                <span className="truncate">{THEME_LABELS[th]}</span>
                <span className="ml-auto flex w-3.5 shrink-0 justify-center">
                  {locked ? <Lock className="h-3 w-3" /> : theme === th && <Check className="h-3.5 w-3.5" />}
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">{t("settingsSavedNote")}</p>
      </section>


      {/* the unified dialog — opened from the section above */}
      <TerminalSettingsDialog
        open={terminalOpen}
        onClose={() => setTerminalOpen(false)}
        symbol="BTCUSD"
      />
    </div>
  );
}
