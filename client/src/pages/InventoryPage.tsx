import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useMutation } from "@tanstack/react-query";
import {
  Coins, PackageOpen, Gem, Layers, ChevronRight, BadgeCheck, Lock, Crown, Package,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language-context";
import { authedFetch } from "@/lib/api";
import { useEconomy, useInventory, useEconomyInvalidator } from "@/hooks/use-economy";
import { CaseOpeningDialog } from "@/components/rewards/CaseOpeningDialog";
import { FragmentCard } from "@/components/rewards/FragmentCard";
import { PropPuzzle } from "@/components/rewards/PropPuzzle";
import { FRAGMENTS, RARITY_META, type FragmentDef } from "@shared/fragments";

const RARITY_ORDER: (keyof typeof RARITY_META)[] = ["common", "rare", "epic", "covert", "mythic"];

export default function InventoryPage() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const { data: economy } = useEconomy();
  const { data: inventory } = useInventory();
  const invalidate = useEconomyInvalidator();

  const [caseResult, setCaseResult] = useState<FragmentDef | null>(null);
  const [combineConfirm, setCombineConfirm] = useState(false);
  const [combineSuccess, setCombineSuccess] = useState<{ reference: string } | null>(null);

  const coins = economy?.coins ?? 0;
  const cases = economy?.cases ?? 0;

  const ownedTypes = useMemo(
    () => FRAGMENTS.filter((f) => (inventory?.[f.id] || 0) >= 1).length,
    [inventory],
  );
  const totalFragments = useMemo(
    () => FRAGMENTS.reduce((s, f) => s + (inventory?.[f.id] || 0), 0),
    [inventory],
  );
  const canCombine = ownedTypes === FRAGMENTS.length;

  const openMutation = useMutation({
    mutationFn: async () => {
      const res = await authedFetch("/api/cases/open", {});
      return res as { fragment: FragmentDef };
    },
    onSuccess: (data) => setCaseResult(data.fragment),
    onError: (error: any) => {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
    },
  });

  const combineMutation = useMutation({
    mutationFn: async () => authedFetch("/api/fragments/combine", {}) as Promise<{ claim: { reference: string } }>,
    onSuccess: (data) => {
      setCombineConfirm(false);
      setCombineSuccess(data.claim);
      invalidate();
    },
    onError: (error: any) => {
      toast({ title: t("serverError"), description: String(error?.message || ""), variant: "destructive" });
    },
  });

  const rarityOdds = RARITY_ORDER.map((rarity) => ({
    rarity,
    percent: FRAGMENTS.filter((f) => f.rarity === rarity).reduce((s, f) => s + f.dropPercent, 0),
  }));

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
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Cases */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          <Card className="glass-panel border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg"><PackageOpen className="h-5 w-5 text-primary" />{t("casesTitle")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-4">
                <div className="relative flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/20 via-primary/5 to-transparent shadow-[0_0_24px_-6px_hsl(var(--primary)/0.5)]">
                  <Gem className="h-9 w-9 text-primary" />
                  <span className="absolute -right-2 -top-2 rounded-full bg-primary px-2 py-0.5 text-xs font-bold text-primary-foreground">{cases}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{t("caseContains")}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {rarityOdds.map(({ rarity, percent }) => (
                      <span key={rarity} className="rounded-full px-2 py-0.5 text-[10px] font-bold" style={{ backgroundColor: `${RARITY_META[rarity].color}1f`, color: RARITY_META[rarity].color }}>
                        {RARITY_META[rarity].label} {percent}%
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              <Button
                size="lg"
                className="w-full rounded-xl font-semibold"
                disabled={cases < 1 || openMutation.isPending}
                onClick={() => openMutation.mutate()}
              >
                {openMutation.isPending ? t("openingCase") : <><ChevronRight className="mr-2 h-5 w-5" />{t("openCase")}</>}
              </Button>
              {cases < 1 && <p className="text-center text-xs text-muted-foreground">{t("noCases")}</p>}
            </CardContent>
          </Card>
        </motion.div>

        {/* 9-piece prop account puzzle */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.05 }}>
          <Card className="glass-panel border-amber-500/25">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg"><Crown className="h-5 w-5 text-amber-400" />{t("propAccountPuzzle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <PropPuzzle
                inventory={inventory}
                completing={combineMutation.isPending}
                onComplete={() => setCombineConfirm(true)}
              />
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Fragment collection */}
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
        <CardContent className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {FRAGMENTS.map((fragment) => {
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
              className="w-full max-w-md rounded-xl bg-amber-500 font-semibold text-black hover:bg-amber-400"
              disabled={!canCombine || combineMutation.isPending}
              onClick={() => setCombineConfirm(true)}
            >
              <Lock className="mr-2 h-5 w-5" />{t("combineButton")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {canCombine ? t("combineReady") : t("missingFragmentsHint")}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Case opening reel */}
      <CaseOpeningDialog
        open={!!caseResult}
        result={caseResult}
        onClose={() => {
          setCaseResult(null);
          invalidate();
        }}
      />

      {/* Combine confirm */}
      <AlertDialog open={combineConfirm} onOpenChange={setCombineConfirm}>
        <AlertDialogContent className="glass-panel border-border/60">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 font-display"><Crown className="h-5 w-5 text-amber-400" />{t("combineTitle")}</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">{t("combineDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl">{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="rounded-xl bg-amber-500 font-semibold text-black hover:bg-amber-400"
              disabled={combineMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                combineMutation.mutate();
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
