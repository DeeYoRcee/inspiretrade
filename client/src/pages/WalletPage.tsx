import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useMutation } from "@tanstack/react-query";
import {
  Wallet, Coins, ArrowDownToLine, ArrowUpFromLine, ShieldCheck, Clock,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language-context";
import { authedFetch } from "@/lib/api";
import { auth } from "@/lib/firebase";
import { useEconomy } from "@/hooks/use-economy";
import { ReferralCard } from "@/components/wallet/ReferralCard";
import { ref, get } from "firebase/database";
import { db } from "@/lib/firebase";
import { cn } from "@/lib/utils";

const MIN_WITHDRAW = 5;

interface WithdrawRequest {
  id: string;
  amount: number;
  methodLabel: string;
  details: string;
  status: "pending" | "paid" | "rejected";
  at: number;
}

const DEPOSIT_PACKS = [
  { coins: 10, price: "$10", popular: false },
  { coins: 50, price: "$45", popular: true },
  { coins: 100, price: "$85", popular: false },
];

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  paid: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  approved: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  rejected: "bg-red-500/15 text-red-400 border-red-500/30",
};

interface DepositRequest {
  id: string;
  amount: number;
  methodLabel: string;
  details: string;
  status: "pending" | "approved" | "rejected";
  at: number;
}

const MIN_DEPOSIT = 10;

export default function WalletPage() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const { data: economy } = useEconomy();
  const coins = economy?.coins ?? 0;

  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("crypto");
  const [details, setDetails] = useState("");
  const [history, setHistory] = useState<WithdrawRequest[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // ---- in-app deposit requests (replaces the Telegram contact flow) ----
  const [depAmount, setDepAmount] = useState("");
  const [depMethod, setDepMethod] = useState("crypto");
  const [depDetails, setDepDetails] = useState("");
  const [deposits, setDeposits] = useState<DepositRequest[]>([]);

  const depositMutation = useMutation({
    mutationFn: async () =>
      authedFetch("/api/wallet?action=deposit", {
        amount: Number(depAmount),
        method: depMethod,
        details: depDetails.trim(),
      }) as Promise<{ request: DepositRequest }>,
    onSuccess: (data) => {
      toast({ title: t("depositRequested"), description: `${data.request.amount} INSP — ${t("statusPending")}` });
      setDepAmount("");
      setDepDetails("");
      openDepositHistory();
    },
    onError: (error: any) => {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
    },
  });

  const openDepositHistory = async () => {
    try {
      if (!auth.currentUser) return setDeposits([]);
      const snap = await get(ref(db, `depositRequests/${auth.currentUser.uid}`));
      const data = (snap.val() || {}) as Record<string, any>;
      const list: DepositRequest[] = Object.entries(data)
        .map(([id, request]) => ({ ...request, id }))
        .sort((a, b) => (b.at || 0) - (a.at || 0))
        .slice(0, 10);
      setDeposits(list);
    } catch {
      setDeposits([]);
    }
  };

  // load the deposit request history once on mount
  useEffect(() => {
    openDepositHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const withdrawMutation = useMutation({
    mutationFn: async () => {
      const res = await authedFetch("/api/wallet?action=withdraw", {
        amount: Number(amount),
        method,
        details: details.trim(),
      });
      return res as { request: WithdrawRequest };
    },
    onSuccess: (data) => {
      toast({ title: t("withdrawRequested"), description: `${data.request.amount} INSP — ${t("statusPending")}` });
      setAmount("");
      setDetails("");
      openHistory();
      setShowHistory(true);
    },
    onError: (error: any) => {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
    },
  });

  const openHistory = async () => {
    try {
      if (!auth.currentUser) return setHistory([]);
      // Only read OWN withdrawal requests (rules: withdrawals/$uid readable by owner).
      const snap = await get(ref(db, `withdrawals/${auth.currentUser.uid}`));
      const data = (snap.val() || {}) as Record<string, any>;
      const list: WithdrawRequest[] = Object.entries(data)
        .map(([id, request]) => ({ ...request, uid: auth.currentUser!.uid, id }))
        .sort((a, b) => (b.at || 0) - (a.at || 0));
      setHistory(list);
    } catch {
      setHistory([]);
    }
  };

  return (
    <div className="container mx-auto max-w-5xl space-y-6 p-4 sm:px-6">
      {/* Header */}
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
          <Wallet className="h-6 w-6 text-primary" />
          {t("wallet")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("walletSubtitle")}</p>
      </div>

      {/* Balance */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
        <Card className="glass-panel border-primary/25">
          <CardContent className="flex flex-wrap items-center justify-between gap-4 p-6">
            <div className="flex items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-500/25 via-amber-500/10 to-transparent">
                <Coins className="h-8 w-8 text-amber-400" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-widest text-muted-foreground">{t("walletBalance")}</p>
                <p className="font-number text-4xl font-black text-amber-400">{coins} <span className="text-lg">INSP</span></p>
                <p className="text-[11px] text-muted-foreground">1 INSP = $1</p>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
              {t("walletSecureNote")}
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Referral — share the link, earn INSP */}
      <ReferralCard />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Deposit — in-app request, no Telegram needed */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
          <Card className="glass-panel border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg"><ArrowDownToLine className="h-5 w-5 text-emerald-400" />{t("depositTitle")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs text-muted-foreground">{t("depositInAppNote")}</p>
              <div className="grid grid-cols-3 gap-2">
                {DEPOSIT_PACKS.map((pack) => (
                  <button
                    key={pack.coins}
                    onClick={() => setDepAmount(String(pack.coins))}
                    className={cn(
                      "relative flex flex-col items-center gap-1 rounded-xl border px-3 py-4 text-center transition-all hover:border-primary/50 hover:bg-primary/5",
                      depAmount === String(pack.coins) || (pack.popular && !depAmount)
                        ? "border-primary/50 bg-primary/10"
                        : "border-border/60 bg-card/50",
                    )}
                  >
                    {pack.popular && (
                      <span className="absolute -top-2 rounded-full bg-primary px-2 py-0.5 text-[9px] font-bold text-primary-foreground">
                        BEST
                      </span>
                    )}
                    <Coins className="h-5 w-5 text-amber-400" />
                    <span className="font-number text-lg font-bold">{pack.coins}</span>
                    <span className="text-[11px] text-muted-foreground">{pack.price}</span>
                  </button>
                ))}
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t("depositAmount")} (min {MIN_DEPOSIT} INSP)</label>
                <Input
                  type="number"
                  min={MIN_DEPOSIT}
                  value={depAmount}
                  onChange={(e) => setDepAmount(e.target.value)}
                  placeholder="10"
                  className="h-11 rounded-xl"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t("withdrawMethod")}</label>
                <Select value={depMethod} onValueChange={setDepMethod}>
                  <SelectTrigger className="h-11 rounded-xl"><SelectValue /></SelectTrigger>
                  <SelectContent className="glass-panel border-border/60">
                    <SelectItem value="crypto">{t("depositMethodCrypto")}</SelectItem>
                    <SelectItem value="other">{t("depositMethodOther")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t("depositDetailsLabel")}</label>
                <Input
                  value={depDetails}
                  onChange={(e) => setDepDetails(e.target.value)}
                  placeholder={t("depositDetailsPlaceholder")}
                  maxLength={300}
                  className="h-11 rounded-xl"
                />
              </div>
              <Button
                size="lg"
                className="w-full rounded-xl font-semibold"
                disabled={
                  depositMutation.isPending ||
                  !Number(depAmount) ||
                  Number(depAmount) < MIN_DEPOSIT ||
                  !depDetails.trim()
                }
                onClick={() => depositMutation.mutate()}
              >
                {depositMutation.isPending ? t("depositing") : <><Clock className="mr-2 h-5 w-5" />{t("depositRequestButton")}</>}
              </Button>
              <p className="text-center text-[11px] text-muted-foreground">{t("depositProcessNote")}</p>

              {/* last 10 deposit requests with their status */}
              {deposits.length > 0 && (
                <div className="space-y-2 border-t border-border/40 pt-3">
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("depositHistory")}</p>
                    <Button variant="outline" size="sm" className="h-7 rounded-full px-2 text-[10px]" onClick={openDepositHistory}>{t("withdrawShow")}</Button>
                  </div>
                  {deposits.slice(0, 5).map((request) => (
                    <div key={request.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/50 bg-card/50 px-3 py-2">
                      <div>
                        <p className="font-number text-sm font-bold text-amber-400">{request.amount} INSP</p>
                        <p className="text-[11px] text-muted-foreground">
                          {request.methodLabel} · {new Date(request.at).toLocaleDateString()}
                        </p>
                      </div>
                      <Badge variant="outline" className={cn("rounded-full text-[10px] font-bold uppercase", STATUS_STYLES[request.status])}>
                        {t(`status${request.status.charAt(0).toUpperCase()}${request.status.slice(1)}`)}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Withdraw */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          <Card className="glass-panel border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg"><ArrowUpFromLine className="h-5 w-5 text-primary" />{t("withdrawTitle")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t("withdrawAmount")} (min {MIN_WITHDRAW} INSP)</label>
                <Input
                  type="number"
                  min={MIN_WITHDRAW}
                  max={coins}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="10"
                  className="h-11 rounded-xl"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t("withdrawMethod")}</label>
                <Select value={method} onValueChange={setMethod}>
                  <SelectTrigger className="h-11 rounded-xl"><SelectValue /></SelectTrigger>
                  <SelectContent className="glass-panel border-border/60">
                    <SelectItem value="crypto">{t("methodCrypto")}</SelectItem>
                    <SelectItem value="telegram">{t("methodTelegram")}</SelectItem>
                    <SelectItem value="other">{t("methodOther")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t("withdrawDetails")}</label>
                <Input
                  value={details}
                  onChange={(e) => setDetails(e.target.value)}
                  placeholder={t("withdrawDetailsPlaceholder")}
                  maxLength={200}
                  className="h-11 rounded-xl"
                />
              </div>
              <Button
                size="lg"
                className="w-full rounded-xl font-semibold"
                disabled={
                  withdrawMutation.isPending ||
                  !Number(amount) ||
                  Number(amount) < MIN_WITHDRAW ||
                  Number(amount) > coins ||
                  !details.trim()
                }
                onClick={() => withdrawMutation.mutate()}
              >
                {withdrawMutation.isPending ? t("withdrawing") : <><Clock className="mr-2 h-5 w-5" />{t("withdrawRequestButton")}</>}
              </Button>
              <p className="text-center text-[11px] text-muted-foreground">{t("withdrawProcessNote")}</p>
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* History */}
      <Card className="glass-panel border-border/50">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-lg"><Clock className="h-5 w-5 text-muted-foreground" />{t("withdrawHistory")}</CardTitle>
            <Button
              variant="outline"
              size="sm"
              className="rounded-full"
              onClick={() => {
                if (showHistory) {
                  setShowHistory(false);
                } else {
                  openHistory();
                  setShowHistory(true);
                }
              }}
            >
              {showHistory ? t("withdrawHide") : t("withdrawShow")}
            </Button>
          </div>
        </CardHeader>
        {showHistory && (
          <CardContent className="space-y-2">
            {!history?.length && <p className="py-4 text-center text-sm text-muted-foreground">{t("noWithdrawalsYet")}</p>}
            {history?.map((request) => (
              <div key={request.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/50 bg-card/50 px-4 py-3">
                <div>
                  <p className="font-number text-sm font-bold text-amber-400">{request.amount} INSP</p>
                  <p className="text-[11px] text-muted-foreground">
                    {request.methodLabel} · {new Date(request.at).toLocaleDateString()}
                  </p>
                </div>
                <Badge variant="outline" className={cn("rounded-full text-[10px] font-bold uppercase", STATUS_STYLES[request.status])}>
                  {t(`status${request.status.charAt(0).toUpperCase()}${request.status.slice(1)}`)}
                </Badge>
              </div>
            ))}
          </CardContent>
        )}
      </Card>
    </div>
  );
}
