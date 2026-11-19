/**
 * Settings page — Language (4 languages), theme and the entry sound, plus
 * the Phase 21 unified Terminal Settings dialog (general/appearance/chart/
 * instrument/trading/notifications/data/shortcuts).
 */
import { useState } from "react";
import { Check, Globe2, Palette, Settings2, Volume2, VolumeX } from "lucide-react";
import { useLanguage, LANGUAGE_LABELS, LANG_FLAGS, type Language } from "@/lib/language-context";
import { useTheme, THEMES, THEME_LABELS, type Theme } from "@/lib/theme-context";
import { ENTRY_SOUNDS, getEntrySound, playEntrySound, setEntrySound, type EntrySoundId } from "@/lib/sfx";
import { TerminalSettingsDialog } from "@/components/terminal/TerminalSettingsDialog";
import { cn } from "@/lib/utils";

export default function SettingsPage() {
  const { t, language, setLanguage } = useLanguage();
  const { theme, setTheme } = useTheme();
  // the pickable splash sound — tapping a chip previews it AND saves it
  const [sound, setSound] = useState<EntrySoundId>(() => getEntrySound());
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
          {THEMES.map((th: Theme) => (
            <button
              key={th}
              onClick={() => setTheme(th)}
              className={cn(
                "flex h-11 items-center gap-2 overflow-hidden rounded-xl border px-3 text-sm font-medium transition-colors",
                theme === th ? "border-primary/60 bg-primary/10 text-primary" : "border-border/60 text-muted-foreground hover:text-foreground",
              )}
            >
              <span className={cn("h-3.5 w-3.5 shrink-0 rounded-full border border-foreground/20", `theme-dot-${th}`)} />
              <span className="truncate">{THEME_LABELS[th]}</span>
              <span className="ml-auto flex w-3.5 shrink-0 justify-center">
                {theme === th && <Check className="h-3.5 w-3.5" />}
              </span>
            </button>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">{t("settingsSavedNote")}</p>
      </section>

      {/* ===== Entry sound ===== */}
      <section className="glass-panel rounded-2xl border-border/50 p-5">
        <h2 className="flex items-center gap-2 text-lg font-bold"><Volume2 className="h-5 w-5 text-primary" />{t("entrySound")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t("entrySoundHint")}</p>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {ENTRY_SOUNDS.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setEntrySound(s.id);
                setSound(s.id);
                if (s.id !== "none") playEntrySound(s.id); // preview on tap
              }}
              aria-pressed={sound === s.id}
              className={cn(
                "flex h-11 items-center gap-2 overflow-hidden rounded-xl border px-3 text-sm font-medium transition-colors",
                sound === s.id
                  ? "border-primary/60 bg-primary/10 text-primary shadow-[0_0_0_1px_rgba(34,197,94,0.25)]"
                  : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground",
              )}
            >
              {s.id === "none"
                ? <VolumeX className="h-3.5 w-3.5 shrink-0" />
                : <Volume2 className="h-3.5 w-3.5 shrink-0" />}
              <span className="truncate">{s.label}</span>
              <span className="ml-auto flex w-3.5 shrink-0 justify-center">
                {sound === s.id && <Check className="h-3.5 w-3.5" />}
              </span>
            </button>
          ))}
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
