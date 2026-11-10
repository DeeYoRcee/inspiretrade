import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FRAGMENTS, RARITY_META, type FragmentDef } from "@shared/fragments";
import { FragmentCard } from "./FragmentCard";
import { Sparkles } from "lucide-react";
import { useLanguage } from "@/lib/language-context";

const STEP = 120; // px per reel item (w-[112px] + 8px gap)
const WINNER_INDEX = 46;

interface CaseOpeningDialogProps {
  open: boolean;
  result: FragmentDef | null;
  onClose: () => void;
}

function pickFiller(): FragmentDef {
  const roll = Math.random();
  const rarity = roll < 0.5 ? "common" : roll < 0.78 ? "rare" : roll < 0.91 ? "epic" : roll < 0.98 ? "covert" : "mythic";
  const pool = FRAGMENTS.filter((f) => f.rarity === rarity);
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * CS2-style case opening: a horizontal reel of fragments spins with a long
 * ease-out and lands on the winning item. The outcome is already decided
 * server-side — this is pure presentation.
 */
export function CaseOpeningDialog({ open, result, onClose }: CaseOpeningDialogProps) {
  const { t } = useLanguage();
  const containerRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);

  const items = useMemo(() => {
    if (!open || !result) return [];
    const fillers: FragmentDef[] = Array.from({ length: WINNER_INDEX + 12 }, () => pickFiller());
    fillers[WINNER_INDEX] = result;
    return fillers;
  }, [open, result]);

  useEffect(() => {
    if (!open || !result) return;
    setOffset(null);
    setRevealed(false);

    const width = containerRef.current?.clientWidth || 640;
    const winnerCenter = WINNER_INDEX * STEP + 56;
    const jitter = (Math.random() - 0.5) * 48;
    const target = Math.max(0, winnerCenter - width / 2 + jitter);

    // Start at 0, then animate on the next frame so the transition runs.
    let cancelled = false;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (!cancelled) setOffset(target);
      });
    });

    const timer = setTimeout(() => setRevealed(true), 6100);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(timer);
    };
  }, [open, result]);

  if (!result) return null;
  const meta = RARITY_META[result.rarity];

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && revealed) onClose(); }}>
      <DialogContent className="glass-panel max-w-3xl overflow-hidden border-border/60 p-6">
        <DialogTitle className="sr-only">{t("caseOpeningTitle")}</DialogTitle>

        {!revealed ? (
          <div className="relative py-2">
            <div
              className="pointer-events-none absolute left-1/2 top-0 z-20 h-full w-0.5 -translate-x-1/2"
              style={{ background: `linear-gradient(180deg, transparent, ${meta.color}, transparent)`, boxShadow: `0 0 12px 2px ${meta.color}88` }}
            />
            <div ref={containerRef} className="case-reel overflow-hidden py-4">
              <div
                className="flex gap-2"
                style={{
                  transform: offset === null ? "translateX(0px)" : `translateX(-${offset}px)`,
                  transition: offset === null ? "none" : "transform 6s cubic-bezier(0.12, 0.75, 0.12, 1)",
                }}
              >
                {items.map((item, index) => {
                  const itemMeta = RARITY_META[item.rarity];
                  return (
                    <div
                      key={index}
                      className="flex h-24 w-28 shrink-0 flex-col items-center justify-center gap-1.5 rounded-xl border bg-card/70"
                      style={{ borderColor: `${itemMeta.color}66`, background: `linear-gradient(180deg, transparent 40%, ${itemMeta.color}2e 100%)` }}
                    >
                      <div className="h-2/3 w-full rounded-lg opacity-90" style={{ boxShadow: `inset 0 -22px 26px -18px ${itemMeta.color}` }} />
                      <span className="px-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: itemMeta.color }}>
                        {itemMeta.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
            <p className="text-center text-xs text-muted-foreground">{t("caseOpeningSpinning")}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 py-2">
            <div className="absolute inset-0 pointer-events-none" style={{ background: `radial-gradient(ellipse at 50% 30%, ${meta.color}2e, transparent 60%)` }} />
            {result.rarity === "mythic" && (
              <p className="flex items-center gap-2 text-lg font-bold tracking-widest" style={{ color: meta.color }}>
                <Sparkles className="h-5 w-5" /> {t("mythicDrop")} <Sparkles className="h-5 w-5" />
              </p>
            )}
            <div className="relative z-10 w-44">
              <FragmentCard fragmentId={result.id} highlight className="shadow-2xl" />
            </div>
            <div className="relative z-10 flex flex-col items-center gap-2">
              <p className="text-sm text-muted-foreground">{t("fragmentCollected")}</p>
              <Button onClick={onClose} className="rounded-xl font-semibold" style={{ backgroundColor: `${meta.color}26`, color: meta.color, border: `1px solid ${meta.color}55` }}>
                {t("addToCollection")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
