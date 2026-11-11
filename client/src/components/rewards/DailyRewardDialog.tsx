import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useMutation } from "@tanstack/react-query";
import { Gift, Gem, Coins, BadgeCheck, ChevronRight, X } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language-context";
import { authedFetch } from "@/lib/api";
import { useEconomy, useEconomyInvalidator, todayTashkent } from "@/hooks/use-economy";
import { useAuth } from "@/hooks/use-auth";
import { CaseOpeningDialog } from "@/components/rewards/CaseOpeningDialog";
import { STREAK_BONUS_EVERY, STREAK_BONUS_COINS, STREAK_BONUS_CASES } from "@shared/fragments";
import type { FragmentDef } from "@shared/fragments";

type Phase = "ready" | "claimed" | "opening";

/**
 * Auto-appearing daily reward dialog. Shows on any page when the user has not
 * claimed today's reward yet (once per day per session — "Later" hides it for
 * the rest of the session).
 */
export function DailyRewardDialog() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const { toast } = useToast();
  const { data: economy, isLoading } = useEconomy();
  const invalidate = useEconomyInvalidator();

  const today = todayTashkent();
  const dismissedKey = `daily-reward-dismissed-${today}`;
  const [dismissed, setDismissed] = useState(false);
  const [phase, setPhase] = useState<Phase>("ready");
  const [caseResult, setCaseResult] = useState<FragmentDef | null>(null);

  useEffect(() => {
    setDismissed(sessionStorage.getItem(dismissedKey) === "1");
  }, [dismissedKey]);

  const claimedToday = economy?.lastClaimDate === today;
  const open = !!user && !isLoading && !claimedToday && !dismissed;

  const streak = economy?.streak ?? 0;
  const nextStreakIsBonus = useMemo(() => {
    const next = (streak % STREAK_BONUS_EVERY) + 1;
    return next % STREAK_BONUS_EVERY === 0;
  }, [streak]);

  const claimMutation = useMutation({
    mutationFn: async () => authedFetch("/api/rewards/claim", {}),
    onSuccess: () => {
      invalidate();
      setPhase("claimed");
    },
    onError: (error: any) => {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
      setDismissed(true);
    },
  });

  const openMutation = useMutation({
    mutationFn: async () => authedFetch("/api/cases/open", {}) as Promise<{ fragment: FragmentDef }>,
    onSuccess: (data) => {
      setCaseResult(data.fragment);
    },
    onError: (error: any) => {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
    },
  });

  const dismiss = () => {
    sessionStorage.setItem(dismissedKey, "1");
    setDismissed(true);
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) dismiss();
        }}
      >
        <DialogContent className="glass-panel max-w-sm border-primary/30 overflow-hidden text-center" showCloseButton={false}>
          <button
            onClick={dismiss}
            aria-label={t("later")}
            className="absolute right-3 top-3 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>

          {phase === "ready" && (
            <motion.div initial={{ scale: 0.94, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="space-y-4 pt-2">
              <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-3xl border border-primary/30 bg-gradient-to-br from-primary/25 via-primary/10 to-transparent shadow-[0_0_40px_-8px_hsl(var(--primary)/0.6)]">
                <Gift className="h-11 w-11 text-primary" />
              </div>
              <div>
                <h3 className="text-xl font-bold font-display">{t("dailyRewardReady")}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{t("dailyRewardNote")}</p>
              </div>
              <div className="flex items-center justify-center gap-2 text-sm font-semibold">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-amber-400">
                  <Coins className="h-4 w-4" />+1 INSP
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-primary">
                  <Gem className="h-4 w-4" />+1 case
                </span>
                {nextStreakIsBonus && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-400/10 px-3 py-1 text-xs text-amber-300">
                    🔥 +{STREAK_BONUS_COINS} INSP +{STREAK_BONUS_CASES} case
                  </span>
                )}
              </div>
              <Button
                size="lg"
                className="w-full rounded-xl font-semibold"
                disabled={claimMutation.isPending}
                onClick={() => claimMutation.mutate()}
              >
                {claimMutation.isPending ? t("claiming") : <><Gift className="mr-2 h-5 w-5" />{t("claimReward")}</>}
              </Button>
              <button onClick={dismiss} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
                {t("later")}
              </button>
            </motion.div>
          )}

          {phase === "claimed" && (
            <motion.div initial={{ scale: 0.94, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="space-y-4 pt-2">
              <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-3xl border border-primary/30 bg-gradient-to-br from-primary/25 via-primary/10 to-transparent shadow-[0_0_40px_-8px_hsl(var(--primary)/0.6)]">
                <Gem className="h-11 w-11 text-primary" />
              </div>
              <div>
                <h3 className="flex items-center justify-center gap-2 text-xl font-bold font-display">
                  <BadgeCheck className="h-5 w-5 text-emerald-400" />
                  {t("dailyRewardGot")}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">{t("dailyRewardOpenNow")}</p>
              </div>
              <Button
                size="lg"
                className="w-full rounded-xl font-semibold"
                disabled={openMutation.isPending}
                onClick={() => {
                  setPhase("opening");
                  openMutation.mutate();
                }}
              >
                {openMutation.isPending ? t("openingCase") : <><ChevronRight className="mr-2 h-5 w-5" />{t("openCaseNow")}</>}
              </Button>
              <button onClick={dismiss} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
                {t("later")}
              </button>
            </motion.div>
          )}
        </DialogContent>
      </Dialog>

      <CaseOpeningDialog
        open={!!caseResult}
        result={caseResult}
        onClose={() => {
          setCaseResult(null);
          dismiss();
          invalidate();
        }}
      />
    </>
  );
}
