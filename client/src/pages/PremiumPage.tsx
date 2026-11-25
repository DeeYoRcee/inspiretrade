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
import { ArrowLeft, Crown, Check, X, ExternalLink, RefreshCw, Loader2, Clock, Gift, Frame as FrameIcon, AtSign, BadgeCheck, Package, Image as ImageIcon, Palette } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language-context";
import { useQueryClient } from "@tanstack/react-query";
import { useUserProfile, useWhopSubscription } from "@/hooks/use-premium";
import { WHOP_CHECKOUT_URLS, whopPendingMs, setWhopPending, clearWhopPending, whopFormatDate, type WhopPlanKey } from "@/lib/whop";

// P64R user request — the perk list now sells the REAL VIP entitlements
// (English copy per user request). Cases: the three case types (Inspire,
// Gold, Trading) are granted once on the first Premium purchase.
const FEATURES = [
  { icon: Gift, tint: "text-violet-400 bg-violet-500/10 border-violet-500/25", title: "VIP rewards", desc: "Exclusive VIP-only rewards dropped on the Rewards page." },
  { icon: FrameIcon, tint: "text-amber-400 bg-amber-500/10 border-amber-500/25", title: "VIP frame", desc: "The gold VIP frame wrapped around your avatar everywhere." },
  { icon: AtSign, tint: "text-sky-400 bg-sky-500/10 border-sky-500/25", title: "Usernames — up to 5", desc: "Hold up to 5 collectible usernames (standard accounts hold 1)." },
  { icon: BadgeCheck, tint: "text-emerald-400 bg-emerald-500/10 border-emerald-500/25", title: "VIP title", desc: "The exclusive VIP title on your profile and public page." },
  { icon: Package, tint: "text-yellow-500 bg-yellow-500/10 border-yellow-500/25", title: "Welcome case bundle", desc: "Inspire, Gold and Trading cases — granted once on your first Premium purchase." },
  { icon: ImageIcon, tint: "text-fuchsia-400 bg-fuchsia-500/10 border-fuchsia-500/25", title: "VIP profile backgrounds", desc: "The Skywalker and Knight profile backgrounds become VIP-only." },
  { icon: Palette, tint: "text-cyan-400 bg-cyan-500/10 border-cyan-500/25", title: "VIP themes", desc: "Formula 1, Money Rain, Cosmos, Neon Grid, Knight and CR7 themes." },
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
  const premiumSince = sub.data?.premiumSince ?? null;

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
              {premiumSince && (
                <div>
                  <p className="text-xs text-muted-foreground">{t("whopMemberSince")}</p>
                  <p className="text-sm font-semibold font-number">{whopFormatDate(new Date(premiumSince).toISOString(), language)}</p>
                </div>
              )}
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

      {isPremiumNow && (
        <p className="flex items-center justify-center gap-2 w-full max-w-3xl mb-4 text-xs text-muted-foreground text-center">
          <Crown className="w-3.5 h-3.5 text-primary shrink-0" />
          {t("whopExtendHint")}
        </p>
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
                {/* P64R2 user request — the savings claim line is removed */}
                <div className="mb-5" />
                <Button
                  className={cn("w-full gap-2", planCard.highlight && "bg-primary hover:bg-primary/90")}
                  variant={planCard.highlight ? "default" : "outline"}
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

      <Card className="glass-panel border-border/40 w-full max-w-lg">
        <CardContent className="p-6">
          <h3 className="font-display font-semibold mb-4 text-center">{t("premiumFeatures")}</h3>
          {/* P64R — richer perk rows: tinted icon chip + title + description */}
          <ul className="space-y-2.5">
            {FEATURES.map((f, i) => (
              <li key={i} className="flex items-start gap-3 rounded-xl border border-border/40 bg-secondary/25 p-3">
                <span className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border", f.tint)}>
                  <f.icon className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{f.title}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{f.desc}</span>
                </span>
                <Check className="mt-1 h-4 w-4 shrink-0 text-success ml-auto" />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
