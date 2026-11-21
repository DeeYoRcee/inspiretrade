import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useMutation } from "@tanstack/react-query";
import {
  Coins, Gift, PackageOpen, Gem, Layers, Crown, ChevronRight, BadgeCheck, Lock, Check, Briefcase,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language-context";
import { authedFetch } from "@/lib/api";
import {
  useEconomy, useInventory, useClaims, useEconomyInvalidator, todayTashkent,
} from "@/hooks/use-economy";
import { usePremiumStatus, useUserProfile } from "@/hooks/use-premium";
import { CaseOpeningDialog } from "@/components/rewards/CaseOpeningDialog";
import { FragmentCard } from "@/components/rewards/FragmentCard";
import {
  FRAGMENTS, GOLD_FRAGMENTS, TRADING_FRAGMENTS, CASES, REWARD_CYCLE_DAYS, GOLD_CASE_DAY,
  cycleDayOf, caseTypeForCycleDay,
  type FragmentDef, type CaseType,
} from "@shared/fragments";
import { cn } from "@/lib/utils";

interface ClaimResponse {
  economy: { streak: number };
  reward: { cycleDay: number; caseType: CaseType; caseName: string };
  vipReward?: { cycleDay: number; caseType: string; caseName: string } | null;
}

export default function RewardsPage() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const { data: premiumStatus } = usePremiumStatus();
  const { data: profile } = useUserProfile();
  // Phase 32: VIPs build the second 7-day track (owner counts as VIP too).
  const isVip = premiumStatus === true || profile?.isPremium === true || profile?.ceo === true;
  const { data: economy } = useEconomy();
  const { data: inventory } = useInventory();
  const { data: claims } = useClaims();
  const invalidate = useEconomyInvalidator();

  const [caseResult, setCaseResult] = useState<FragmentDef | null>(null);
  const [openCaseType, setOpenCaseType] = useState<CaseType>("inspire");
  const [combineConfirm, setCombineConfirm] = useState<CaseType | null>(null);
  const [combineSuccess, setCombineSuccess] = useState<{ reference: string } | null>(null);

  const coins = economy?.coins ?? 0;
  const cases = economy?.cases ?? 0;
  const goldCases = economy?.goldCases ?? 0;
  const tradingCases = economy?.tradingCases ?? 0;

  // daily claim state — 7-day cycle (day 7 = Gold Case), no streak display
  // Number() guard — a streak stored as a string would break the cycle math
  const streak = Number(economy?.streak) || 0;
  const lastClaimDate = economy?.lastClaimDate;
  const claimedToday = lastClaimDate === todayTashkent();
  const claimedInCycle = claimedToday ? cycleDayOf(streak) : streak % REWARD_CYCLE_DAYS;
  const nextCycleDay = (claimedInCycle % REWARD_CYCLE_DAYS) + 1;
  const nextCaseType = caseTypeForCycleDay(nextCycleDay);
  const nextIsGold = nextCaseType === "gold";

  const ownedTypes = useMemo(
    () => FRAGMENTS.filter((f) => (inventory?.[f.id] || 0) >= 1).length,
    [inventory],
  );
  const ownedGoldTypes = useMemo(
    () => GOLD_FRAGMENTS.filter((f) => (inventory?.[f.id] || 0) >= 1).length,
    [inventory],
  );
  const canCombine = ownedTypes === FRAGMENTS.length;
  const ownedTradingTypes = useMemo(
    () => TRADING_FRAGMENTS.filter((f) => (inventory?.[f.id] || 0) >= 1).length,
    [inventory],
  );
  const canCombineGold = ownedGoldTypes === GOLD_FRAGMENTS.length;
  const canCombineTrading = ownedTradingTypes === TRADING_FRAGMENTS.length;

  const claimMutation = useMutation({
    mutationFn: async () => authedFetch("/api/rewards/claim", {}) as Promise<ClaimResponse>,
    onSuccess: (data) => {
      invalidate();
      toast({
        title: t("claimSuccess"),
        description: t("claimSuccessCase").replace("{case}", data.reward.caseName),
      });
    },
    onError: (error: any) => {
      if (error?.code === "ALREADY_CLAIMED_TODAY") {
        toast({ title: t("alreadyClaimed") });
        invalidate();
      } else {
        toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
      }
    },
  });

  const openMutation = useMutation({
    mutationFn: async (type: CaseType) => {
      const res = await authedFetch("/api/cases/open", { type });
      return res as { fragment: FragmentDef; caseType: CaseType };
    },
    onSuccess: (data) => {
      setCaseResult(data.fragment);
      setOpenCaseType(data.caseType || "inspire");
    },
    onError: (error: any) => {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
    },
  });

  const combineMutation = useMutation({
    mutationFn: async (set: CaseType) => {
      const res = await authedFetch("/api/fragments/combine", { set });
      return res as { claim: { reference: string } };
    },
    onSuccess: (data) => {
      setCombineConfirm(null);
      setCombineSuccess(data.claim);
      invalidate();
    },
    onError: (error: any) => {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
    },
  });

  return (
    <div className="container mx-auto max-w-5xl space-y-6 p-4 sm:px-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t("rewards")}</h1>
          <p className="text-sm text-muted-foreground">{t("rewardsSubtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1.5 rounded-full border-border/60 bg-card/60 px-3 py-1.5 text-sm font-bold text-amber-400">
            <Coins className="h-4 w-4" /> {coins} INSP
          </Badge>
          {/* Phase 33: only the INSP balance stays here — per-case counts live in the Cases card below */}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Daily claim — spans both rows on desktop: the left column is one
            tall card, Cases + VIP stack on the right */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="lg:row-span-2">
          <Card className="glass-panel h-full border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg"><Gift className="h-5 w-5 text-primary" />{t("dailyReward")}</CardTitle>
            </CardHeader>
            <CardContent className="flex h-full flex-col justify-between gap-4">
              <div className="grid grid-cols-4 gap-2">
                {Array.from({ length: REWARD_CYCLE_DAYS }, (_, i) => i + 1).map((day) => {
                  const isGold = day === GOLD_CASE_DAY;
                  const isClaimed = day <= claimedInCycle;
                  const isNext = !claimedToday && day === nextCycleDay;
                  return (
                    <div
                      key={day}
                      className={cn(
                        "relative flex flex-col items-center justify-center gap-1 rounded-xl border px-1 py-2",
                        isGold ? "border-amber-500/50" : "border-border/60",
                        isClaimed && "bg-muted/40 opacity-55",
                        isNext && (isGold ? "bg-amber-500/15" : "bg-primary/15"),
                        !isClaimed && !isNext && "bg-card/50",
                      )}
                    >
                      {isClaimed ? (
                        <Check className={cn("h-5 w-5", isGold ? "text-amber-400/80" : "text-primary/80")} />
                      ) : isGold ? (
                        <Crown className={cn("h-5 w-5", isNext ? "text-amber-400" : "text-amber-400/60")} />
                      ) : (
                        <Gem className={cn("h-5 w-5", isNext ? "text-primary" : "text-muted-foreground/60")} />
                      )}
                      <span className="text-[9px] font-bold uppercase tracking-wide text-muted-foreground">
                        {t("dayN").replace("{n}", String(day))}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="space-y-4">
                <p className="text-xs text-muted-foreground">
                  {claimedToday
                    ? t("dailyComeBackTomorrow")
                    : t("dailyRewardToday").replace("{case}", CASES[nextCaseType].name)}
                </p>
                <Button
                  size="lg"
                  className={cn(
                    "w-full rounded-xl font-semibold",
                    nextIsGold && !claimedToday && "bg-gradient-to-r from-amber-500 to-yellow-400 text-black hover:from-amber-400 hover:to-yellow-300",
                  )}
                  disabled={claimedToday || claimMutation.isPending}
                  onClick={() => claimMutation.mutate()}
                >
                  {claimedToday ? (
                    <><BadgeCheck className="mr-2 h-5 w-5" />{t("claimedToday")}</>
                  ) : claimMutation.isPending ? (
                    t("claiming")
                  ) : (
                    <><Gift className="mr-2 h-5 w-5" />{t("claimReward")}</>
                  )}
                </Button>
                <p className="text-[11px] leading-relaxed text-muted-foreground">{t("dailyCycleNote")}</p>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Cases — Inspire + Gold */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.05 }} className="lg:row-span-2">
          <Card className="glass-panel h-full border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg"><PackageOpen className="h-5 w-5 text-primary" />{t("casesTitle")}</CardTitle>
            </CardHeader>
            {/* Phase 34: content spreads across the full stretched height */}
            <CardContent className="flex flex-1 flex-col justify-between gap-5">
              {/* Inspire Case */}
              <div className="flex items-center gap-4">
                <div className="relative flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/20 via-primary/5 to-transparent shadow-[0_0_24px_-6px_hsl(var(--primary)/0.5)]">
                  <Gem className="h-7 w-7 text-primary" />
                  <span className="absolute -right-2 -top-2 rounded-full bg-primary px-2 py-0.5 text-xs font-bold text-primary-foreground">{cases}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{t("inspireCase")} · 5k$ Prop</p>
                </div>
                <Button
                  size="sm"
                  className="shrink-0 rounded-xl font-semibold"
                  disabled={cases < 1 || openMutation.isPending}
                  onClick={() => openMutation.mutate("inspire")}
                >
                  <ChevronRight className="mr-1 h-4 w-4" />{t("openCase")}
                </Button>
              </div>

              {/* Gold Case */}
              <div className="flex items-center gap-4">
                <div className="relative flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-amber-500/40 bg-gradient-to-br from-amber-500/25 via-amber-500/5 to-transparent shadow-[0_0_24px_-6px_rgba(245,158,11,0.6)]">
                  <Crown className="h-7 w-7 text-amber-400" />
                  <span className="absolute -right-2 -top-2 rounded-full bg-amber-500 px-2 py-0.5 text-xs font-bold text-black">{goldCases}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{t("goldCase")} · 10k$ Prop</p>
                </div>
                <Button
                  size="sm"
                  className="shrink-0 rounded-xl bg-amber-500 font-semibold text-black hover:bg-amber-400"
                  disabled={goldCases < 1 || openMutation.isPending}
                  onClick={() => openMutation.mutate("gold")}
                >
                  <ChevronRight className="mr-1 h-4 w-4" />{t("openCase")}
                </Button>
              </div>
{/* Trading Case — Phase 32: the $25,000 account puzzle (VIP day 7) */}
              <div className="flex items-center gap-4">
                <div className="relative flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-emerald-500/40 bg-gradient-to-br from-emerald-500/25 via-emerald-500/5 to-transparent shadow-[0_0_24px_-6px_rgba(16,185,129,0.6)]">
                  <Briefcase className="h-7 w-7 text-emerald-400" />
                  <span className="absolute -right-2 -top-2 rounded-full bg-emerald-500 px-2 py-0.5 text-xs font-bold text-black">{tradingCases}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Trading Case · 25k$ Prop</p>
                </div>
                <Button
                  size="sm"
                  className="shrink-0 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-400 font-semibold text-black hover:from-emerald-400 hover:to-teal-300"
                  disabled={tradingCases < 1 || openMutation.isPending}
                  onClick={() => openMutation.mutate("trading")}
                >
                  <ChevronRight className="mr-1 h-4 w-4" />{t("openCase")}
                </Button>
              </div>

              {cases < 1 && goldCases < 1 && tradingCases < 1 && (
                <p className="text-center text-xs text-muted-foreground">{t("noCases")}</p>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* VIP Reward — Phase 34b: moved to the RIGHT column (under Cases)
            to fill the empty area the user pointed at */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.06 }} className="lg:col-start-2">
          <Card className={cn("glass-panel h-full border-emerald-500/25", !isVip && "opacity-80")}>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between gap-2 text-lg">
                <span className="flex items-center gap-2"><Crown className="h-5 w-5 text-amber-400" />{t("vipReward")}</span>
                {isVip ? (
                  <Badge variant="outline" className="border-emerald-500/50 text-emerald-400">VIP</Badge>
                ) : (
                  <Badge variant="outline" className="gap-1 border-border/60 text-muted-foreground"><Lock className="h-3 w-3" /> VIP only</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {isVip ? (
                <>
                  {/* Phase 33: one row of seven so the card never wraps */}
                  <div className="grid grid-cols-7 gap-1.5">
                    {Array.from({ length: REWARD_CYCLE_DAYS }, (_, i) => i + 1).map((day) => {
                      const isTradingDay = day === REWARD_CYCLE_DAYS;
                      const vipDay = claimedToday ? cycleDayOf(Math.max(1, Number(economy?.vipStreak) || 1)) : cycleDayOf((Number(economy?.vipStreak) || 0) + 1);
                      const vipClaimed = claimedToday && day <= vipDay;
                      const vipNext = !claimedToday && day === vipDay;
                      return (
                        <div
                          key={`vip-${day}`}
                          className={cn(
                            "relative flex flex-col items-center justify-center gap-1 rounded-xl border px-0.5 py-2",
                            isTradingDay ? "border-emerald-500/50" : "border-amber-500/40",
                            vipClaimed && "bg-muted/40 opacity-55",
                            vipNext && (isTradingDay ? "bg-emerald-500/15 shadow-[0_0_22px_-4px_rgba(16,185,129,0.7)]" : "bg-amber-500/15"),
                            !vipClaimed && !vipNext && "bg-card/50",
                          )}
                        >
                          {vipClaimed ? (
                            <span className={cn("flex h-7 w-7 items-center justify-center rounded-full", isTradingDay ? "bg-emerald-500/20 text-emerald-400" : "bg-amber-500/20 text-amber-400")}>
                              <Check className="h-5 w-5" />
                            </span>
                          ) : isTradingDay ? (
                            <Briefcase className="h-6 w-6 text-emerald-400" />
                          ) : (
                            <Crown className={cn("h-6 w-6", vipNext ? "text-amber-400" : "text-amber-400/60")} />
                          )}
                          <span className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">{t("dayN").replace("{n}", String(day))}</span>
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
                  <p className="text-xs text-muted-foreground">
                    {claimedToday ? t("dailyComeBackTomorrow") : t("vipRewardNote")}
                  </p>
                </>
              ) : (
                <div className="flex flex-col items-center gap-3 py-4 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-amber-500/40 bg-amber-500/10">
                    <Lock className="h-6 w-6 text-amber-400" />
                  </div>
                  <p className="max-w-[300px] text-xs leading-relaxed text-muted-foreground">{t("vipRewardLocked")}</p>
                  <Button size="sm" variant="outline" className="border-amber-500/50 text-amber-300" onClick={() => (window.location.href = "/premium")}>
                    {t("getPremium")}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Inventory — 5k$ set */}
      <Card className="glass-panel border-border/50">
        <CardHeader className="pb-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-lg"><Layers className="h-5 w-5 text-primary" />{t("inventoryTitle")} · 5k$ Prop</CardTitle>
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-muted-foreground">{ownedTypes}/{FRAGMENTS.length}</span>
              <Progress value={(ownedTypes / FRAGMENTS.length) * 100} className="h-1.5 w-28" />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {FRAGMENTS.map((fragment) => {
              const count = inventory?.[fragment.id] || 0;
              return (
                <FragmentCard
                  key={fragment.id}
                  fragmentId={fragment.id}
                  count={count}
                  highlight={count > 0 && fragment.rarity === "mythic"}
                  className={count === 0 ? "opacity-45 grayscale" : undefined}
                />
              );
            })}
          </div>
          <div className="flex flex-col items-center gap-2">
            <Button
              size="lg"
              className="w-full max-w-md rounded-xl bg-amber-500 font-semibold text-black hover:bg-amber-400"
              disabled={!canCombine || combineMutation.isPending}
              onClick={() => setCombineConfirm("inspire")}
            >
              <Lock className="mr-2 h-5 w-5" />{t("combineButton")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {canCombine ? t("combineReady") : t("missingFragmentsHint")}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Inventory — 10k$ gold set */}
      <Card className="glass-panel border-amber-500/25">
        <CardHeader className="pb-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-lg"><Crown className="h-5 w-5 text-amber-400" />{t("inventoryTitle")} · 10k$ Prop</CardTitle>
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-muted-foreground">{ownedGoldTypes}/{GOLD_FRAGMENTS.length}</span>
              <Progress value={(ownedGoldTypes / GOLD_FRAGMENTS.length) * 100} className="h-1.5 w-28" />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {GOLD_FRAGMENTS.map((fragment) => {
              const count = inventory?.[fragment.id] || 0;
              return (
                <FragmentCard
                  key={fragment.id}
                  fragmentId={fragment.id}
                  count={count}
                  highlight={count > 0 && fragment.rarity === "mythic"}
                  className={count === 0 ? "opacity-45 grayscale" : undefined}
                />
              );
            })}
          </div>
          <div className="flex flex-col items-center gap-2">
            <Button
              size="lg"
              className="w-full max-w-md rounded-xl bg-gradient-to-r from-amber-500 to-yellow-400 font-bold text-black hover:from-amber-400 hover:to-yellow-300"
              disabled={!canCombineGold || combineMutation.isPending}
              onClick={() => setCombineConfirm("gold")}
            >
              <Lock className="mr-2 h-5 w-5" />{t("combineButtonGold")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {canCombineGold ? t("combineReady") : t("missingFragmentsHint")}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Inventory — 25k$ trading set (Phase 32) */}
      <Card className="glass-panel border-emerald-500/25">
        <CardHeader className="pb-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-lg"><Briefcase className="h-5 w-5 text-emerald-400" />{t("inventoryTitle")} · 25k$ Prop</CardTitle>
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-muted-foreground">{ownedTradingTypes}/{TRADING_FRAGMENTS.length}</span>
              <Progress value={(ownedTradingTypes / TRADING_FRAGMENTS.length) * 100} className="h-1.5 w-28" />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {TRADING_FRAGMENTS.map((fragment) => {
              const count = inventory?.[fragment.id] || 0;
              return (
                <FragmentCard
                  key={fragment.id}
                  fragmentId={fragment.id}
                  count={count}
                  highlight={count > 0 && fragment.rarity === "mythic"}
                  className={count === 0 ? "opacity-45 grayscale" : undefined}
                />
              );
            })}
          </div>
          <div className="flex flex-col items-center gap-2">
            <Button
              size="lg"
              className="w-full max-w-md rounded-xl bg-gradient-to-r from-emerald-500 to-teal-400 font-bold text-black hover:from-emerald-400 hover:to-teal-300"
              disabled={!canCombineTrading || combineMutation.isPending}
              onClick={() => setCombineConfirm("trading")}
            >
              <Lock className="mr-2 h-5 w-5" />Combine into 25k$ Prop Account
            </Button>
            <p className="text-xs text-muted-foreground">
              {canCombineTrading ? t("combineReady") : t("missingFragmentsHint")}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Claims */}
      {claims && claims.length > 0 && (
        <Card className="glass-panel border-border/50">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-lg"><BadgeCheck className="h-5 w-5 text-success" />{t("claimsTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {claims.slice(0, 5).map((claim) => (
              <div key={claim.id} className="flex items-center justify-between rounded-xl border border-border/50 bg-card/50 px-4 py-2.5">
                <span className="font-number text-sm font-bold">{claim.reference}</span>
                <div className="flex items-center gap-2">
                  {claim.set === "gold" && (
                    <Badge className="rounded-full border border-amber-500/30 bg-amber-500/10 text-[10px] font-bold uppercase text-amber-400">10k$ Prop</Badge>
                  )}
                  <span className="text-xs text-muted-foreground">{new Date(claim.createdAt).toLocaleDateString()}</span>
                  <Badge className="rounded-full bg-amber-500/15 text-[10px] font-bold uppercase text-amber-500">{claim.status}</Badge>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Case opening reel */}
      <CaseOpeningDialog
        open={!!caseResult}
        result={caseResult}
        caseType={openCaseType}
        onClose={() => {
          setCaseResult(null);
          invalidate();
        }}
      />

      {/* Combine confirm */}
      <AlertDialog open={combineConfirm !== null} onOpenChange={(o) => !o && setCombineConfirm(null)}>
        <AlertDialogContent className="glass-panel border-border/60">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 font-display"><Crown className="h-5 w-5 text-amber-400" />{t("combineTitle")}</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              {combineConfirm === "gold" ? t("combineDescriptionGold") : combineConfirm === "trading" ? "This burns one of each 25k$ fragment (9 total) and creates a $25,000 prop-account claim for the team to review." : t("combineDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl">{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="rounded-xl bg-amber-500 font-semibold text-black hover:bg-amber-400"
              disabled={combineMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (combineConfirm) combineMutation.mutate(combineConfirm);
              }}
            >
              {combineMutation.isPending ? t("combining") : t("combineButton")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Combine success */}
      <Dialog open={!!combineSuccess} onOpenChange={(open) => !open && setCombineSuccess(null)}>
        <DialogContent className="glass-panel max-w-md border-amber-500/30 text-center">
          <DialogHeader className="items-center">
            <DialogTitle className="flex items-center justify-center gap-2"><Crown className="h-6 w-6 text-amber-400" />{t("combineSuccessTitle")}</DialogTitle>
            <DialogDescription>{t("combineSuccessBody")}</DialogDescription>
          </DialogHeader>
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
            <p className="font-number text-2xl font-bold tracking-wider text-amber-400">{combineSuccess?.reference}</p>
          </div>
          <p className="text-xs text-muted-foreground">{t("combineSuccessNote")}</p>
          <Button className="rounded-xl" onClick={() => setCombineSuccess(null)}>{t("cancel")}</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
