import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useMutation } from "@tanstack/react-query";
import {
  Coins, PackageOpen, Gem, Layers, ChevronRight, Crown, Lock, Package, Box, Briefcase,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language-context";
import { authedFetch } from "@/lib/api";
import { useEconomy, useInventory, useEconomyInvalidator, useCustomCases, type CustomCaseDef } from "@/hooks/use-economy";
import { CaseOpeningDialog } from "@/components/rewards/CaseOpeningDialog";
import { FragmentCard } from "@/components/rewards/FragmentCard";
import { PropPuzzle } from "@/components/rewards/PropPuzzle";
import {
  FRAGMENTS, GOLD_FRAGMENTS, TRADING_FRAGMENTS, RARITY_META, ALL_FRAGMENTS, getFragment,
  type FragmentDef, type CaseType,
} from "@shared/fragments";
import { cn } from "@/lib/utils";

export default function InventoryPage() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const { data: economy } = useEconomy();
  const { data: inventory } = useInventory();
  const invalidate = useEconomyInvalidator();

  const [caseResult, setCaseResult] = useState<FragmentDef | null>(null);
  const [openCaseType, setOpenCaseType] = useState<string>("inspire");
  // CS2-style: clicking a case FIRST shows what can drop — the roll only
  // starts when the user hits Open inside the preview dialog
  const [previewCase, setPreviewCase] = useState<string | null>(null);
  const [combineConfirm, setCombineConfirm] = useState<CaseType | null>(null);
  const [combineSuccess, setCombineSuccess] = useState<{ reference: string } | null>(null);

  const { data: customCases } = useCustomCases();

  const coins = economy?.coins ?? 0;
  const cases = economy?.cases ?? 0;
  const goldCases = economy?.goldCases ?? 0;
  const tradingCases = economy?.tradingCases ?? 0;
  const customCaseCount = (caseId: string) => economy?.customCases?.[caseId] ?? 0;

  const openMutation = useMutation({
    mutationFn: async (type: string) => {
      const res = await authedFetch("/api/cases/open", { type });
      return res as { fragment: FragmentDef; caseType: string; caseName: string };
    },
    onSuccess: (data) => {
      setPreviewCase(null);
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

  const ownedTypes = useMemo(
    () => FRAGMENTS.filter((f) => (inventory?.[f.id] || 0) >= 1).length,
    [inventory],
  );
  const ownedGoldTypes = useMemo(
    () => GOLD_FRAGMENTS.filter((f) => (inventory?.[f.id] || 0) >= 1).length,
    [inventory],
  );
  const ownedTradingTypes = useMemo(
    () => TRADING_FRAGMENTS.filter((f) => (inventory?.[f.id] || 0) >= 1).length,
    [inventory],
  );
  const totalFragments = useMemo(
    () => [...FRAGMENTS, ...GOLD_FRAGMENTS, ...TRADING_FRAGMENTS].reduce((s, f) => s + (inventory?.[f.id] || 0), 0),
    [inventory],
  );

  const renderCollection = (list: FragmentDef[], set: CaseType) => {
    const owned = set === "inspire" ? ownedTypes : set === "gold" ? ownedGoldTypes : ownedTradingTypes;
    const canCombine = owned === list.length;
    return (
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {list.map((fragment) => {
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
            className={cn(
              "w-full max-w-md rounded-xl font-semibold",
              set === "gold"
                ? "bg-gradient-to-r from-amber-500 to-yellow-400 text-black hover:from-amber-400 hover:to-yellow-300"
                : set === "trading"
                  ? "bg-gradient-to-r from-emerald-500 to-teal-400 text-black hover:from-emerald-400 hover:to-teal-300"
                  : "bg-amber-500 text-black hover:bg-amber-400",
            )}
            disabled={!canCombine || combineMutation.isPending}
            onClick={() => setCombineConfirm(set)}
          >
            <Lock className="mr-2 h-5 w-5" />
            {set === "gold" ? t("combineButtonGold") : set === "trading" ? "Combine into 25k$ Prop Account" : t("combineButton")}
          </Button>
          <p className="text-xs text-muted-foreground">
            {canCombine ? t("combineReady") : t("missingFragmentsHint")}
          </p>
        </div>
      </CardContent>
    );
  };

  const renderCaseRow = (set: CaseType) => {
    const isGold = set === "gold";
    const isTrading = set === "trading";
    const count = isGold ? goldCases : isTrading ? tradingCases : cases;
    return (
      <div
        className="flex cursor-pointer items-center gap-4 rounded-xl border border-transparent p-1 -m-1 transition-colors hover:border-border/50 hover:bg-accent/30"
        onClick={() => setPreviewCase(set)}
        title={t("caseContents")}
      >
        <div
          className={cn(
            "relative flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border",
            isGold
              ? "border-amber-500/40 bg-gradient-to-br from-amber-500/25 via-amber-500/5 to-transparent shadow-[0_0_24px_-6px_rgba(245,158,11,0.6)]"
              : isTrading
                ? "border-emerald-500/40 bg-gradient-to-br from-emerald-500/25 via-emerald-500/5 to-transparent shadow-[0_0_24px_-6px_rgba(16,185,129,0.6)]"
                : "border-primary/30 bg-gradient-to-br from-primary/20 via-primary/5 to-transparent shadow-[0_0_24px_-6px_hsl(var(--primary)/0.5)]",
          )}
        >
          {isGold ? <Crown className="h-7 w-7 text-amber-400" /> : isTrading ? <Briefcase className="h-7 w-7 text-emerald-400" /> : <Gem className="h-7 w-7 text-primary" />}
          <span className={cn("absolute -right-2 -top-2 rounded-full px-2 py-0.5 text-xs font-bold", isGold ? "bg-amber-500 text-black" : isTrading ? "bg-emerald-500 text-black" : "bg-primary text-primary-foreground")}>
            {count}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {isGold ? t("goldCase") : isTrading ? "Trading Case" : t("inspireCase")} · {isGold ? "10k$ Prop" : isTrading ? "25k$ Prop" : "5k$ Prop"}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 rounded-xl font-semibold"
          onClick={(e) => { e.stopPropagation(); setPreviewCase(set); }}
        >
          <ChevronRight className="mr-1 h-4 w-4" />{t("openCase")}
        </Button>
      </div>
    );
  };

  const RenderCustomCaseRow = ({ def }: { def: CustomCaseDef }) => {
    const count = customCaseCount(def.caseId);
    return (
      <div
        className="flex cursor-pointer items-center gap-4 rounded-xl border border-transparent p-1 -m-1 transition-colors hover:border-border/50 hover:bg-accent/30"
        onClick={() => setPreviewCase(def.caseId)}
        title={t("caseContents")}
      >
        <div className="relative flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-sky-500/40 bg-gradient-to-br from-sky-500/25 via-sky-500/5 to-transparent shadow-[0_0_24px_-6px_rgba(56,189,248,0.6)]">
          <Box className="h-7 w-7 text-sky-400" />
          <span className="absolute -right-2 -top-2 rounded-full bg-sky-500 px-2 py-0.5 text-xs font-bold text-white">
            {count}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{def.name}</p>
          <p className="text-xs text-muted-foreground">{def.fragments.length} × fragment</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 rounded-xl font-semibold"
          onClick={(e) => { e.stopPropagation(); setPreviewCase(def.caseId); }}
        >
          <ChevronRight className="mr-1 h-4 w-4" />{t("openCase")}
        </Button>
      </div>
    );
  };

  // Resolve the previewed case into a drop pool with chances — built-ins use
  // their canonical definitions, custom cases map ids → fragment defs with
  // the owner's weights (shown normalized to a percentage).
  const previewDef = previewCase
    ? previewCase === "inspire" || previewCase === "gold" || previewCase === "trading"
      ? { name: previewCase === "gold" ? t("goldCase") : previewCase === "trading" ? "Trading Case" : t("inspireCase"), isGold: previewCase === "gold", fragments: previewCase === "gold" ? GOLD_FRAGMENTS : previewCase === "trading" ? TRADING_FRAGMENTS : FRAGMENTS, weights: null as Record<string, number> | null }
      : (() => {
          const def = customCases?.find((c) => c.caseId === previewCase);
          if (!def) return null;
          const weights: Record<string, number> = {};
          for (const row of def.fragments) weights[row.id] = Number(row.weight) || 0;
          const fragments = def.fragments
            .map((row) => getFragment(row.id))
            .filter(Boolean) as FragmentDef[];
          return { name: def.name, isGold: false, fragments, weights };
        })()
    : null;
  const previewCount = previewCase ? (previewCase === "inspire" ? cases : previewCase === "gold" ? goldCases : previewCase === "trading" ? tradingCases : customCaseCount(previewCase)) : 0;
  const previewTotalWeight = previewDef ? previewDef.fragments.reduce((s, f) => s + (previewDef.weights ? previewDef.weights[f.id] || 0 : f.dropPercent), 0) : 0;

  return (
    <div className="container mx-auto max-w-5xl space-y-6 p-4 sm:px-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
            <Package className="h-6 w-6 text-primary" />
            {t("inventory")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("inventorySubtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1.5 rounded-full border-border/60 bg-card/60 px-3 py-1.5 text-sm font-bold text-amber-400">
            <Coins className="h-4 w-4" /> {coins} INSP
          </Badge>
          <Badge variant="outline" className="gap-1.5 rounded-full border-border/60 bg-card/60 px-3 py-1.5 text-sm font-bold">
            <PackageOpen className="h-4 w-4 text-primary" /> {cases}
          </Badge>
          {goldCases > 0 && (
            <Badge variant="outline" className="gap-1.5 rounded-full border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm font-bold text-amber-400">
              <Crown className="h-4 w-4" /> {goldCases}
            </Badge>
          )}
          {tradingCases > 0 && (
            <Badge variant="outline" className="gap-1.5 rounded-full border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm font-bold text-emerald-400">
              <Briefcase className="h-4 w-4" /> {tradingCases}
            </Badge>
          )}
        </div>
      </div>

      {/* Cases — Inspire + Gold */}
      <Card className="glass-panel border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg"><PackageOpen className="h-5 w-5 text-primary" />{t("casesTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {renderCaseRow("inspire")}
          {renderCaseRow("gold")}
          {renderCaseRow("trading")}
          {(customCases ?? []).map((def) => (
            <RenderCustomCaseRow key={def.caseId} def={def} />
          ))}
          {cases < 1 && goldCases < 1 && tradingCases < 1 && (customCases ?? []).every((def) => customCaseCount(def.caseId) < 1) && (
            <p className="text-center text-xs text-muted-foreground">{t("noCases")}</p>
          )}
        </CardContent>
      </Card>

      {/* Puzzles + collections — one tab per prop account */}
      <Tabs defaultValue="inspire">
        <TabsList className="glass-panel rounded-full border border-border/60">
          <TabsTrigger value="inspire" className="gap-1.5 rounded-full"><Gem className="h-4 w-4" />5k$</TabsTrigger>
          <TabsTrigger value="gold" className="gap-1.5 rounded-full"><Crown className="h-4 w-4" />10k$</TabsTrigger>
          <TabsTrigger value="trading" className="gap-1.5 rounded-full"><Briefcase className="h-4 w-4" />25k$</TabsTrigger>
        </TabsList>

        <TabsContent value="inspire" className="mt-4 space-y-6">
          <Card className="glass-panel border-amber-500/25">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg"><Crown className="h-5 w-5 text-amber-400" />{t("propAccountPuzzle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <PropPuzzle
                inventory={inventory}
                set="inspire"
                completing={combineMutation.isPending}
                onComplete={() => setCombineConfirm("inspire")}
              />
            </CardContent>
          </Card>

          <Card className="glass-panel border-border/50">
            <CardHeader className="pb-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-lg"><Layers className="h-5 w-5 text-primary" />{t("collection")}</CardTitle>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">{totalFragments} × fragment</span>
                  <span className="text-sm font-semibold text-muted-foreground">{ownedTypes}/{FRAGMENTS.length}</span>
                </div>
              </div>
            </CardHeader>
            {renderCollection(FRAGMENTS, "inspire")}
          </Card>
        </TabsContent>

        <TabsContent value="gold" className="mt-4 space-y-6">
          <Card className="glass-panel border-amber-500/30">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg"><Crown className="h-5 w-5 text-amber-400" />{t("propAccountPuzzle")} · 10k$</CardTitle>
            </CardHeader>
            <CardContent>
              <PropPuzzle
                inventory={inventory}
                set="gold"
                completing={combineMutation.isPending}
                onComplete={() => setCombineConfirm("gold")}
              />
            </CardContent>
          </Card>

          <Card className="glass-panel border-border/50">
            <CardHeader className="pb-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-lg"><Layers className="h-5 w-5 text-amber-400" />{t("goldCollection")}</CardTitle>
                <span className="text-sm font-semibold text-muted-foreground">{ownedGoldTypes}/{GOLD_FRAGMENTS.length}</span>
              </div>
            </CardHeader>
            {renderCollection(GOLD_FRAGMENTS, "gold")}
          </Card>
        </TabsContent>

        <TabsContent value="trading" className="mt-4 space-y-6">
          <Card className="glass-panel border-emerald-500/30">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg"><Briefcase className="h-5 w-5 text-emerald-400" />{t("propAccountPuzzle")} · 25k$</CardTitle>
            </CardHeader>
            <CardContent>
              <PropPuzzle
                inventory={inventory}
                set="trading"
                completing={combineMutation.isPending}
                onComplete={() => setCombineConfirm("trading")}
              />
            </CardContent>
          </Card>

          <Card className="glass-panel border-border/50">
            <CardHeader className="pb-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-lg"><Layers className="h-5 w-5 text-emerald-400" />Trading Collection</CardTitle>
                <span className="text-sm font-semibold text-muted-foreground">{ownedTradingTypes}/{TRADING_FRAGMENTS.length}</span>
              </div>
            </CardHeader>
            {renderCollection(TRADING_FRAGMENTS, "trading")}
          </Card>
        </TabsContent>
      </Tabs>

      {/* CS2-style case preview — contents + chances; the roll starts only
          when the user hits Open here */}
      <Dialog open={!!previewCase && !!previewDef} onOpenChange={(open) => !open && setPreviewCase(null)}>
        <DialogContent className="glass-panel max-w-2xl border-border/60">
          <DialogHeader className="items-center">
            <DialogTitle className="flex items-center justify-center gap-2">
              {previewDef?.isGold ? <Crown className="h-5 w-5 text-amber-400" /> : <PackageOpen className="h-5 w-5 text-primary" />}
              {previewDef?.name}
            </DialogTitle>
            <DialogDescription>{t("caseContents")}</DialogDescription>
          </DialogHeader>
          <div className="grid max-h-[46vh] grid-cols-2 gap-2.5 overflow-y-auto px-0.5 sm:grid-cols-3">
            {previewDef?.fragments.map((fragment) => {
              const weight = previewDef.weights ? previewDef.weights[fragment.id] || 0 : fragment.dropPercent;
              const chance = previewTotalWeight > 0 ? (weight / previewTotalWeight) * 100 : 0;
              const meta = RARITY_META[fragment.rarity];
              return (
                <FragmentCard
                  key={fragment.id}
                  fragmentId={fragment.id}
                  count={inventory?.[fragment.id] || 0}
                  footer={
                    <span
                      className="font-number mt-2 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold"
                      style={{ color: meta.color, backgroundColor: `${meta.color}1f` }}
                    >
                      {chance.toFixed(1)}%
                    </span>
                  }
                />
              );
            })}
          </div>
          <Button
            size="lg"
            className={cn(
              "w-full rounded-xl font-semibold",
              previewCase === "gold"
                ? "bg-gradient-to-r from-amber-500 to-yellow-400 text-black hover:from-amber-400 hover:to-yellow-300"
                : previewCase === "trading"
                  ? "bg-gradient-to-r from-emerald-500 to-teal-400 text-black hover:from-emerald-400 hover:to-teal-300"
                  : "bg-amber-500 text-black hover:bg-amber-400",
            )}
            disabled={previewCount < 1 || openMutation.isPending}
            onClick={() => previewCase && openMutation.mutate(previewCase)}
          >
            <Lock className="mr-2 h-5 w-5" />
            {openMutation.isPending ? t("openingCase") : `${t("openCase")} — ${previewCount}`}
          </Button>
        </DialogContent>
      </Dialog>

      {/* Case opening reel */}
      <CaseOpeningDialog
        open={!!caseResult}
        result={caseResult}
        caseType={openCaseType}
        caseName={openCaseType !== "inspire" && openCaseType !== "gold" ? customCases?.find((c) => c.caseId === openCaseType)?.name : undefined}
        pool={
          openCaseType !== "inspire" && openCaseType !== "gold"
            ? customCases?.find((c) => c.caseId === openCaseType)?.fragments.map((row) => ({
                ...(getFragment(row.id) as FragmentDef),
                dropPercent: Number(row.weight) || 0.0001,
              })).filter(Boolean)
            : undefined
        }
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
