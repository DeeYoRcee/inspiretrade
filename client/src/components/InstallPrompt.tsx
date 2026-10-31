import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Download, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/language-context";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function InstallPrompt() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [show, setShow] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const { t } = useLanguage();

  useEffect(() => {
    const alreadyDismissed = localStorage.getItem("pwa-install-dismissed");
    if (alreadyDismissed) return;

    const isIOSDevice = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isInStandaloneMode =
      ("standalone" in window.navigator && (window.navigator as any).standalone) ||
      window.matchMedia("(display-mode: standalone)").matches;

    if (isInStandaloneMode) return;

    if (isIOSDevice) {
      setIsIOS(true);
      setTimeout(() => setShow(true), 3000);
      return;
    }

    const handler = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
      setTimeout(() => setShow(true), 3000);
    };

    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const handleInstall = async () => {
    if (installEvent) {
      await installEvent.prompt();
      const { outcome } = await installEvent.userChoice;
      if (outcome === "accepted") {
        setShow(false);
      }
    }
  };

  const handleDismiss = () => {
    setShow(false);
    setDismissed(true);
    localStorage.setItem("pwa-install-dismissed", "true");
  };

  if (!show) return null;

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] w-[calc(100%-2rem)] max-w-sm"
        >
          <div className="rounded-2xl glass-panel border border-border/60 shadow-2xl shadow-black/40 p-4">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center overflow-hidden">
                <img src="/logo.png" alt="Trade Journal" className="w-10 h-10 object-contain" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-bold text-sm text-foreground">{t("installJournal")}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {isIOS
                         ? t("shareAddHome")
                         : t("installDescription")}
                    </p>
                  </div>
                  <button
                    onClick={handleDismiss}
                    className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                {!isIOS && (
                  <div className="flex items-center gap-2 mt-3">
                    <Button
                      size="sm"
                      onClick={handleInstall}
                      className="h-8 text-xs gap-1.5 rounded-lg font-semibold flex-1"
                    >
                      <Download className="w-3.5 h-3.5" />
                      {t("install")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={handleDismiss}
                      className="h-8 text-xs rounded-lg text-muted-foreground"
                    >
                      {t("notNow")}
                    </Button>
                  </div>
                )}
                {isIOS && (
                  <div className="flex items-center gap-1.5 mt-2 text-xs text-muted-foreground">
                    <Smartphone className="w-3.5 h-3.5" />
                    <span>{t("shareAddHome")}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
