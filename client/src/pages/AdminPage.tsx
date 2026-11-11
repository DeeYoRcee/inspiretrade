import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useMutation } from "@tanstack/react-query";
import {
  ShieldCheck, Coins, PackageOpen, Send, Clock, CheckCircle2, XCircle, RefreshCw,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language-context";
import { authedFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Withdrawal {
  id: string;
  uid: string;
  amount: number;
  methodLabel: string;
  details: string;
  status: string;
  at: number;
}

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  paid: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  rejected: "bg-red-500/15 text-red-400 border-red-500/30",
};

export default function AdminPage() {
  const { t } = useLanguage();
  const { toast } = useToast();

  // Gift form
  const [target, setTarget] = useState("");
  const [giftCoins, setGiftCoins] = useState("");
  const [giftCases, setGiftCases] = useState("");

  // Withdrawals
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  const giftMutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        coins: Number(giftCoins) || 0,
        cases: Number(giftCases) || 0,
      };
      const trimmed = target.trim();
      if (trimmed.includes("@")) payload.username = trimmed.replace("@", "").toLowerCase();
      else payload.uid = trimmed;
      return authedFetch("/api/admin?action=gift", payload);
    },
    onSuccess: () => {
      toast({ title: t("giftSent"), description: `@${target.replace("@", "")}` });
      setGiftCoins("");
      setGiftCases("");
    },
    onError: (error: any) => {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
    },
  });

  const loadWithdrawals = async () => {
    setLoadingList(true);
    try {
      const res = await authedFetch("/api/admin?action=withdrawals");
      setWithdrawals(res.withdrawals || []);
    } catch (error: any) {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
    } finally {
      setLoadingList(false);
    }
  };

  useEffect(() => {
    loadWithdrawals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const actMutation = useMutation({
    mutationFn: async ({ uid, id, action }: { uid: string; id: string; action: string }) =>
      authedFetch("/api/admin?action=withdrawals", { uid, id, action }),
    onSuccess: () => {
      toast({ title: t("withdrawProcessed") });
      loadWithdrawals();
    },
    onError: (error: any) => {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
    },
  });

  return (
    <div className="container mx-auto max-w-5xl space-y-6 p-4 sm:px-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
          <ShieldCheck className="h-6 w-6 text-emerald-400" />
          {t("adminPanel")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("adminSubtitle")}</p>
      </div>

      <Tabs defaultValue="gift">
        <TabsList className="rounded-full">
          <TabsTrigger value="gift" className="gap-1.5 rounded-full"><Send className="h-4 w-4" />{t("giftTab")}</TabsTrigger>
          <TabsTrigger value="withdrawals" className="gap-1.5 rounded-full"><Clock className="h-4 w-4" />{t("withdrawalsTab")}</TabsTrigger>
        </TabsList>

        {/* Gift */}
        <TabsContent value="gift">
          <Card className="glass-panel border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">{t("giftTitle")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t("giftTarget")}</label>
                <Input
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder="username or firebase-uid"
                  className="h-11 rounded-xl"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Coins className="h-3.5 w-3.5 text-amber-400" />{t("giftCoins")}
                  </label>
                  <Input
                    type="number"
                    min={0}
                    value={giftCoins}
                    onChange={(e) => setGiftCoins(e.target.value)}
                    placeholder="0"
                    className="h-11 rounded-xl"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <PackageOpen className="h-3.5 w-3.5 text-primary" />{t("giftCases")}
                  </label>
                  <Input
                    type="number"
                    min={0}
                    value={giftCases}
                    onChange={(e) => setGiftCases(e.target.value)}
                    placeholder="0"
                    className="h-11 rounded-xl"
                  />
                </div>
              </div>
              <Button
                size="lg"
                className="w-full rounded-xl font-semibold"
                disabled={giftMutation.isPending || (!Number(giftCoins) && !Number(giftCases)) || !target.trim()}
                onClick={() => giftMutation.mutate()}
              >
                {giftMutation.isPending ? t("sending") : <><Send className="mr-2 h-5 w-5" />{t("giftSend")}</>}
              </Button>
              <p className="text-center text-[11px] text-muted-foreground">{t("giftNote")}</p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Withdrawals */}
        <TabsContent value="withdrawals">
          <Card className="glass-panel border-border/50">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">{t("withdrawalsTitle")}</CardTitle>
                <Button variant="outline" size="sm" className="gap-1.5 rounded-full" onClick={loadWithdrawals} disabled={loadingList}>
                  <RefreshCw className={cn("h-3.5 w-3.5", loadingList && "animate-spin")} />
                  {t("refresh")}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {!withdrawals.length && !loadingList && (
                <p className="py-6 text-center text-sm text-muted-foreground">{t("noWithdrawals")}</p>
              )}
              {withdrawals.map((w) => (
                <div key={w.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/50 bg-card/50 px-4 py-3">
                  <div className="min-w-0">
                    <p className="font-number text-sm font-bold text-amber-400">
                      {w.amount} INSP
                      <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                        {w.methodLabel} · uid {w.uid.slice(0, 8)}…
                      </span>
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">{w.details}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={cn("rounded-full text-[10px] font-bold uppercase", STATUS_STYLES[w.status])}>
                      {w.status}
                    </Badge>
                    {w.status === "pending" && (
                      <>
                        <Button
                          size="sm"
                          className="h-8 gap-1 rounded-full bg-emerald-600 text-white hover:bg-emerald-500"
                          disabled={actMutation.isPending}
                          onClick={() => actMutation.mutate({ uid: w.uid, id: w.id, action: "paid" })}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />{t("markPaid")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1 rounded-full border-red-500/40 text-red-400 hover:bg-red-500/10"
                          disabled={actMutation.isPending}
                          onClick={() => actMutation.mutate({ uid: w.uid, id: w.id, action: "rejected" })}
                        >
                          <XCircle className="h-3.5 w-3.5" />{t("reject")}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
