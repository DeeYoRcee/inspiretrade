/**
 * AllSettingsDialog — P66 user request: the navbar Settings dropdown gains an
 * "All settings" entry at the bottom, and LANGUAGE + THEME live inside it
 * (the panels were lifted from the retired /settings page sections).
 */
import { Check, Globe2, Lock, Palette } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useLanguage, LANGUAGE_LABELS, LANG_FLAGS, type Language } from "@/lib/language-context";
import { useTheme, useThemeChipGuard, THEMES, THEME_LABELS, isVipTheme, type Theme } from "@/lib/theme-context";
import { cn } from "@/lib/utils";

export function AllSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { language, setLanguage } = useLanguage();
  const { theme, setTheme, isVip } = useTheme();
  const guard = useThemeChipGuard();

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? onClose() : null)}>
      <DialogContent className="max-h-[82dvh] w-[min(94vw,520px)] overflow-y-auto rounded-2xl border-border/60 bg-card p-4">
        <h2 className="flex items-center gap-2 text-base font-bold">
          <Palette className="h-4.5 w-4.5 text-primary" /> All settings
        </h2>

        {/* ===== Language ===== */}
        <section className="mt-3">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
            <Globe2 className="h-4 w-4 text-primary" /> Language
          </h3>
          <div className="mt-2.5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {(Object.keys(LANGUAGE_LABELS) as Language[]).map((code) => (
              <button
                key={code}
                onClick={() => setLanguage(code)}
                aria-pressed={language === code}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-xl border px-3 py-3 text-sm font-semibold transition-all",
                  language === code
                    ? "border-primary/60 bg-primary/10 text-primary"
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
        <section className="mt-4">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
            <Palette className="h-4 w-4 text-primary" /> Theme
          </h3>
          {/* constant-size chips — the check slot is reserved so picking a
              theme never reflows the row (Phase 19 pattern) */}
          <div className="mt-2.5 grid grid-cols-3 gap-2 sm:grid-cols-4">
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
        </section>
      </DialogContent>
    </Dialog>
  );
}
