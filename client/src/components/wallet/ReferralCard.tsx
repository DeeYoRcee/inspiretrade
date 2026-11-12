import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Gift, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language-context";
import { authedFetch } from "@/lib/api";
import { referralLink } from "@/lib/referral";

interface ReferralInfo {
  ok: boolean;
  code: string;
  invited: number;
  earned: number;
  referredByCode: string | null;
  bonuses: { new: number; referrerCase: number };
}

export function ReferralCard() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const { data, isLoading } = useQuery<ReferralInfo>({
    queryKey: ["referral"],
    queryFn: async () => {
      const res = await authedFetch("/api/referral?action=info");
      return res as ReferralInfo;
    },
    staleTime: 60 * 1000,
  });

  // Auto-copy needs the link only after data arrives; nothing else to preload.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    if (!data?.code) return;
    try {
      await navigator.clipboard.writeText(referralLink(data.code));
      setCopied(true);
      toast({ title: t("referralCopied") });
    } catch {
      toast({ title: t("referralCopy"), description: referralLink(data.code) });
    }
  };

  return (
    <Card className="glass-panel border-primary/25">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Gift className="h-5 w-5 text-primary" />
          {t("referralTitle")}
        </CardTitle>
        <p className="text-xs text-muted-foreground">{t("referralSubtitle")}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading || !data ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">{t("referralLinkLabel")}</label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={referralLink(data.code)}
                  onFocus={(e) => e.currentTarget.select()}
                  className="h-11 rounded-xl font-mono text-xs"
                />
                <Button
                  size="icon"
                  className="h-11 w-11 shrink-0 rounded-xl"
                  onClick={copy}
                  aria-label={t("referralCopy")}
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-border/60 bg-card/50 px-4 py-3 text-center">
                <p className="font-number text-2xl font-bold text-primary">{data.invited}</p>
                <p className="text-[11px] text-muted-foreground">{t("referralInvited")}</p>
              </div>
              <div className="rounded-xl border border-border/60 bg-card/50 px-4 py-3 text-center">
                <p className="font-number text-2xl font-bold text-amber-400">{data.earned}</p>
                <p className="text-[11px] text-muted-foreground">{t("referralEarned")}</p>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-xl border border-primary/20 bg-primary/5 px-4 py-2.5 text-xs">
              <span className="text-muted-foreground">{t("referralCode")}</span>
              <span className="font-mono font-bold tracking-widest text-primary">{data.code}</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
