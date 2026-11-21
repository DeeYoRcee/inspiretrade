import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Users, Package, Gem, Coins, CheckCircle2, Gift } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { authedFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { REFERRAL_MILESTONES } from "@shared/fragments";
import { useLanguage } from "@/lib/language-context";

/**
 * Phase 32 — referral milestone rewards (claimed one-time per tier):
 *   3 invited → 1 InspireCase · 10 → 3 InspireCase · 25 → 5 InspireCase +
 *   1 GoldCase · 50 → 7 InspireCase + 3 GoldCase + 5 INSP · 100 → 10
 *   InspireCase + 5 GoldCase + 10 INSP. Server-verified (referrals count)
 * and transactional (a tier can be claimed exactly once).
 */

interface MilestoneTier { invited: number; cases: number; goldCases: number; insp: number }
interface ReferralInfo {
  ok: boolean;
  code: string;
  invited: number;
  milestones?: MilestoneTier[];
  claimedMilestones?: number[];
}

export function ReferralMilestones() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["referralInfo"],
    queryFn: async () => (await authedFetch("/api/referral?action=info")) as unknown as ReferralInfo,
    staleTime: 30_000,
  });

  const claim = useMutation({
    mutationFn: async (tier: number) =>
      authedFetch("/api/referral?action=milestone", { tier }),
    onSuccess: () => {
      toast({ title: "Reward claimed", description: "Cases and INSP were added to your account." });
      queryClient.invalidateQueries({ queryKey: ["referralInfo"] });
      queryClient.invalidateQueries({ queryKey: ["economy"] });
    },
    onError: (e: any) => {
      toast({ title: t("error"), description: e?.message || "Could not claim the reward", variant: "destructive" });
    },
  });

  const invited = data?.invited ?? 0;
  const claimed = new Set(data?.claimedMilestones ?? []);
  const tiers = data?.milestones ?? REFERRAL_MILESTONES;

  return (
    <Card className="glass-panel border-border/50">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Gift className="h-5 w-5 text-violet-400" />
          Referral milestones
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          One-time rewards for every referral milestone — invited so far: <span className="font-semibold text-foreground">{invited}</span>
        </p>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {/* Phase 33: compact — five tiles in one row on desktop, 2-3 on mobile */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {tiers.map((tier, i) => {
            const reached = invited >= tier.invited;
            const isClaimed = claimed.has(i);
            return (
              <div
                key={tier.invited}
                className={cn(
                  "flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-center transition-all",
                  isClaimed ? "border-success/40 bg-success/5"
                    : reached ? "border-primary/40 bg-primary/5"
                    : "border-border/50 bg-card/40",
                )}
              >
                <div className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border font-number text-sm font-bold",
                  isClaimed ? "border-success/50 text-success" : reached ? "border-primary/50 text-primary" : "border-border/60 text-muted-foreground",
                )}>
                  {tier.invited}
                </div>
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">referrals</p>
                <div className="flex flex-wrap items-center justify-center gap-1">
                  {tier.cases > 0 && (
                    <span className="inline-flex items-center gap-0.5 rounded-full bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-bold text-sky-400">
                      <Package className="h-2.5 w-2.5" />{tier.cases}
                    </span>
                  )}
                  {tier.goldCases > 0 && (
                    <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-bold text-amber-400">
                      <Gem className="h-2.5 w-2.5" />{tier.goldCases}
                    </span>
                  )}
                  {tier.insp > 0 && (
                    <span className="inline-flex items-center gap-0.5 rounded-full bg-yellow-500/10 px-1.5 py-0.5 text-[9px] font-bold text-yellow-500">
                      <Coins className="h-2.5 w-2.5" />{tier.insp}
                    </span>
                  )}
                </div>
                {isClaimed ? (
                  <Badge variant="outline" className="gap-1 border-success/50 text-success">
                    <CheckCircle2 className="h-3 w-3" /> Claimed
                  </Badge>
                ) : (
                  <Button size="sm" className="h-7 px-3 text-xs" disabled={!reached || claim.isPending} onClick={() => claim.mutate(i)}>
                    {claim.isPending && claim.variables === i ? "…" : "Claim"}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Share your referral link (left) — when friends join with it, the counter grows and milestones unlock.
        </p>
      </CardContent>
    </Card>
  );
}
