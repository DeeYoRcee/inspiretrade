import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useMutation } from "@tanstack/react-query";
import {
  ShieldCheck, Coins, PackageOpen, Send, Clock, CheckCircle2, XCircle, RefreshCw, ArrowDownToLine, Crown, UserRoundPen, Box, Trash2, Briefcase, LayoutDashboard, History } from "lucide-react";
import { PropFirmAdmin } from "@/components/admin/PropFirmAdmin";
import { PlatformAdmin } from "@/components/admin/PlatformAdmin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language-context";
import { authedFetch } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { useUserProfile } from "@/hooks/use-premium";
import { useCustomCases, useEconomyInvalidator } from "@/hooks/use-economy";
import { ALL_FRAGMENTS, CASES } from "@shared/fragments";
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

interface DepositReq {
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
  const { user } = useAuth();
  const { data: ownerProfile, refetch: refetchOwnerProfile } = useUserProfile();

  // Gift form
  const [target, setTarget] = useState("");
  const [giftCoins, setGiftCoins] = useState("");
  const [giftCases, setGiftCases] = useState("");

  // Owner panel — spawn cases for yourself + claim any username
  const [spawnCases, setSpawnCases] = useState("");
  const [spawnGold, setSpawnGold] = useState("");
  const [claimName, setClaimName] = useState("");
  const [histBusy, setHistBusy] = useState(false);
  const [histLog, setHistLog] = useState("");
  const [histCoverage, setHistCoverage] = useState("");

  // Case factory — create custom cases, grant cases of any type
  const { data: customCases } = useCustomCases();
  const invalidateEconomy = useEconomyInvalidator();
  const [newCaseName, setNewCaseName] = useState("");
  const [caseWeights, setCaseWeights] = useState<Record<string, string>>({});
  const [grantCaseId, setGrantCaseId] = useState("");
  const [grantTarget, setGrantTarget] = useState("");
  const [grantCount, setGrantCount] = useState("1");

  // Withdrawals
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  // Deposits (in-app requests)
  const [deposits, setDepositsList] = useState<DepositReq[]>([]);
  const [loadingDeposits, setLoadingDeposits] = useState(false);

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

  // Case factory — create / delete / grant (owner only, server validates)
  const createCaseMutation = useMutation({
    mutationFn: async () => {
      const fragments = Object.entries(caseWeights)
        .map(([id, weight]) => ({ id, weight: Number(weight) || 0 }))
        .filter((row) => row.weight > 0);
      return authedFetch("/api/admin?action=caseCreate", { name: newCaseName.trim(), fragments });
    },
    onSuccess: () => {
      toast({ title: t("adminCaseCreated") });
      setNewCaseName("");
      setCaseWeights({});
      invalidateEconomy();
    },
    onError: (error: any) => {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
    },
  });

  const deleteCaseMutation = useMutation({
    mutationFn: async (caseId: string) => authedFetch("/api/admin?action=caseDelete", { caseId }),
    onSuccess: () => {
      toast({ title: t("adminCaseDeleted") });
      invalidateEconomy();
    },
    onError: (error: any) => {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
    },
  });

  const grantCaseMutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = { caseId: grantCaseId, count: Number(grantCount) || 1 };
      const trimmed = grantTarget.trim();
      if (trimmed.includes("@")) payload.username = trimmed.replace("@", "").toLowerCase();
      else payload.uid = trimmed;
      return authedFetch("/api/admin?action=caseGrant", payload);
    },
    onSuccess: () => {
      toast({ title: t("adminCaseGranted") });
      setGrantTarget("");
      setGrantCount("1");
      invalidateEconomy();
    },
    onError: (error: any) => {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
    },
  });

  const pickedFragments = Object.entries(caseWeights).filter(([, w]) => Number(w) > 0);
  const totalCaseWeight = pickedFragments.reduce((s, [, w]) => s + Number(w), 0);

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

  const loadDeposits = async () => {
    setLoadingDeposits(true);
    try {
      const res = await authedFetch("/api/admin?action=deposits");
      setDepositsList(res.deposits || []);
    } catch (error: any) {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
    } finally {
      setLoadingDeposits(false);
    }
  };

  useEffect(() => {
    loadDeposits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const depMutation = useMutation({
    mutationFn: async ({ uid, id, action }: { uid: string; id: string; action: string }) =>
      authedFetch("/api/admin?action=deposits", { uid, id, action }),
    onSuccess: (_data, vars) => {
      toast({ title: vars.action === "approve" ? t("depositApproved") : t("depositRejectedToast") });
      loadDeposits();
    },
    onError: (error: any) => {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
    },
  });

  // Owner: unlimited self-spawn of any case type — sell them or give away.
  const spawnMutation = useMutation({
    mutationFn: async () =>
      authedFetch("/api/admin?action=gift", {
        uid: user!.uid,
        cases: Number(spawnCases) || 0,
        goldCases: Number(spawnGold) || 0,
        note: "owner spawn",
      }),
    onSuccess: () => {
      toast({ title: t("ownerSpawnDone") });
      setSpawnCases("");
      setSpawnGold("");
    },
    onError: (error: any) => {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
    },
  });

  // Owner: claim ANY username (even taken / celebrity-style) + CEO badge.
  const claimMutation = useMutation({
    mutationFn: async () => authedFetch("/api/admin?action=set-username", { username: claimName.trim() }),
    onSuccess: () => {
      toast({ title: t("ownerClaimDone"), description: `@${claimName.trim().toLowerCase()}` });
      setClaimName("");
      refetchOwnerProfile();
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
          <TabsTrigger value="deposits" className="gap-1.5 rounded-full"><ArrowDownToLine className="h-4 w-4" />{t("depositsTab")}</TabsTrigger>
          <TabsTrigger value="withdrawals" className="gap-1.5 rounded-full"><Clock className="h-4 w-4" />{t("withdrawalsTab")}</TabsTrigger>
          <TabsTrigger value="owner" className="gap-1.5 rounded-full"><Crown className="h-4 w-4" />{t("ownerTab")}</TabsTrigger>
          <TabsTrigger value="cases" className="gap-1.5 rounded-full"><Box className="h-4 w-4" />{t("adminCasesTab")}</TabsTrigger>
          <TabsTrigger value="prop" className="gap-1.5 rounded-full"><Briefcase className="h-4 w-4" />{t("adminPropTab")}</TabsTrigger>
          <TabsTrigger value="platform" className="gap-1.5 rounded-full"><LayoutDashboard className="h-4 w-4" />{t("adminOverviewTab")}</TabsTrigger>
        </TabsList>

        {/* Owner — CEO powers */}
        <TabsContent value="owner">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="glass-panel border-amber-500/30">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg"><Crown className="h-5 w-5 text-amber-400" />{t("ownerSpawnTitle")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-xs leading-relaxed text-muted-foreground">{t("ownerSpawnHint")}</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      <PackageOpen className="h-3.5 w-3.5 text-primary" />{t("giftCases")}
                    </label>
                    <Input type="number" min={0} max={1000} value={spawnCases} onChange={(e) => setSpawnCases(e.target.value)} placeholder="0" className="h-11 rounded-xl" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      <Crown className="h-3.5 w-3.5 text-amber-400" />{t("goldCases")}
                    </label>
                    <Input type="number" min={0} max={1000} value={spawnGold} onChange={(e) => setSpawnGold(e.target.value)} placeholder="0" className="h-11 rounded-xl" />
                  </div>
                </div>
                <Button
                  size="lg"
                  className="w-full rounded-xl bg-gradient-to-r from-amber-500 to-yellow-400 font-semibold text-black hover:from-amber-400 hover:to-yellow-300"
                  disabled={spawnMutation.isPending || (!Number(spawnCases) && !Number(spawnGold))}
                  onClick={() => spawnMutation.mutate()}
                >
                  {spawnMutation.isPending ? t("sending") : <><PackageOpen className="mr-2 h-5 w-5" />{t("ownerSpawnButton")}</>}
                </Button>
              </CardContent>
            </Card>

            <Card className="glass-panel border-amber-500/30">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg"><UserRoundPen className="h-5 w-5 text-amber-400" />{t("ownerClaimTitle")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-xs leading-relaxed text-muted-foreground">{t("ownerClaimHint")}</p>
                {/* Telegram-collectible style: every handle the owner holds */}
                {Object.keys(ownerProfile?.usernames || {}).length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(ownerProfile?.usernames || {}).map(([key, v]) => (
                      <span
                        key={key}
                        className={
                          key === ownerProfile?.username?.toLowerCase()
                            ? "inline-flex items-center rounded-full border border-amber-500/50 bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-amber-300"
                            : "inline-flex items-center rounded-full border border-border/60 bg-card/50 px-2.5 py-0.5 text-[11px] font-semibold text-muted-foreground"
                        }
                      >
                        @{v?.username || key}
                      </span>
                    ))}
                  </div>
                )}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">{t("ownerClaimLabel")}</label>
                  <Input
                    value={claimName}
                    onChange={(e) => setClaimName(e.target.value.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 20))}
                    placeholder="CEO"
                    className="h-11 rounded-xl"
                  />
                </div>
                <Button
                  size="lg"
                  className="w-full rounded-xl bg-gradient-to-r from-amber-500 to-yellow-400 font-semibold text-black hover:from-amber-400 hover:to-yellow-300"
                  disabled={claimMutation.isPending || claimName.trim().length < 3}
                  onClick={() => claimMutation.mutate()}
                >
                  {claimMutation.isPending ? t("sending") : <><Crown className="mr-2 h-5 w-5" />{t("ownerClaimButton")}</>}
                </Button>
                <p className="text-[11px] leading-relaxed text-muted-foreground">{t("ownerCeoNote")}</p>
              </CardContent>
            </Card>

            {/* Phase 30 — XAUUSD history deep fill: ONE resumable
                backfill-metals step per click + live coverage readout
                (earliest candle, count, providers). The browser self-heal
                advances the store too; this button is the manual trigger. */}
            <Card className="glass-panel border-amber-500/30 lg:col-span-2">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg"><History className="h-5 w-5 text-amber-400" />History deep fill (XAUUSD / XAGUSD)</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Runs one resumable Dukascopy backfill step (up to ~240 day files, 60 s budget) for the shared store, then shows live coverage. Repeat clicks (or simply leaving a chart open) keep walking deeper — progress is never restarted.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    className="rounded-xl bg-gradient-to-r from-amber-500 to-yellow-400 font-semibold text-black hover:from-amber-400 hover:to-yellow-300"
                    disabled={histBusy}
                    onClick={async () => {
                      setHistBusy(true);
                      setHistLog("Running backfill step…");
                      try {
                        const step = await authedFetch<any>("/api/quotes?action=backfill-metals", { symbol: "XAUUSD", tf: "1m" });
                        setHistLog(`Step: ${step?.ok ? "ok" : "failed"} · provider ${step?.provider || "?"} · written ${step?.written ?? 0} · skipped ${step?.skipped ?? 0} · oldest ${step?.oldest ? new Date(step.oldest * 1000).toISOString().slice(0, 10) : "?"}${step?.error ? ` · ${step.error}` : ""}${step?.note ? ` · ${step.note}` : ""}`);
                      } catch (e) {
                        setHistLog(`Step failed: ${e instanceof Error ? e.message : "network"}`);
                      }
                      try {
                        const cov = await authedFetch<any>("/api/quotes?action=hist-status&symbol=XAUUSD&tfs=1m,1h,1d");
                        const rows = (cov?.rows || []).map((r: any) => `${r.tf}: ${r.candleCount} candles, earliest ${r.earliest ? new Date(r.earliest * 1000).toISOString().slice(0, 10) : "—"}`).join(" · ");
                        setHistCoverage(rows || "no coverage rows");
                      } catch { /* keep previous */ }
                      setHistBusy(false);
                    }}
                  >
                    {histBusy ? "Working…" : "Run deep-fill step + check coverage"}
                  </Button>
                </div>
                {histLog && <p className="text-[11px] font-mono leading-relaxed text-emerald-400">{histLog}</p>}
                {histCoverage && <p className="text-[11px] font-mono leading-relaxed text-amber-300">{histCoverage}</p>}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Case factory — create custom cases, grant any case type */}
        <TabsContent value="cases">
          <div className="grid gap-4 lg:grid-cols-2">
            {/* create */}
            <Card className="glass-panel border-sky-500/30">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg"><Box className="h-5 w-5 text-sky-400" />{t("adminCaseCreateTitle")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-xs leading-relaxed text-muted-foreground">{t("adminCaseCreateHint")}</p>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">{t("adminCaseName")}</label>
                  <Input
                    value={newCaseName}
                    onChange={(e) => setNewCaseName(e.target.value.slice(0, 40))}
                    placeholder={t("adminCaseNamePlaceholder")}
                    className="h-11 rounded-xl"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">{t("adminCasePool")}</label>
                  <div className="max-h-52 space-y-1 overflow-y-auto rounded-xl border border-border/50 bg-card/40 p-2">
                    {ALL_FRAGMENTS.map((f) => {
                      const w = caseWeights[f.id] ?? "";
                      const active = Number(w) > 0;
                      return (
                        <div key={f.id} className={cn("flex items-center gap-2 rounded-lg px-2 py-1 transition-colors", active ? "bg-sky-500/10" : "hover:bg-white/5")}>
                          <span className="min-w-0 flex-1 truncate text-xs font-medium">{f.name}</span>
                          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{f.rarity}</span>
                          <Input
                            type="number"
                            min={0}
                            max={1000}
                            step={0.5}
                            value={w}
                            onChange={(e) => setCaseWeights((p) => ({ ...p, [f.id]: e.target.value }))}
                            placeholder="0"
                            className="h-8 w-20 rounded-lg text-xs"
                            aria-label={`${f.name} weight`}
                          />
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {t("adminCasePicked").replace("{n}", String(pickedFragments.length))} · {t("adminCaseTotalWeight")}: {totalCaseWeight || "—"}
                  </p>
                </div>
                <Button
                  size="lg"
                  className="w-full rounded-xl bg-sky-500 font-semibold text-white hover:bg-sky-400"
                  disabled={createCaseMutation.isPending || newCaseName.trim().length < 2 || pickedFragments.length < 1}
                  onClick={() => createCaseMutation.mutate()}
                >
                  <Box className="mr-2 h-5 w-5" />{t("adminCaseCreateBtn")}
                </Button>
              </CardContent>
            </Card>

            <div className="space-y-4">
              {/* existing custom cases */}
              <Card className="glass-panel border-border/50">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-lg"><PackageOpen className="h-5 w-5 text-primary" />{t("adminCaseListTitle")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {!(customCases ?? []).length ? (
                    <p className="py-2 text-center text-sm text-muted-foreground">{t("adminCaseListEmpty")}</p>
                  ) : (
                    (customCases ?? []).map((def) => (
                      <div key={def.caseId} className="flex items-center justify-between rounded-xl border border-border/50 bg-card/50 px-3 py-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">{def.name}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {def.fragments.length} × fragment · {def.fragments.reduce((s, r) => s + (Number(r.weight) || 0), 0)} {t("adminCaseTotalWeight")}
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="rounded-full text-red-400 hover:text-red-300"
                          disabled={deleteCaseMutation.isPending}
                          onClick={() => deleteCaseMutation.mutate(def.caseId)}
                        >
                          <Trash2 className="mr-1 h-3.5 w-3.5" />{t("adminCaseDelete")}
                        </Button>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>

              {/* grant any case type */}
              <Card className="glass-panel border-amber-500/30">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-lg"><Crown className="h-5 w-5 text-amber-400" />{t("adminCaseGrantTitle")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">{t("adminCasePickCase")}</label>
                      <Select value={grantCaseId} onValueChange={setGrantCaseId}>
                        <SelectTrigger className="w-full rounded-xl"><SelectValue placeholder={t("adminCasePickCase")} /></SelectTrigger>
                        <SelectContent className="glass-panel border-border/60">
                          <SelectItem value="inspire">{CASES.inspire.name}</SelectItem>
                          <SelectItem value="gold">{CASES.gold.name}</SelectItem>
                          {(customCases ?? []).map((def) => (
                            <SelectItem key={def.caseId} value={def.caseId}>{def.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">{t("giftCases")}</label>
                      <Input type="number" min={1} max={1000} value={grantCount} onChange={(e) => setGrantCount(e.target.value)} className="h-11 rounded-xl" />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">{t("giftTarget")}</label>
                    <Input
                      value={grantTarget}
                      onChange={(e) => setGrantTarget(e.target.value)}
                      placeholder="@username or uid"
                      className="h-11 rounded-xl"
                    />
                  </div>
                  <Button
                    size="lg"
                    className="w-full rounded-xl bg-gradient-to-r from-amber-500 to-yellow-400 font-semibold text-black hover:from-amber-400 hover:to-yellow-300"
                    disabled={grantCaseMutation.isPending || !grantCaseId || !grantTarget.trim()}
                    onClick={() => grantCaseMutation.mutate()}
                  >
                    <Send className="mr-2 h-5 w-5" />{t("adminCaseGrantBtn")}
                  </Button>
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        {/* Prop firm — challenge types, assignment, monitoring, audit */}
        <TabsContent value="prop">
          <PropFirmAdmin />
        </TabsContent>

        {/* Phase 7 — platform management (overview, users, monitor, alerts, settings) */}
        <TabsContent value="platform">
          <PlatformAdmin />
        </TabsContent>

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

        {/* Deposits */}
        <TabsContent value="deposits">
          <Card className="glass-panel border-border/50">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">{t("depositsTitle")}</CardTitle>
                <Button variant="outline" size="sm" className="gap-1.5 rounded-full" onClick={loadDeposits} disabled={loadingDeposits}>
                  <RefreshCw className={cn("h-3.5 w-3.5", loadingDeposits && "animate-spin")} />
                  {t("refresh")}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {!deposits.length && !loadingDeposits && (
                <p className="py-6 text-center text-sm text-muted-foreground">{t("noDeposits")}</p>
              )}
              {deposits.map((d) => (
                <div key={d.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/50 bg-card/50 px-4 py-3">
                  <div className="min-w-0">
                    <p className="font-number text-sm font-bold text-amber-400">
                      {d.amount} INSP
                      <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                        {d.methodLabel} · uid {d.uid.slice(0, 8)}…
                      </span>
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">{d.details}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={cn("rounded-full text-[10px] font-bold uppercase", STATUS_STYLES[d.status])}>
                      {d.status}
                    </Badge>
                    {d.status === "pending" && (
                      <>
                        <Button
                          size="sm"
                          className="h-8 gap-1 rounded-full bg-emerald-600 text-white hover:bg-emerald-500"
                          disabled={depMutation.isPending}
                          onClick={() => depMutation.mutate({ uid: d.uid, id: d.id, action: "approve" })}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />{t("approveDeposit")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1 rounded-full border-red-500/40 text-red-400 hover:bg-red-500/10"
                          disabled={depMutation.isPending}
                          onClick={() => depMutation.mutate({ uid: d.uid, id: d.id, action: "reject" })}
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
