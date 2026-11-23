import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { Crown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { usePremiumStatus, useUserProfile } from "@/hooks/use-premium";
import { useLanguage } from "@/lib/language-context";

/**
 * Get-Premium nudge (user request: "ba'zida so'rab tursin") — an occasional,
 * deliberately gentle invitation for logged-in non-premium users.
 *
 * Anti-annoyance rules: at most ONCE per day per device (localStorage date
 * stamp), never in the same session after a dismiss, never on /premium or
 * /admin itself, and only after the user has actually spent some time on the
 * site (90 s). Premium subscribers and the owner never see it.
 */
const LS_LAST = "premium-nudge-last";
const DELAY_MS = 90_000;

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export function PremiumNudge() {
  const { user } = useAuth();
  const { data: premium } = usePremiumStatus();
  const { data: profile } = useUserProfile();
  const { t } = useLanguage();
  const [location, navigate] = useLocation();
  const [eligible, setEligible] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!user || premium == null) return;
    if (premium === true || profile?.isPremium || profile?.ceo) return;
    if (["/premium", "/admin", "/auth"].includes(location)) return;
    try {
      if (localStorage.getItem(LS_LAST) === todayStamp()) return;
    } catch { /* private mode */ }
    setEligible(true);
    const timer = setTimeout(() => setVisible(true), DELAY_MS);
    return () => clearTimeout(timer);
  }, [user, premium, profile?.isPremium, profile?.ceo, location]);

  const close = () => {
    setVisible(false);
    try { localStorage.setItem(LS_LAST, todayStamp()); } catch { /* private mode */ }
  };

  if (!eligible || !visible) return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="fixed bottom-4 start-4 z-[70] max-w-[320px]"
      role="dialog"
      aria-label={t("getPremium")}
    >
      <div className="glass-panel relative flex items-start gap-3 rounded-2xl border border-amber-500/40 p-4 shadow-[0_8px_40px_-8px_rgba(245,158,11,0.45)]">
        <button
          onClick={close}
          aria-label="Close"
          className="absolute end-2 top-2 rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-500/40 bg-amber-500/10">
          <Crown className="h-5 w-5 text-amber-400" />
        </div>
        <div className="min-w-0 space-y-2">
          <p className="text-sm font-bold">{t("premiumNudgeTitle")}</p>
          <p className="text-xs leading-relaxed text-muted-foreground">{t("premiumNudgeText")}</p>
          <Button
            size="sm"
            onClick={() => { close(); navigate("/premium"); }}
            className="h-8 rounded-lg bg-gradient-to-r from-amber-500 to-yellow-400 font-semibold text-black hover:from-amber-400 hover:to-yellow-300"
          >
            <Crown className="me-1.5 h-3.5 w-3.5" />{t("getPremium")}
          </Button>
        </div>
      </div>
    </motion.div>
  );
}
