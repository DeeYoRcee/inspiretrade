/**
 * P45 §3/§6/§7 — the Premium pricing page. Exactly two public plans —
 * Monthly $4.99/mo and Yearly $49.99/yr — linking to the OFFICIAL Whop
 * checkout URLs (spec §1). Lifetime Premium is no longer offered (§2) while
 * existing lifetime members keep their access untouched. After a subscribe
 * click the page shows a PENDING-VERIFICATION state until the server-side
 * verified webhook/verify activates the entitlement — it never claims
 * success on its own. Premium users get their subscription status, renewal
 * date and the official Whop management link (§7).
 */
import { motion } from "framer-motion";
import { ArrowLeft, Crown, Check, Zap, Star, Shield, TrendingUp, X, ExternalLink, RefreshCw, Loader2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language-context";
import { useQueryClient } from "@tanstack/react-query";
import { useUserProfile, useWhopSubscription } from "@/hooks/use-premium";
import { WHOP_CHECKOUT_URLS, YEARLY_SAVINGS, whopPendingMs, setWhopPending, clearWhopPending, whopFormatDate, type WhopPlanKey } from "@/lib/whop";

const FEATURES = [
  { icon: <Crown className="w-4 h-4" />, textKey: "premiumBadge" },
  { icon: <TrendingUp className="w-4 h-4" />, textKey: "leaderboardUsername" },
  { icon: <Star className="w-4 h-4" />, textKey: "topTraderRanking" },
  { icon: <Shield className="w-4 h-4" />, textKey: "futureFeatures" },
  { icon: <Zap className="w-4 h-4" />, textKey: "prioritySupport" },
] as const;

type PlanKey = "monthly" | "yearly";

const CARDS: Array<{
  key: PlanKey; labelKey: string; price: string; periodKey: string;
  descKey: string; highlight?: boolean; badgeKey?: string;
}> = [
  { key: "monthly", labelKey: "monthlyPlan", price: "$4.99", periodKey: "perMonth", descKey: "cancelAnytime" },
  { key: "yearly", labelKey: "yearlyPlan", price: "$49.99", periodKey: "perYear", descKey: "yearlyDesc", highlight: true, badgeKey: "mostPopular" },
];

export default function PremiumPage({ onClose }: { onClose?: () => void }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const { t, language } = useLanguage();
  const queryClient = useQueryClient();
  const profile = useUserProfile();
  const sub = useWhopSubscription();
  const pending = whopPendingMs(user?.uid ?? "") != null;
  const isPremiumNow = sub.data?.isPremium === true || profile.data?.isPremium === true;
  const plan: WhopPlanKey | null = sub.data?.plan ?? ((profile.data?.premiumPlan as WhopPlanKey) ?? null);
  const status = sub.data?.status ?? null;
  const manageUrl = sub.data?.manageUrl ?? null;
  const periodEnd = sub.data?.currentPeriodEnd ?? null;

  const statusKey = status === "past_due" ? "whopStatusPastDue"
    : status === "canceling" ? "whopStatusCanceling"
    : "whopStatusActive";

  const onSubscribe = (key: PlanKey) => {
    if (!user) {
      toast({ title: t("signInFirst"), variant: "destructive" });
      return;
    }
    // P45 §6 — mark PENDING (never "active"): activation comes from the
    // verified webhook / server verify only
    setWhopPending(user.uid);
    queryClient.invalidateQueries({ queryKey: ["premiumStatus", user.uid] });
  };

  const reverify = async () => {
    if (!user) return;
    clearWhopPending(user.uid);
    await queryClient.invalidateQueries({ queryKey: ["premiumStatus", user.uid] });
    if (whopPendingMs(user.uid) == null && !isPremiumNow) setWhopPending(user.uid);
  };

  return (
    <div className="relative min-h-screen bg-background flex flex-col items-center justify-center px-4 py-12">
      {onClose && (
        <Button
          variant="ghost"
          onClick={onClose}
          className="absolute top-5 left-5 gap-2 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4" />
          {t("backToDashboard")}
        </Button>
      )}
      {onClose && (
        <button
          onClick={onClose}
          className="absolute top-6 right-6 p-2 rounded-full hover:bg-secondary transition-colors text-muted-foreground"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>
      )}

      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center mb-10"
      >
        <div className="inline-flex items-center gap-2 bg-primary/10 border border-primary/20 rounded-full px-4 py-1.5 mb-4">
          <Crown className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold text-primary">InspireTrade Premium</span>
        </div>
        <h1 className="text-4xl font-display font-bold mb-3">{t("becomeProfessional")}</h1>
        <p className="text-muted-foreground max-w-md mx-auto">{t("premiumDescription")}</p>
      </motion.div>

      {/* §6 — pending verification (webhook has not landed yet) */}
      {pending && !isPremiumNow && (
        <div
          role="status"
          className="w-full max-w-3xl mb-6 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-center text-sm"
        >
          <p className="flex items-center justify-center gap-2 font-semibold">
            <Clock className="w-4 h-4 text-amber-400" />
            {t("whopPending")}
          </p>
          <p className="mt-1 text-muted-foreground">{t("whopPendingDesc")}</p>
          <Button size="sm" variant="outline" className="mt-2 gap-2" onClick={reverify} disabled={sub.isFetching}>
            {sub.isFetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {t("whopVerifyNow")}
          </Button>
        </div>
      )}

      {/* §7 — subscription management for existing premium users */}
      {isPremiumNow && (
        <Card className="glass-panel border-primary/30 w-full max-w-3xl mb-6">
          <CardContent className="p-5">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <div className="flex items-center gap-2">
                <Crown className="w-5 h-5 text-primary" />
                <div>
                  <p className="text-xs text-muted-foreground">{t("whopCurrentPlan")}</p>
                  <p className="font-display font-bold">
                    {plan === "yearly" ? t("yearlyPlan") : plan === "monthly" ? t("monthlyPlan") : plan === "lifetime" ? "Lifetime" : t("monthlyPlan")}
                    {sub.isFetching && <Loader2 className="ms-2 inline w-3 h-3 animate-spin text-muted-foreground" />}
                  </p>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Status</p>
                <p className={cn("text-sm font-semibold", statusKey === "whopStatusActive" ? "text-success" : "text-amber-400")}>
                  {t(statusKey as Parameters<typeof t>[0])}
                </p>
              </div>
              {periodEnd && (
                <div>
                  <p className="text-xs text-muted-foreground">{t("whopRenews")}</p>
                  <p className="text-sm font-semibold font-number">{whopFormatDate(periodEnd, language)}</p>
                </div>
              )}
              <div className="ms-auto flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={reverify} disabled={sub.isFetching} className="gap-1.5">
                  {sub.isFetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                </Button>
                {manageUrl && (
                  <a href={manageUrl} target="_blank" rel="noreferrer">
                    <Button size="sm" variant="outline" className="gap-1.5">
                      {t("whopManage")}
                      <ExternalLink className="w-3.5 h-3.5" />
                    </Button>
                  </a>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full max-w-3xl mb-10">
        {CARDS.map((planCard, i) => (
          <motion.div
            key={planCard.key}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.1 }}
          >
            <Card className={cn(
              "glass-panel relative overflow-hidden transition-all",
              planCard.highlight
                ? "border-primary ring-2 ring-primary/40 shadow-[0_0_30px_hsl(var(--primary)/0.2)]"
                : "border-border/50 hover:border-primary/40"
            )}>
              {planCard.badgeKey && (
                <div className="absolute top-0 inset-x-0 bg-primary text-primary-foreground text-xs font-bold py-1 text-center">
                  {t(planCard.badgeKey as Parameters<typeof t>[0])}
                </div>
              )}
              <CardContent className={cn("p-6", planCard.badgeKey && "pt-8")}>
                <h3 className="text-lg font-display font-bold mb-1">{t(planCard.labelKey as Parameters<typeof t>[0])}</h3>
                <div className="flex items-baseline gap-1 mb-1">
                  <span className="text-3xl font-bold font-number">{planCard.price}</span>
                  <span className="text-muted-foreground text-sm">{t(planCard.periodKey as Parameters<typeof t>[0])}</span>
                </div>
                <p className="text-xs text-muted-foreground mb-1">{t(planCard.descKey as Parameters<typeof t>[0])}</p>
                {planCard.key === "yearly" && (
                  <p className="text-xs font-semibold text-success mb-5">
                    <Check className="inline w-3 h-3 me-1" />
                    {t("whopYearlySave")}
                  </p>
                )}
                {planCard.key === "monthly" && <div className="mb-5" />}
                <Button
                  className={cn("w-full gap-2", planCard.highlight && "bg-primary hover:bg-primary/90")}
                  variant={planCard.highlight ? "default" : "outline"}
                  disabled={isPremiumNow}
                  asChild
                >
                  <a
                    href={WHOP_CHECKOUT_URLS[planCard.key]}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => onSubscribe(planCard.key)}
                  >
                    <Crown className="w-4 h-4" />
                    {t("whopSubscribe")}
                  </a>
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* §3 — the yearly saving, stated with the exact numbers */}
      <p className="text-xs text-muted-foreground mb-10 text-center">
        {t("yearlyPlan")} — $49.99 {t("perYear")} = {t("monthlyPlan")} $4.17 · {t("whopYearlySave")} (${YEARLY_SAVINGS.amount}, −{YEARLY_SAVINGS.percent}%)
      </p>

      <Card className="glass-panel border-border/40 w-full max-w-md">
        <CardContent className="p-6">
          <h3 className="font-display font-semibold mb-4 text-center">{t("premiumFeatures")}</h3>
          <ul className="space-y-3">
            {FEATURES.map((f, i) => (
              <li key={i} className="flex items-center gap-3 text-sm">
                <span className="text-primary">{f.icon}</span>
                <span>{t(f.textKey as Parameters<typeof t>[0])}</span>
                <Check className="w-4 h-4 text-success ml-auto" />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
