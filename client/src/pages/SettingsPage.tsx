/**
 * Settings page — Language (4 languages) and theme.
 * Terminal preferences (incl. chart/candle colors) live in the terminal's
 * own Chart settings dialog; the old "Terminal defaults" section was removed.
 */
import { Check, Globe2, Palette } from "lucide-react";
import { useLanguage, LANGUAGE_LABELS, LANG_FLAGS, type Language } from "@/lib/language-context";
import { useTheme, THEMES, THEME_LABELS, type Theme } from "@/lib/theme-context";
import { cn } from "@/lib/utils";

export default function SettingsPage() {
  const { t, language, setLanguage } = useLanguage();
  const { theme, setTheme } = useTheme();

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
        <p className="mt-3 text-[11px] text-muted-foreground">{t("settingsSavedNote")}</p>
      </section>
    </div>
  );
}
