import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useMutation } from "@tanstack/react-query";
import { Gift, Gem, BadgeCheck, ChevronRight, X, Check, Crown, Briefcase, Lock } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language-context";
import { authedFetch } from "@/lib/api";
import { useEconomy, useEconomyInvalidator, todayTashkent } from "@/hooks/use-economy";
import { useAuth } from "@/hooks/use-auth";
import { usePremiumStatus, useUserProfile } from "@/hooks/use-premium";
import { CaseOpeningDialog } from "@/components/rewards/CaseOpeningDialog";
import {
  REWARD_CYCLE_DAYS, GOLD_CASE_DAY, CASES, cycleDayOf, caseTypeForCycleDay,
  type CaseType, type FragmentDef,
} from "@shared/fragments";
import { cn } from "@/lib/utils";

type Phase = "ready" | "claimed";
interface ClaimResponse {
  economy: { streak: number };
  reward: { cycleDay: number; caseType: CaseType; caseName: string };
  vipReward?: { cycleDay: number; caseType: string; caseName: string } | null;
}

/**
 * Auto-appearing daily reward dialog — PUBG-Mobile-style 7-day login
 * calendar. Days 1-6 grant an Inspire Case (5k$ fragments), day 7 grants
 * the Gold Case (10k$ fragments). Shows on any page when the user has not
 * claimed today's reward yet ("Later" hides it for the rest of the session).
 * No streak display — the flame counter was intentionally removed.
 */
export function DailyRewardDialog() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const { data: premiumStatus } = usePremiumStatus();
  const { data: profile } = useUserProfile();
  // Phase 32: VIPs (premium subscribers and the owner) build a SECOND 7-day
  // track — days 1-6 grant a Gold Case, day 7 the Trading Case (25k$).
  const isVip = premiumStatus === true || profile?.isPremium === true || profile?.ceo === true;
  const { toast } = useToast();
  const { data: economy, isLoading } = useEconomy();
  const invalidate = useEconomyInvalidator();

  const today = todayTashkent();
  const dismissedKey = `daily-reward-dismissed-${today}`;
  const [dismissed, setDismissed] = useState(false);
  const [phase, setPhase] = useState<Phase>("ready");
  // Phase 32b: Daily / VIP tab — the VIP tab is locked for non-premium users
  const [vipTab, setVipTab] = useState(false);
  const [granted, setGranted] = useState<{ caseType: CaseType; caseName: string } | null>(null);
  const [vipGranted, setVipGranted] = useState<{ caseType: CaseType; caseName: string; isTrading: boolean } | null>(null);
  const [caseResult, setCaseResult] = useState<FragmentDef | null>(null);
  const [openCaseType, setOpenCaseType] = useState<CaseType>("inspire");

  useEffect(() => {
    setDismissed(sessionStorage.getItem(dismissedKey) === "1");
  }, [dismissedKey]);

  const claimedToday = economy?.lastClaimDate === today;
  // Phase 32: unverified accounts see the verification gate first — the
  // reward dialog waits until the email is confirmed (user.emailVerified is
  // undefined for loading states, so only an explicit false blocks it).
  // Phase 32b: the dialog STAYS OPEN through the "claimed" phase — closing it
  // instantly after the claim made the "Open case now" button unreachable.
  const open =
    (!!user && user.emailVerified !== false && !isLoading && !claimedToday && !dismissed) ||
    // P49 fix: the claimed phase also closes via Later/X — previously this
    // branch ignored `dismissed`, so the dialog could never be closed after a
    // claim and "Open case now" kept re-opening owned cases non-stop
    (phase === "claimed" && !!granted && !dismissed);

  // Number() guard — a streak stored as a string would break the cycle math
  const streak = Number(economy?.streak) || 0;
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
      setVipGranted(data.vipReward ? {
        caseType: (data.vipReward.caseType === "trading" ? "trading" : "gold") as CaseType,
        caseName: data.vipReward.caseName,
        isTrading: data.vipReward.caseType === "trading",
      } : null);
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
        <DialogContent className="glass-panel max-h-[calc(100dvh-1.5rem)] max-w-md overflow-x-hidden overflow-y-auto border-primary/30 p-4 text-center sm:p-6">
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
                <h3 className="text-xl font-bold font-display">{vipTab ? t("vipReward") : t("dailyRewardReady")}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{t("dailyRewardNote")}</p>
              </div>

              {/* Phase 32b: Daily / VIP tab switcher — VIP locked for regular users */}
              <div className="grid grid-cols-2 gap-2 rounded-xl border border-border/50 bg-secondary/40 p-1">
                <button
                  type="button"
                  onClick={() => setVipTab(false)}
                  className={cn(
                    "flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors",
                    !vipTab ? "bg-primary/20 text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Gift className="h-3.5 w-3.5" />{t("dailyReward")}
                </button>
                <button
                  type="button"
                  onClick={() => setVipTab(true)}
                  className={cn(
                    "flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors",
                    vipTab ? "bg-amber-500/20 text-amber-300 shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {isVip ? <Crown className="h-3.5 w-3.5 text-amber-400" /> : <Lock className="h-3.5 w-3.5" />}
                  {t("vipReward")}
                </button>
              </div>

              {/* 7-day reward calendar — no streak tile */}
              {!vipTab && (<>
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
              </>)}

              {vipTab && isVip && (<>
                <div className="grid grid-cols-4 gap-2">
                  {days.map((day) => {
                    const isTradingDay = day === REWARD_CYCLE_DAYS;
                    const vipDay = cycleDayOf(Math.max(1, claimedToday ? Number(economy?.vipStreak) || 1 : (Number(economy?.vipStreak) || 0) + 1));
                    const vipClaimed = claimedToday && day <= vipDay;
                    const vipNext = !claimedToday && day === vipDay;
                    return (
                      <div
                        key={`vip-${day}`}
                        className={cn(
                          "relative flex flex-col items-center justify-center gap-1 rounded-xl border px-1 py-3",
                          isTradingDay ? "border-emerald-500/50" : "border-amber-500/40",
                          vipClaimed && "bg-muted/40 opacity-55",
                          vipNext && (isTradingDay ? "bg-emerald-500/15 shadow-[0_0_22px_-4px_rgba(16,185,129,0.7)]" : "bg-amber-500/15"),
                          !vipClaimed && !vipNext && "bg-card/50",
                        )}
                      >
                        {vipClaimed ? (
                          <span className={cn("flex h-9 w-9 items-center justify-center rounded-full", isTradingDay ? "bg-emerald-500/20 text-emerald-400" : "bg-amber-500/20 text-amber-400")}>
                            <Check className="h-5 w-5" />
                          </span>
                        ) : isTradingDay ? (
                          <Briefcase className="h-8 w-8 text-emerald-400" />
                        ) : (
                          <Crown className={cn("h-8 w-8", vipNext ? "text-amber-400" : "text-amber-400/60")} />
                        )}
                        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{t("dayN").replace("{n}", String(day))}</span>
                        <span className={cn("max-w-full truncate px-1 text-[9px] font-semibold leading-tight", isTradingDay ? "text-emerald-400" : "text-amber-400")}>
                          {isTradingDay ? "Trading Case" : t("goldCase")}
                        </span>
                        {isTradingDay && !vipClaimed && (
                          <span className="absolute -right-1 -top-1 rounded-full bg-emerald-500 px-1.5 py-0.5 text-[8px] font-black uppercase text-black">25k$</span>
                        )}
                        {vipClaimed && (
                          <span className="absolute right-1 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-success text-success-foreground">
                            <Check className="h-2.5 w-2.5" />
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
                <p className="text-xs font-medium text-muted-foreground">
                  {claimedToday ? t("dailyComeBackTomorrow") : t("vipRewardNote")}
                </p>
                <Button
                  size="lg"
                  className="w-full rounded-xl bg-gradient-to-r from-amber-500 to-yellow-400 font-semibold text-black hover:from-amber-400 hover:to-yellow-300"
                  disabled={claimMutation.isPending}
                  onClick={() => claimMutation.mutate()}
                >
                  {claimMutation.isPending ? t("claiming") : <><Gift className="mr-2 h-5 w-5" />{t("claimReward")}</>}
                </Button>
                <button onClick={dismiss} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
                  {t("later")}
                </button>
              </>)}

              {vipTab && !isVip && (
                <div className="flex flex-col items-center gap-3 rounded-2xl border border-border/50 bg-card/40 px-4 py-8 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-amber-500/40 bg-amber-500/10">
                    <Lock className="h-6 w-6 text-amber-400" />
                  </div>
                  <p className="text-sm font-bold uppercase tracking-wider text-amber-300">VIP only</p>
                  <p className="max-w-[280px] text-xs leading-relaxed text-muted-foreground">{t("vipRewardLocked")}</p>
                </div>
              )}
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
                {vipGranted && (
                  <p className="mt-1 text-sm font-semibold text-emerald-400">
                    <Crown className="mr-1 inline h-4 w-4" /> VIP: +1 {vipGranted.caseName}
                  </p>
                )}
                <p className="mt-1 text-sm text-muted-foreground">{t("dailyRewardOpenNow")}</p>
              </div>
              <Button
                size="lg"
                className={cn(
                  "w-full rounded-xl font-semibold",
                  granted?.caseType === "gold" && "bg-gradient-to-r from-amber-500 to-yellow-400 text-black hover:from-amber-400 hover:to-yellow-300",
                )}
                disabled={openMutation.isPending}
                onClick={() => openMutation.mutate(granted?.caseType || "inspire")}
              >
                {openMutation.isPending ? t("openingCase") : <><ChevronRight className="mr-2 h-5 w-5" />{t("openCaseNow")}</>}
              </Button>
              {vipGranted && (
                <Button
                  size="lg"
                  className="w-full rounded-xl bg-gradient-to-r from-emerald-500 to-emerald-400 font-semibold text-black hover:from-emerald-400 hover:to-emerald-300"
                  disabled={openMutation.isPending}
                  onClick={() => openMutation.mutate(vipGranted.caseType)}
                >
                  <Crown className="mr-2 h-5 w-5" /> VIP: {t("openCaseNow")} ({vipGranted.caseName})
                </Button>
              )}
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
          dismiss(); // P49 — closing the case also closes the reward dialog
          invalidate();
        }}
      />
    </>
  );
}
