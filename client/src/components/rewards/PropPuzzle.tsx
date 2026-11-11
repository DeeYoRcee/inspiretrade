import { motion } from "framer-motion";
import { Lock, Crown, Building2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/language-context";
import { FRAGMENTS } from "@shared/fragments";
import { cn } from "@/lib/utils";
import type { Inventory } from "@/hooks/use-economy";

interface PropPuzzleProps {
  inventory: Inventory | undefined;
  onComplete: () => void;
  completing: boolean;
}

/**
 * 9-piece puzzle of a $5,000 prop account. Each of the 9 fragment types
 * unlocks one tile; the tile shows its slice of the account card (account
 * size, logo quadrant, stat lines). When all 9 are unlocked the user can
 * claim the prop account (burns one of each fragment server-side).
 */
export function PropPuzzle({ inventory, onComplete, completing }: PropPuzzleProps) {
  const { t } = useLanguage();
  const unlocked = FRAGMENTS.map((f) => (inventory?.[f.id] || 0) >= 1);
  const unlockedCount = unlocked.filter(Boolean).length;
  const complete = unlockedCount === FRAGMENTS.length;

  const tileFaces = [
    { top: "ACCOUNT", main: "$5,000", sub: "InspireTrade" },
    { top: "PROFIT", main: "TARGET", sub: "+$3,000" },
    { top: "MAX LOSS", main: "$150", sub: "daily" },
    { top: "PHASE", main: "01", sub: "evaluation" },
    { top: "TRADES", main: "UNLTD", sub: "min 5 days" },
    { top: "SPLIT", main: "80/20", sub: "profit share" },
    { top: "LEVERAGE", main: "1:100", sub: "forex · metals" },
    { top: "DRAWDOWN", main: "6%", sub: "max total" },
    { top: "STATUS", main: "FUNDED", sub: "payout weekly" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-2 font-semibold">
            <Building2 className="h-4 w-4 text-amber-400" />
            {t("puzzleTitle")}
          </h3>
          <p className="text-xs text-muted-foreground">{t("puzzleSubtitle")}</p>
        </div>
        <span
          className={cn(
            "rounded-full border px-3 py-1 text-xs font-bold",
            complete
              ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
              : "border-border/60 bg-card/60 text-muted-foreground",
          )}
        >
          {unlockedCount}/9 {t("puzzlePieces")}
        </span>
      </div>

      {/* 3×3 puzzle grid — each tile is a slice of the prop account card */}
      <div className="mx-auto grid w-full max-w-[420px] grid-cols-3 gap-1.5">
        {FRAGMENTS.map((fragment, i) => {
          const isOpen = unlocked[i];
          const face = tileFaces[i];
          return (
            <motion.div
              key={fragment.id}
              layout
              whileHover={{ scale: isOpen ? 1.02 : 1 }}
              className={cn(
                "relative flex aspect-square flex-col items-center justify-center overflow-hidden rounded-xl border text-center",
                isOpen
                  ? "border-amber-500/40 bg-gradient-to-br from-amber-500/25 via-amber-500/10 to-primary/10"
                  : "border-border/50 bg-card/40",
              )}
            >
              {isOpen ? (
                <motion.div initial={{ opacity: 0, rotateY: 90 }} animate={{ opacity: 1, rotateY: 0 }} transition={{ duration: 0.45 }} className="flex flex-col items-center gap-0.5 p-1">
                  <span className="text-[9px] font-bold uppercase tracking-widest text-amber-500/80">{face.top}</span>
                  <span className="text-sm font-black leading-none text-foreground sm:text-base">{face.main}</span>
                  <span className="text-[9px] text-muted-foreground">{face.sub}</span>
                  <CheckCircle2 className="mt-0.5 h-3 w-3 text-emerald-400" />
                </motion.div>
              ) : (
                <div className="flex flex-col items-center gap-1 text-muted-foreground/60">
                  <Lock className="h-4 w-4" />
                  <span className="text-[10px] font-bold">{i + 1}</span>
                </div>
              )}
              {/* rarity corner dot */}
              <span
                className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full"
                style={{
                  backgroundColor: isOpen ? undefined : "#6663",
                  boxShadow: isOpen ? `0 0 6px ${rarityDot(fragment.id)}` : undefined,
                }}
              />
            </motion.div>
          );
        })}
      </div>

      <div className="flex flex-col items-center gap-2">
        {complete ? (
          <>
            <Button
              size="lg"
              onClick={onComplete}
              disabled={completing}
              className="w-full max-w-md rounded-xl bg-gradient-to-r from-amber-500 to-yellow-400 font-bold text-black shadow-[0_0_24px_-4px_rgba(245,158,11,0.6)] hover:from-amber-400 hover:to-yellow-300"
            >
              <Crown className="mr-2 h-5 w-5" />
              {completing ? t("combining") : t("claimPropAccount")}
            </Button>
            <p className="text-xs font-medium text-amber-400">{t("puzzleComplete")}</p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">{t("puzzleHint")}</p>
        )}
      </div>
    </div>
  );
}

/** Mythic (9th piece) gets the gold glow, covert red, epic purple, rare blue, common gray. */
function rarityDot(fragmentId: string): string {
  const fragment = FRAGMENTS.find((f) => f.id === fragmentId);
  if (!fragment) return "#999";
  const colors: Record<string, string> = {
    common: "#b0c3d9",
    rare: "#4b69ff",
    epic: "#8847ff",
    covert: "#eb4b4b",
    mythic: "#ffd700",
  };
  return colors[fragment.rarity] || "#999";
}
