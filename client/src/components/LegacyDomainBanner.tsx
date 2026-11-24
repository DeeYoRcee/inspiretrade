import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/language-context";

/**
 * PWA domain migration (P70).
 *
 * Production moved from the legacy hosts (inspiretrade.vercel.app,
 * freetradejournal.gt.tc) to https://inspiretrade.site. Chrome's PWA origin
 * migration (Chrome 150+) cannot help here: it requires the old and new
 * origins to share the same registrable domain (eTLD+1), and vercel.app →
 * inspiretrade.site are different registrable domains. So existing
 * installations can never move automatically — they keep working (same code,
 * same Firebase project) but must be re-installed from the new domain by the
 * user. This banner, shown ONLY on the legacy hosts, is that fallback: it
 * survives even in standalone mode (installed-app users launch there) and
 * links to the same path on the new domain so no one loses their place.
 *
 * The dismiss flag lives in localStorage, which is per-origin — dismissing
 * here never suppresses anything on inspiretrade.site.
 */

const LEGACY_HOSTS = new Set(["inspiretrade.vercel.app", "freetradejournal.gt.tc"]);
const NEW_ORIGIN = "https://inspiretrade.site";
const DISMISS_KEY = "legacy-domain-banner-dismissed";

export function LegacyDomainBanner() {
  const [show, setShow] = useState(false);
  const { t } = useLanguage();

  useEffect(() => {
    try {
      if (!LEGACY_HOSTS.has(window.location.hostname)) return;
      if (localStorage.getItem(DISMISS_KEY)) return;
      setShow(true);
    } catch {
      /* private mode — show the banner anyway */
      if (LEGACY_HOSTS.has(window.location.hostname)) setShow(true);
    }
  }, []);

  if (!show) return null;

  const newUrl =
    NEW_ORIGIN + window.location.pathname + window.location.search + window.location.hash;

  const handleDismiss = () => {
    setShow(false);
    try {
      localStorage.setItem(DISMISS_KEY, "true");
    } catch {
      /* private mode — banner returns next visit, acceptable */
    }
  };

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ y: -80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -80, opacity: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          /* z-45 keeps it BELOW dialogs (z-50), same layer as the install banner */
          className="fixed top-3 z-[45] start-3 end-3 sm:start-auto sm:w-[26rem] mx-auto"
        >
          <div className="rounded-2xl glass-panel border border-border/60 shadow-2xl shadow-black/40 p-4">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-bold text-sm text-foreground">{t("legacyMoved")}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{t("legacyMovedDesc")}</p>
                  </div>
                  <button
                    onClick={handleDismiss}
                    aria-label="Dismiss"
                    className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="mt-3">
                  <a href={newUrl} className="block">
                    <Button size="sm" className="h-8 text-xs gap-1.5 rounded-lg font-semibold w-full">
                      {t("legacyOpen")}
                      <ArrowRight className="w-3.5 h-3.5" />
                    </Button>
                  </a>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
