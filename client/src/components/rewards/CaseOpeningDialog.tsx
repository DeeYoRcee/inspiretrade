import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FRAGMENTS, RARITY_META, type FragmentDef } from "@shared/fragments";
import { FragmentCard, FragmentIcon } from "./FragmentCard";
import { Gem, Sparkles } from "lucide-react";
import { useLanguage } from "@/lib/language-context";

const STEP = 120; // px per reel item (w-[112px] + 8px gap)
const WINNER_INDEX = 46;
const SHAKE_MS = 1300; // the case rattles before it pops open
const SPIN_MS = 5100; // reel scroll duration

type Stage = "case" | "reel" | "result";

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
 * CS2-style case opening — pure presentation, the outcome is decided
 * server-side. Sequence: the case rattles on top and pops open, then the
 * dropped fragments appear below it and the reel scrolls past before
 * landing on the winner.
 */
export function CaseOpeningDialog({ open, result, onClose }: CaseOpeningDialogProps) {
  const { t } = useLanguage();
  const containerRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Stage>("case");
  const [offset, setOffset] = useState<number | null>(null);

  const items = useMemo(() => {
    if (!open || !result) return [];
    const fillers: FragmentDef[] = Array.from({ length: WINNER_INDEX + 12 }, () => pickFiller());
    fillers[WINNER_INDEX] = result;
    return fillers;
  }, [open, result]);

  // stage machine: case shakes → lid pops + reel drops in → winner reveal
  useEffect(() => {
    if (!open || !result) return;
    setStage("case");
    setOffset(null);
    const timers = [
      window.setTimeout(() => setStage("reel"), SHAKE_MS),
      window.setTimeout(() => setStage("result"), SHAKE_MS + SPIN_MS + 600),
    ];
    return () => timers.forEach((tid) => window.clearTimeout(tid));
  }, [open, result]);

  // kick off the reel scroll once the reel stage mounts
  useEffect(() => {
    if (stage !== "reel") return;
    const width = containerRef.current?.clientWidth || 640;
    const winnerCenter = WINNER_INDEX * STEP + 56;
    const jitter = (Math.random() - 0.5) * 48;
    const target = Math.max(0, winnerCenter - width / 2 + jitter);

    let cancelled = false;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (!cancelled) setOffset(target);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [stage]);

  if (!result) return null;
  const meta = RARITY_META[result.rarity];

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && stage === "result") onClose(); }}>
      <DialogContent className="glass-panel max-w-3xl overflow-hidden border-border/60 p-5 sm:p-6">
        <DialogTitle className="sr-only">{t("caseOpeningTitle")}</DialogTitle>

        <AnimatePresence mode="wait">
          {stage !== "result" ? (
            <motion.div
              key="opening"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.25 }}
              className="flex flex-col items-center gap-4"
            >
              {/* the case */}
              <div className="relative flex h-40 items-end justify-center">
                {stage !== "case" && (
                  <motion.div
                    initial={{ opacity: 0.95, scale: 0.4 }}
                    animate={{ opacity: 0, scale: 2.6 }}
                    transition={{ duration: 0.7, ease: "easeOut" }}
                    className="absolute bottom-4 h-24 w-44 rounded-full"
                    style={{ background: "radial-gradient(ellipse at center, rgba(245,158,11,0.55), transparent 65%)" }}
                  />
                )}
                <motion.div
                  animate={
                    stage === "case"
                      ? { x: [0, -10, 10, -8, 8, -5, 5, -2, 2, 0], rotate: [0, -3, 3, -2.4, 2.4, -1.5, 1.5, -0.6, 0.6, 0] }
                      : { x: 0, rotate: 0 }
                  }
                  transition={stage === "case" ? { duration: SHAKE_MS / 1000, ease: "easeInOut" } : { duration: 0.3 }}
                  className="relative z-10 flex flex-col items-center"
                >
                  {/* lid */}
                  <motion.div
                    animate={stage === "case" ? { y: 0, rotate: 0, opacity: 1 } : { y: -92, rotate: -14, opacity: 0 }}
                    transition={{ duration: 0.45, ease: "easeOut" }}
                    className="z-20 -mb-1.5 flex h-10 w-40 items-end justify-center rounded-t-2xl border-2 border-b-0 border-amber-500/50 bg-gradient-to-b from-amber-400/50 to-amber-500/10"
                    style={{ boxShadow: "0 0 26px -4px rgba(245,158,11,0.55)" }}
                  >
                    <div className="mb-1 h-2.5 w-12 rounded-t-full border-x-2 border-t-2 border-amber-500/50" />
                  </motion.div>
                  {/* base */}
                  <div className="flex h-24 w-44 flex-col items-center justify-center gap-1.5 rounded-b-2xl rounded-t-lg border-2 border-amber-500/50 bg-gradient-to-b from-amber-500/30 via-amber-600/10 to-transparent">
                    <Gem className="h-8 w-8 text-amber-400" />
                    <span className="text-[10px] font-black uppercase tracking-[0.3em] text-amber-400/90">Inspire Case</span>
                  </div>
                </motion.div>
              </div>

              {/* fragments dropping from the case */}
              {stage === "reel" ? (
                <motion.div
                  initial={{ opacity: 0, y: -28 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, ease: "easeOut" }}
                  className="w-full"
                >
                  <div className="relative">
                    <div
                      className="pointer-events-none absolute left-1/2 top-0 z-20 h-full w-0.5 -translate-x-1/2"
                      style={{ background: `linear-gradient(180deg, transparent, ${meta.color}, transparent)`, boxShadow: `0 0 12px 2px ${meta.color}88` }}
                    />
                    <div ref={containerRef} className="case-reel overflow-hidden py-3">
                      <div
                        className="flex gap-2"
                        style={{
                          transform: offset === null ? "translateX(0px)" : `translateX(-${offset}px)`,
                          transition: offset === null ? "none" : `transform ${SPIN_MS}ms cubic-bezier(0.12, 0.75, 0.12, 1)`,
                        }}
                      >
                        {items.map((item, index) => {
                          const itemMeta = RARITY_META[item.rarity];
                          return (
                            <div
                              key={index}
                              className="flex h-24 w-28 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border"
                              style={{ borderColor: `${itemMeta.color}66`, background: `linear-gradient(180deg, transparent 30%, ${itemMeta.color}2e 100%)` }}
                            >
                              <span style={{ color: itemMeta.color }}>
                                <FragmentIcon icon={item.icon} className="h-6 w-6" />
                              </span>
                              <span className="text-xs font-bold" style={{ color: itemMeta.color }}>
                                {item.name}
                              </span>
                              <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                                {itemMeta.label}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    <p className="text-center text-xs text-muted-foreground">{t("caseOpeningSpinning")}</p>
                  </div>
                </motion.div>
              ) : (
                <p className="text-center text-xs text-muted-foreground">{t("openingCase")}</p>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="result"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.35, ease: "easeOut" }}
              className="flex flex-col items-center gap-4 py-2"
            >
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
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
