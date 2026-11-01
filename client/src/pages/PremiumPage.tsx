import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Crown, Check, Zap, Star, Shield, TrendingUp, Loader as Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language-context";

const PLANS = [
  {
    key: "monthly",
    labelKey: "monthlyPlan",
    price: "$3.99",
    periodKey: "perMonth",
    descKey: "cancelAnytime",
    highlight: false,
  },
  {
    key: "yearly",
    labelKey: "yearlyPlan",
    price: "$24.99",
    periodKey: "perYear",
    descKey: "yearlyDesc",
    highlight: true,
    badgeKey: "mostPopular",
  },
  {
    key: "lifetime",
    labelKey: "lifetimePlan",
    price: "$109.99",
    period: "",
    descKey: "lifetimeDesc",
    highlight: false,
    badgeKey: "lifetimeBadge",
  },
];

const FEATURES = [
  { icon: <Crown className="w-4 h-4" />, textKey: "premiumBadge" },
  { icon: <TrendingUp className="w-4 h-4" />, textKey: "leaderboardUsername" },
  { icon: <Star className="w-4 h-4" />, textKey: "topTraderRanking" },
  { icon: <Shield className="w-4 h-4" />, textKey: "futureFeatures" },
  { icon: <Zap className="w-4 h-4" />, textKey: "prioritySupport" },
];

export default function PremiumPage({ onClose }: { onClose?: () => void }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const { t } = useLanguage();
  const [loading, setLoading] = useState<string | null>(null);

  const handleCheckout = async (planKey: string) => {
    if (!user) {
      toast({ title: t("signInFirst"), variant: "destructive" });
      return;
    }
    setLoading(planKey);
    try {
      const res = await fetch("/api/whop/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planKey,
          firebaseUid: user.uid,
        }),
      });
      const data = await res.json();
      if (data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
      } else {
        throw new Error(data.error || t("checkoutUnavailable"));
      }
    } catch (e: any) {
      toast({ title: t("error"), description: e.message, variant: "destructive" });
    } finally {
      setLoading(null);
    }
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
          <span className="text-sm font-semibold text-primary">Trade Journal Premium</span>
        </div>
          <h1 className="text-4xl font-display font-bold mb-3">
           {t("becomeProfessional")}
        </h1>
        <p className="text-muted-foreground max-w-md mx-auto">
           {t("premiumDescription")}
        </p>
      </motion.div>

      {/* Plans */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 w-full max-w-3xl mb-10">
        {PLANS.map((plan, i) => (
          <motion.div
            key={plan.key}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.1 }}
          >
            <Card className={cn(
              "glass-panel relative overflow-hidden transition-all cursor-pointer",
              plan.highlight
                ? "border-primary ring-2 ring-primary/40 scale-105 shadow-[0_0_30px_hsl(var(--primary)/0.2)]"
                : "border-border/50 hover:border-primary/40"
            )}>
              {plan.badgeKey && (
                <div className="absolute top-0 inset-x-0 bg-primary text-primary-foreground text-xs font-bold py-1 text-center">
                   {t(plan.badgeKey as Parameters<typeof t>[0])}
                </div>
              )}
              <CardContent className={cn("p-6", plan.badgeKey && "pt-8")}>
                 <h3 className="text-lg font-display font-bold mb-1">{t(plan.labelKey as Parameters<typeof t>[0])}</h3>
                <div className="flex items-baseline gap-1 mb-1">
                  <span className="text-3xl font-bold font-number">{plan.price}</span>
                   {plan.periodKey && <span className="text-muted-foreground text-sm">{t(plan.periodKey as Parameters<typeof t>[0])}</span>}
                </div>
                 <p className="text-xs text-muted-foreground mb-5">{t(plan.descKey as Parameters<typeof t>[0])}</p>
                <Button
                  className={cn("w-full gap-2", plan.highlight && "bg-primary hover:bg-primary/90")}
                  variant={plan.highlight ? "default" : "outline"}
                  onClick={() => handleCheckout(plan.key)}
                  disabled={!!loading}
                >
                  {loading === plan.key
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <Crown className="w-4 h-4" />}
                   {t("purchase")}
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Features */}
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
