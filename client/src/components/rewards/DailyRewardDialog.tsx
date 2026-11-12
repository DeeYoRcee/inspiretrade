import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useMutation } from "@tanstack/react-query";
import { Gift, Gem, BadgeCheck, ChevronRight, X, Check, Crown } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language-context";
import { authedFetch } from "@/lib/api";
import { useEconomy, useEconomyInvalidator, todayTashkent } from "@/hooks/use-economy";
import { useAuth } from "@/hooks/use-auth";
import { CaseOpeningDialog } from "@/components/rewards/CaseOpeningDialog";
import {
  REWARD_CYCLE_DAYS, GOLD_CASE_DAY, CASES, cycleDayOf, caseTypeForCycleDay,
  type CaseType, type FragmentDef,
} from "@shared/fragments";
import { cn } from "@/lib/utils";

type Phase = "ready" | "claimed" | "opening";
interface ClaimResponse {
  economy: { streak: number };
  reward: { cycleDay: number; caseType: CaseType; caseName: string };
}

/**
 * Auto-appearing daily reward dialog — PUBG-Mobile-style 7-day login
 * calendar. Days 1-6 grant an Inspire Case (5k$ fragments), day 7 grants
 * the Gold Case (10k$ fragments). Shows on any page when the user has not
 * claimed today's reward yet (once per day per session — "Later" hides it
 * for the rest of the session).
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
  const [granted, setGranted] = useState<{ caseType: CaseType; caseName: string } | null>(null);
  const [caseResult, setCaseResult] = useState<FragmentDef | null>(null);
  const [openCaseType, setOpenCaseType] = useState<CaseType>("inspire");

  useEffect(() => {
    setDismissed(sessionStorage.getItem(dismissedKey) === "1");
  }, [dismissedKey]);

  const claimedToday = economy?.lastClaimDate === today;
  const open = !!user && !isLoading && !claimedToday && !dismissed;

  const streak = economy?.streak ?? 0;
  // Days already claimed inside the current 7-day cycle
  const claimedInCycle = claimedToday
    ? cycleDayOf(streak)            // today's claim already counted in streak
    : streak % REWARD_CYCLE_DAYS;   // 0 when the last cycle just completed
  const nextCycleDay = (claimedInCycle % REWARD_CYCLE_DAYS) + 1;
  const nextCaseType = caseTypeForCycleDay(nextCycleDay);
  const nextIsGold = nextCaseType === "gold";

  const claimMutation = useMutation({
    mutationFn: async () => authedFetch("/api/rewards/claim", {}) as Promise<ClaimResponse>,
    onSuccess: (data) => {
      invalidate();
      setGranted({ caseType: data.reward.caseType, caseName: data.reward.caseName });
      setPhase("claimed");
    },
    onError: (error: any) => {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
      setDismissed(true);
    },
  });

  const openMutation = useMutation({
    mutationFn: async (type: CaseType) =>
      authedFetch("/api/cases/open", { type }) as Promise<{ fragment: FragmentDef; caseType: CaseType }>,
    onSuccess: (data) => {
      setCaseResult(data.fragment);
      setOpenCaseType(data.caseType || "inspire");
    },
    onError: (error: any) => {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
    },
  });

  const dismiss = () => {
    sessionStorage.setItem(dismissedKey, "1");
    setDismissed(true);
  };

  const days = useMemo(() => Array.from({ length: REWARD_CYCLE_DAYS }, (_, i) => i + 1), []);

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) dismiss();
        }}
      >
        <DialogContent className="glass-panel max-w-md border-primary/30 overflow-hidden text-center">
          <button
            onClick={dismiss}
            aria-label={t("later")}
            className="absolute right-3 top-3 z-10 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>

          {phase === "ready" && (
            <motion.div initial={{ scale: 0.94, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="space-y-4 pt-1">
              <div>
                <h3 className="text-xl font-bold font-display">{t("dailyRewardReady")}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{t("dailyRewardNote")}</p>
              </div>

              {/* PUBG-style 7-day reward calendar */}
              <div className="grid grid-cols-4 gap-2">
                {days.map((day) => {
                  const isGold = day === GOLD_CASE_DAY;
                  const isClaimed = day <= claimedInCycle;
                  const isNext = day === nextCycleDay;
                  const caseMeta = CASES[caseTypeForCycleDay(day)];
                  return (
                    <motion.div
                      key={day}
                      animate={isNext ? { scale: [1, 1.05, 1] } : { scale: 1 }}
                      transition={isNext ? { duration: 1.6, repeat: Infinity, ease: "easeInOut" } : undefined}
                      className={cn(
                        "relative flex flex-col items-center justify-center gap-1 rounded-2xl border px-1 py-3 transition-colors",
                        isGold ? "border-amber-500/50" : "border-border/60",
                        isClaimed && "bg-muted/40 opacity-55",
                        isNext && (isGold
                          ? "bg-amber-500/15 shadow-[0_0_22px_-4px_rgba(245,158,11,0.7)]"
                          : "bg-primary/15 shadow-[0_0_22px_-4px_hsl(var(--primary)/0.7)]"),
                        !isClaimed && !isNext && "bg-card/50",
                      )}
                    >
                      {isClaimed ? (
                        <span
                          className={cn(
                            "flex h-9 w-9 items-center justify-center rounded-full",
                            isGold ? "bg-amber-500/20 text-amber-400" : "bg-primary/20 text-primary",
                          )}
                        >
                          <Check className="h-5 w-5" />
                        </span>
                      ) : isGold ? (
                        <Crown className={cn("h-9 w-9", isNext ? "text-amber-400" : "text-amber-400/60")} />
                      ) : (
                        <Gem className={cn("h-8 w-8", isNext ? "text-primary" : "text-muted-foreground/60")} />
                      )}
                      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        {t("dayN").replace("{n}", String(day))}
                      </span>
                      <span
                        className={cn(
                          "max-w-full truncate px-1 text-[9px] font-semibold leading-tight",
                          isGold ? "text-amber-400" : "text-muted-foreground",
                        )}
                      >
                        {isGold ? t("goldCase") : t("inspireCase")}
                      </span>
                      {/* gold day badge */}
                      {isGold && !isClaimed && (
                        <span className="absolute -right-1 -top-1 rounded-full bg-amber-500 px-1.5 py-0.5 text-[8px] font-black uppercase text-black">
                          10k$
                        </span>
                      )}
                      {/* claimed tick on the corner */}
                      {isClaimed && (
                        <span className="absolute right-1 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-success text-success-foreground">
                          <Check className="h-2.5 w-2.5" />
                        </span>
                      )}
                      {/* tiny hidden case name for a11y */}
                      <span className="sr-only">{caseMeta.name}</span>
                    </motion.div>
                  );
                })}
                {/* streak tile fills the 8th grid slot */}
                <div className="flex flex-col items-center justify-center gap-0.5 rounded-2xl border border-orange-500/30 bg-orange-500/10 px-1 py-3">
                  <span className="text-lg font-black leading-none text-orange-400">{streak}</span>
                  <span className="text-[9px] font-bold uppercase tracking-wide text-orange-400/80">🔥 {t("streakLabel")}</span>
                </div>
              </div>

              <p className="text-xs font-medium text-muted-foreground">
                {t("dailyRewardToday").replace("{case}", CASES[nextCaseType].name)}
              </p>

              <Button
                size="lg"
                className={cn(
                  "w-full rounded-xl font-semibold",
                  nextIsGold && "bg-gradient-to-r from-amber-500 to-yellow-400 text-black hover:from-amber-400 hover:to-yellow-300",
                )}
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
              <div
                className={cn(
                  "mx-auto flex h-24 w-24 items-center justify-center rounded-3xl border",
                  granted?.caseType === "gold"
                    ? "border-amber-500/40 bg-gradient-to-br from-amber-400/30 via-amber-500/10 to-transparent shadow-[0_0_40px_-8px_rgba(245,158,11,0.7)]"
                    : "border-primary/30 bg-gradient-to-br from-primary/25 via-primary/10 to-transparent shadow-[0_0_40px_-8px_hsl(var(--primary)/0.6)]",
                )}
              >
                {granted?.caseType === "gold" ? <Crown className="h-11 w-11 text-amber-400" /> : <Gem className="h-11 w-11 text-primary" />}
              </div>
              <div>
                <h3 className="flex items-center justify-center gap-2 text-xl font-bold font-display">
                  <BadgeCheck className="h-5 w-5 text-emerald-400" />
                  {granted?.caseType === "gold" ? t("dailyRewardGotGold") : t("dailyRewardGot")}
                </h3>
                <p className="mt-1 text-sm font-semibold text-muted-foreground">
                  +1 {granted?.caseName}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">{t("dailyRewardOpenNow")}</p>
              </div>
              <Button
                size="lg"
                className={cn(
                  "w-full rounded-xl font-semibold",
                  granted?.caseType === "gold" && "bg-gradient-to-r from-amber-500 to-yellow-400 text-black hover:from-amber-400 hover:to-yellow-300",
                )}
                disabled={openMutation.isPending}
                onClick={() => {
                  setPhase("opening");
                  openMutation.mutate(granted?.caseType || "inspire");
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
        caseType={openCaseType}
        onClose={() => {
          setCaseResult(null);
          dismiss();
          invalidate();
        }}
      />
    </>
  );
}
