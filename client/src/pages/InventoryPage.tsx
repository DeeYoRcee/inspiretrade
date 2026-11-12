import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useMutation } from "@tanstack/react-query";
import {
  Coins, PackageOpen, Gem, Layers, ChevronRight, Crown, Lock, Package,
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
import { useEconomy, useInventory, useEconomyInvalidator } from "@/hooks/use-economy";
import { CaseOpeningDialog } from "@/components/rewards/CaseOpeningDialog";
import { FragmentCard } from "@/components/rewards/FragmentCard";
import { PropPuzzle } from "@/components/rewards/PropPuzzle";
import {
  FRAGMENTS, GOLD_FRAGMENTS, RARITY_META,
  type FragmentDef, type CaseType,
} from "@shared/fragments";
import { cn } from "@/lib/utils";

const RARITY_ORDER: (keyof typeof RARITY_META)[] = ["common", "rare", "epic", "covert", "mythic"];

function rarityOddsFor(list: FragmentDef[]) {
  return RARITY_ORDER.map((rarity) => ({
    rarity,
    percent: list.filter((f) => f.rarity === rarity).reduce((s, f) => s + f.dropPercent, 0),
  }));
}

export default function InventoryPage() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const { data: economy } = useEconomy();
  const { data: inventory } = useInventory();
  const invalidate = useEconomyInvalidator();

  const [caseResult, setCaseResult] = useState<FragmentDef | null>(null);
  const [openCaseType, setOpenCaseType] = useState<CaseType>("inspire");
  const [combineConfirm, setCombineConfirm] = useState<CaseType | null>(null);
  const [combineSuccess, setCombineSuccess] = useState<{ reference: string } | null>(null);

  const coins = economy?.coins ?? 0;
  const cases = economy?.cases ?? 0;
  const goldCases = economy?.goldCases ?? 0;

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

  const ownedTypes = useMemo(
    () => FRAGMENTS.filter((f) => (inventory?.[f.id] || 0) >= 1).length,
    [inventory],
  );
  const ownedGoldTypes = useMemo(
    () => GOLD_FRAGMENTS.filter((f) => (inventory?.[f.id] || 0) >= 1).length,
    [inventory],
  );
  const totalFragments = useMemo(
    () => [...FRAGMENTS, ...GOLD_FRAGMENTS].reduce((s, f) => s + (inventory?.[f.id] || 0), 0),
    [inventory],
  );

  const renderCollection = (list: FragmentDef[], set: CaseType) => {
    const owned = set === "inspire" ? ownedTypes : ownedGoldTypes;
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
                : "bg-amber-500 text-black hover:bg-amber-400",
            )}
            disabled={!canCombine || combineMutation.isPending}
            onClick={() => setCombineConfirm(set)}
          >
            <Lock className="mr-2 h-5 w-5" />
            {set === "gold" ? t("combineButtonGold") : t("combineButton")}
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
    const count = isGold ? goldCases : cases;
    const list = isGold ? GOLD_FRAGMENTS : FRAGMENTS;
    return (
      <div className="flex items-center gap-4">
        <div
          className={cn(
            "relative flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border",
            isGold
              ? "border-amber-500/40 bg-gradient-to-br from-amber-500/25 via-amber-500/5 to-transparent shadow-[0_0_24px_-6px_rgba(245,158,11,0.6)]"
              : "border-primary/30 bg-gradient-to-br from-primary/20 via-primary/5 to-transparent shadow-[0_0_24px_-6px_hsl(var(--primary)/0.5)]",
          )}
        >
          {isGold ? <Crown className="h-7 w-7 text-amber-400" /> : <Gem className="h-7 w-7 text-primary" />}
          <span className={cn("absolute -right-2 -top-2 rounded-full px-2 py-0.5 text-xs font-bold", isGold ? "bg-amber-500 text-black" : "bg-primary text-primary-foreground")}>
            {count}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {isGold ? t("goldCase") : t("inspireCase")} · {isGold ? "10k$" : "5k$"}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {rarityOddsFor(list).map(({ rarity, percent }) => (
              <span key={rarity} className="rounded-full px-1.5 py-0.5 text-[10px] font-bold" style={{ backgroundColor: `${RARITY_META[rarity].color}1f`, color: RARITY_META[rarity].color }}>
                {RARITY_META[rarity].label} {percent}%
              </span>
            ))}
          </div>
        </div>
        <Button
          size="sm"
          className={cn("shrink-0 rounded-xl font-semibold", isGold && "bg-amber-500 text-black hover:bg-amber-400")}
          disabled={count < 1 || openMutation.isPending}
          onClick={() => openMutation.mutate(set)}
        >
          <ChevronRight className="mr-1 h-4 w-4" />{t("openCase")}
        </Button>
      </div>
    );
  };

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
          {cases < 1 && goldCases < 1 && (
            <p className="text-center text-xs text-muted-foreground">{t("noCases")}</p>
          )}
        </CardContent>
      </Card>

      {/* Puzzles + collections — one tab per prop account */}
      <Tabs defaultValue="inspire">
        <TabsList className="glass-panel rounded-full border border-border/60">
          <TabsTrigger value="inspire" className="gap-1.5 rounded-full"><Gem className="h-4 w-4" />5k$</TabsTrigger>
          <TabsTrigger value="gold" className="gap-1.5 rounded-full"><Crown className="h-4 w-4" />10k$</TabsTrigger>
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
      </Tabs>

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
              {combineConfirm === "gold" ? t("combineDescriptionGold") : t("combineDescription")}
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
