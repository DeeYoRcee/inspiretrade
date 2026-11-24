import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CASES, RARITY_META, type CaseType, type FragmentDef } from "@shared/fragments";
import { FragmentCard } from "./FragmentCard";
import { Gem, Sparkles, Crown, Lock } from "lucide-react";
import { useLanguage } from "@/lib/language-context";
import { casePop, caseRattle, caseReveal, caseSpin, caseSpinStop } from "@/lib/sfx";
import { cn } from "@/lib/utils";

const STEP = 120; // px per reel item (w-[112px] + 8px gap)
const WINNER_INDEX = 46;
const SHAKE_MS = 1300; // the case rattles before it pops open
const SPIN_MS = 5100; // reel scroll duration

type Stage = "preview" | "case" | "reel" | "result";

export interface BlackResult {
  label: string;
  accountSize: number;
  set: CaseType | string;
  claimId?: string;
  reference?: string;
}

interface CaseOpeningDialogProps {
  open: boolean;
  result: FragmentDef | null;
  /** P77 — the BLACK special drop result (a pending prop-account claim) */
  black?: BlackResult | null;
  /** which case is being opened — decides the drop pool and the case skin */
  caseType?: CaseType | string;
  /** custom cases: the drop pool + display name (built-ins use CASES) */
  pool?: FragmentDef[];
  caseName?: string;
  onClose: () => void;
  /** P77 — when provided, the dialog opens on the CS2-style PREVIEW stage
   *  (3D case + "Contains one of the following:" grid, no percentages) and
   *  only calls this to roll when the user presses Open. Legacy callers that
   *  pass a pre-rolled result skip the preview entirely. */
  onConfirm?: () => Promise<{ fragment?: FragmentDef | null; black?: BlackResult | null }>;
}

function pickFiller(list: FragmentDef[]): FragmentDef {
  const roll = Math.random();
  const rarity = roll < 0.5 ? "common" : roll < 0.78 ? "rare" : roll < 0.91 ? "epic" : roll < 0.98 ? "covert" : "mythic";
  const pool = list.filter((f) => f.rarity === rarity);
  return pool[Math.floor(Math.random() * pool.length)] || list[0];
}

/** P77 — the black pseudo-item rides the reel and the reveal like a fragment. */
function blackAsItem(black: BlackResult): FragmentDef {
  return { id: "__prop_black__", name: black.label, icon: "Crown", rarity: "black", dropPercent: 0 };
}

/** Per-case skin: inspire = primary/blue, gold = amber with a crown. */
const CASE_SKIN: Record<CaseType, { border: string; glow: string; iconTint: string; badge: string; lid: string; body: string }> = {
  inspire: {
    border: "border-primary/50",
    glow: "hsl(var(--primary))",
    iconTint: "text-primary",
    badge: "text-primary/90",
    lid: "border-primary/50 bg-gradient-to-b from-primary/40 to-primary/10",
    body: "from-primary/25 via-primary/10",
  },
  gold: {
    border: "border-amber-500/60",
    glow: "rgba(245,158,11,0.75)",
    iconTint: "text-amber-400",
    badge: "text-amber-400/90",
    lid: "border-amber-500/60 bg-gradient-to-b from-amber-400/50 to-amber-500/10",
    body: "from-amber-500/30 via-amber-600/10",
  },
  trading: {
    border: "border-emerald-500/60",
    glow: "rgba(16,185,129,0.7)",
    iconTint: "text-emerald-400",
    badge: "text-emerald-400/90",
    lid: "border-emerald-500/60 bg-gradient-to-b from-emerald-400/50 to-emerald-500/10",
    body: "from-emerald-500/25 via-emerald-600/10",
  },
};

/**
 * P77 — the CS2-style 3D container (pure CSS 3D: perspective crate with a
 * front emblem, twin latches, a hanging lock and a lid that pops on open).
 * One component drives BOTH the preview ("Unlock Container") and the opening
 * show, so the case the user inspects is the case that opens.
 */
function Case3D({ skin, isGold, name, open: popped, shake, size = 1 }: {
  skin: { border: string; lid: string; body: string; glow: string; iconTint: string; badge: string };
  isGold: boolean;
  name: string;
  open: boolean;
  shake: boolean;
  size?: number;
}) {
  const w = 208 * size; // front face width px
  const h = 124 * size; // front face height px
  const d = 84 * size; // depth px
  const lidH = 30 * size;
  const Emblem = isGold ? Crown : Gem;
  return (
    <div className="relative" style={{ width: w + d, height: h + lidH + 26 * size, perspective: 900 }}>
      {/* floor shadow */}
      <div
        className="absolute rounded-[50%]"
        style={{
          left: d * 0.4, right: 0, bottom: -8 * size, height: 26 * size,
          background: `radial-gradient(ellipse at center, ${skin.glow.includes("hsl") ? "rgba(0,0,0,0.55)" : "rgba(0,0,0,0.55)"}, transparent 68%)`,
          transform: "rotateX(72deg)",
        }}
      />
      <motion.div
        className="absolute inset-0"
        style={{ transformStyle: "preserve-3d" }}
        initial={false}
        animate={shake && !popped ? { x: [0, -9, 9, -7, 7, -4, 4, -2, 2, 0], rotateY: [-14, -11, -17, -12, -16, -13, -15, -14] } : { x: 0, rotateY: -14 }}
        transition={shake && !popped ? { duration: 1.3, ease: "easeInOut" } : { duration: 0.4 }}
      >
        {/* LID — pops up and tilts when the case opens */}
        <motion.div
          className="absolute rounded-t-xl border-2 border-b-0"
          style={{
            width: w, height: lidH, left: d / 2,
            transformStyle: "preserve-3d",
            transformOrigin: "bottom center",
            zIndex: 30,
            boxShadow: `0 0 26px -4px ${skin.glow}`,
          }}
          initial={false}
          animate={popped
            ? { rotateX: -104, y: -14 * size, opacity: 0.9 }
            : { rotateX: 0, y: 0, opacity: 1 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
        >
          <div className={cn("absolute inset-0 rounded-t-xl border-2 border-b-0 bg-gradient-to-b", skin.lid)} />
          {/* lid handle */}
          <div className={cn("absolute left-1/2 top-1 h-2 w-14 -translate-x-1/2 rounded-full border", isGold ? "border-amber-400/70" : "border-primary/60")} />
          {/* lid front edge (depth) */}
          <div className={cn("absolute left-0 right-0 top-full origin-top border-x-2 bg-gradient-to-b", skin.lid)}
            style={{ height: d * 0.42, transform: "rotateX(-88deg)", transformOrigin: "top center" }} />
        </motion.div>

        {/* BODY — front face */}
        <div
          className={cn("absolute rounded-b-xl rounded-t-md border-2 bg-gradient-to-b to-transparent", skin.border, skin.body)}
          style={{ width: w, height: h, left: d / 2, top: lidH, transform: `translateZ(${d / 2}px)`, zIndex: 20 }}
        >
          {/* circular emblem badge (the CS2 container look) */}
          <div
            className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 bg-background/70 backdrop-blur-[2px]"
            style={{ width: h * 0.52, height: h * 0.52, borderColor: isGold ? "rgba(245,158,11,0.7)" : "hsl(var(--primary)/0.55)", boxShadow: `0 0 18px -4px ${skin.glow}` }}
          >
            <Emblem className={cn("h-1/2 w-1/2", skin.iconTint)} />
          </div>
          {/* latches */}
          <div className={cn("absolute -left-1 top-3 h-5 w-3 rounded-l border-2 border-r-0 bg-background/60", skin.border)} />
          <div className={cn("absolute -right-1 top-3 h-5 w-3 rounded-r border-2 border-l-0 bg-background/60", skin.border)} />
          {/* case name plate */}
          <span className={cn("absolute bottom-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap text-[8px] font-black uppercase tracking-[0.28em]", skin.badge)}>
            {name}
          </span>
        </div>

        {/* BODY — right side face */}
        <div
          className={cn("absolute rounded-r-md border-2 bg-gradient-to-b to-transparent", skin.border, skin.body)}
          style={{
            width: d, height: h, top: lidH, right: 0,
            transform: `rotateY(64deg) translateZ(${w - d * 0.06}px)`,
            transformOrigin: "right center",
            zIndex: 10,
            filter: "brightness(0.72)",
          }}
        >
          {/* vent grooves */}
          <div className="absolute left-2 top-1/2 h-1/2 w-2/3 -translate-y-1/2 space-y-1.5">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-0.5 rounded-full bg-white/10" />)}
          </div>
        </div>

        {/* BODY — left side face (mostly hidden, closes the silhouette) */}
        <div
          className={cn("absolute rounded-l-md border-2 bg-gradient-to-b to-transparent", skin.border, skin.body)}
          style={{
            width: d * 0.9, height: h, top: lidH, left: 0,
            transform: `rotateY(-64deg) translateZ(${w - d * 0.06}px)`,
            transformOrigin: "left center",
            zIndex: 5,
            filter: "brightness(0.6)",
          }}
        />

        {/* BODY — top face (visible under the open lid) */}
        <div
          className={cn("absolute border-2 bg-gradient-to-b to-transparent", skin.border, skin.body)}
          style={{
            width: w, height: d * 0.92, left: d / 2, top: lidH,
            transform: `rotateX(90deg) translateZ(0px) translateY(-${d * 0.46}px)`,
            transformOrigin: "center",
            zIndex: 8,
            filter: "brightness(0.8)",
          }}
        />
      </motion.div>
    </div>
  );
}

/**
 * CS2-style case opening — pure presentation, the outcome is decided
 * server-side. P77 flow: preview (3D container + "Contains one of the
 * following:" WITHOUT percentages) → Open → the case rattles, pops open,
 * the reel scrolls and lands on the winner (fragment or the BLACK prop
 * account).
 */
export function CaseOpeningDialog({ open, result, black = null, caseType = "inspire", pool, caseName, onClose, onConfirm }: CaseOpeningDialogProps) {
  const { t } = useLanguage();
  const containerRef = useRef<HTMLDivElement>(null);
  const timersRef = useRef<number[]>([]);
  const [stage, setStage] = useState<Stage>(onConfirm ? "preview" : "case");
  const [offset, setOffset] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [rolledBlack, setRolledBlack] = useState<BlackResult | null>(null);
  const [rolledFragment, setRolledFragment] = useState<FragmentDef | null>(null);

  // built-ins come from CASES; owner-made custom cases carry their own pool
  const isBuiltin = caseType === "inspire" || caseType === "gold" || caseType === "trading";
  const caseDef = isBuiltin
    ? CASES[caseType as CaseType]
    : { id: caseType as CaseType, name: caseName || caseType, fragments: pool || [], blackDrop: null };
  const skin = CASE_SKIN[caseType as CaseType] ?? CASE_SKIN.inspire;
  const isGold = caseType === "gold";
  const activeBlack = rolledBlack ?? black;
  const activeFragment = rolledFragment ?? result;
  const hasPool = caseDef.fragments.length > 0;

  // the "Contains one of the following" list — fragments + (built-ins) the
  // ★ black prop account card. Percentages are NEVER shown (P77 user request).
  const contains = useMemo(() => {
    if (!hasPool) return [];
    return caseDef.fragments;
  }, [hasPool, caseDef]);

  // the winner as a reelable item — the BLACK drop rides the same show as a
  // pseudo-fragment (never an inventory item). Memoized: a fresh object every
  // render would restart the stage machine on every parent re-render.
  const winnerItem: FragmentDef | null = useMemo(() => {
    if (rolledBlack) return blackAsItem(rolledBlack);
    if (activeFragment) return activeFragment;
    return black ? blackAsItem(black) : null;
  }, [rolledBlack, activeFragment, black]);
  const items = useMemo(() => {
    if (!open || !winnerItem) return [];
    const fillers: FragmentDef[] = Array.from({ length: WINNER_INDEX + 12 }, () => pickFiller(caseDef.fragments.length ? caseDef.fragments : pool || []));
    fillers[WINNER_INDEX] = winnerItem;
    return fillers;
  }, [open, winnerItem, caseDef, pool]);

  // preview → (Open) → rattle → reel → reveal
  useEffect(() => {
    if (!open || !winnerItem) return;
    setStage("case");
    setOffset(null);
    caseRattle();
    timersRef.current = [
      window.setTimeout(() => { setStage("reel"); casePop(); caseSpin(SPIN_MS); }, SHAKE_MS),
      window.setTimeout(() => { setStage("result"); caseReveal(rolledBlack ? "black" : winnerItem.rarity); }, SHAKE_MS + SPIN_MS + 600),
    ];
    return () => { timersRef.current.forEach((tid) => window.clearTimeout(tid)); timersRef.current = []; caseSpinStop(); };
  }, [open, winnerItem, rolledBlack]);

  // reset when the dialog closes
  useEffect(() => {
    if (!open) {
      setStage(onConfirm ? "preview" : "case");
      setRolledBlack(null);
      setRolledFragment(null);
      setOffset(null);
      setConfirming(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const confirmOpen = async () => {
    if (!onConfirm || confirming) return;
    setConfirming(true);
    try {
      const res = await onConfirm();
      setRolledFragment(res.fragment ?? null);
      setRolledBlack(res.black ?? null);
    } catch {
      // the mutation's error toast fires upstream; stay on the preview
    } finally {
      setConfirming(false);
    }
  };

  /** Click-to-skip: jump straight to the reveal (the drop is already decided
   * and credited server-side, skipping only shortens the show). */
  const skipToResult = () => {
    if (!open || !activeFragment || stage === "result") return;
    timersRef.current.forEach((tid) => window.clearTimeout(tid));
    timersRef.current = [];
    caseSpinStop();
    setStage("result");
    caseReveal(activeBlack ? "black" : activeFragment.rarity);
  };

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

  const meta = RARITY_META[activeBlack ? "black" : (activeFragment?.rarity ?? "common")];

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) { caseSpinStop(); onClose(); } }}>
      <DialogContent className="glass-panel max-w-3xl overflow-hidden border-border/60 p-5 sm:p-6">
        <DialogTitle className="sr-only">{t("caseOpeningTitle")}</DialogTitle>

        <AnimatePresence mode="wait">
          {stage === "preview" ? (
            /* ---- P77 PREVIEW — Unlock Container (CS2) ---- */
            <motion.div
              key="preview"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.25 }}
              className="flex w-full min-w-0 flex-col items-center gap-4"
            >
              <div className="text-center">
                <h3 className="text-2xl font-black tracking-wide">Unlock Container</h3>
                <p className="text-sm text-muted-foreground">Unlock <span className="font-semibold text-foreground">{caseDef.name}</span></p>
              </div>
              <div className="flex justify-center py-2">
                <Case3D skin={skin} isGold={isGold} name={caseDef.name} open={false} shake={false} />
              </div>
              <div className="w-full min-w-0">
                <div className="mb-2 flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                  <span>Contains one of the following:</span>
                  <span className="flex items-center gap-1 text-foreground/70"><Lock className="h-3 w-3" /> odds hidden</span>
                </div>
                <div className="grid max-h-44 grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-5">
                  {contains.map((f) => {
                    const m = RARITY_META[f.rarity];
                    return (
                      <div key={f.id} className="flex h-16 flex-col items-center justify-center gap-0.5 rounded-lg border text-center" style={{ borderColor: `${m.color}55`, background: `linear-gradient(180deg, transparent 40%, ${m.color}22 100%)` }}>
                        <span className="px-1 text-[11px] font-bold leading-tight" style={{ color: m.color === "#1c1f26" ? "#c8d0dc" : m.color }}>{f.name}</span>
                        <span className="text-[8px] font-semibold uppercase tracking-wider text-muted-foreground">{m.label}</span>
                      </div>
                    );
                  })}
                  {isBuiltin && CASES[caseType as CaseType].blackDrop && (
                    <div className="flex h-16 flex-col items-center justify-center gap-0.5 rounded-lg border border-white/25 bg-gradient-to-b from-black/80 via-[#0b0c10] to-black text-center shadow-[0_0_18px_-6px_rgba(230,240,255,0.4)]">
                      <span className="px-1 text-[11px] font-bold leading-tight text-slate-200">★ {CASES[caseType as CaseType].blackDrop.label} ★</span>
                      <span className="text-[8px] font-semibold uppercase tracking-wider text-slate-400">Black</span>
                    </div>
                  )}
                </div>
              </div>
              <Button
                onClick={confirmOpen}
                disabled={confirming || !hasPool}
                className="rounded-xl px-8 font-bold tracking-wide"
              >
                {confirming ? "Opening…" : "Open"}
              </Button>
            </motion.div>
          ) : stage !== "result" ? (
            /* ---- OPENING SHOW — rattle + pop + reel ---- */
            <motion.div
              key="opening"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.25 }}
              className="flex w-full min-w-0 flex-col items-center gap-4"
            >
              {/* the case */}
              <div className="relative flex items-end justify-center pt-6">
                {stage !== "case" && (
                  <motion.div
                    initial={{ opacity: 0.95, scale: 0.4 }}
                    animate={{ opacity: 0, scale: 2.6 }}
                    transition={{ duration: 0.7, ease: "easeOut" }}
                    className="absolute bottom-2 h-24 w-44 rounded-full"
                    style={{ background: `radial-gradient(ellipse at center, ${skin.glow.replace("hsl(var(--primary))", "hsl(var(--primary)/0.55)")}, transparent 65%)` }}
                  />
                )}
                <Case3D skin={skin} isGold={isGold} name={caseDef.name} open={stage !== "case"} shake={true} />
              </div>

              {/* fragments dropping from the case */}
              {stage === "reel" ? (
                <motion.div
                  initial={{ opacity: 0, y: -28 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, ease: "easeOut" }}
                  className="w-full min-w-0 cursor-pointer select-none"
                  onClick={skipToResult}
                  title="Click to skip"
                >
                  <div className="relative">
                    <div
                      className="pointer-events-none absolute left-1/2 top-0 z-20 h-full w-0.5 -translate-x-1/2"
                      style={{ background: `linear-gradient(180deg, transparent, ${activeBlack ? "#a8b3c4" : meta.color}, transparent)`, boxShadow: `0 0 12px 2px ${activeBlack ? "#a8b3c488" : meta.color + "88"}` }}
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
                          const isBlack = item.rarity === "black";
                          return (
                            <div
                              key={index}
                              className={cn(
                                "flex h-24 w-28 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border px-1 text-center",
                                isBlack && "border-white/30 bg-gradient-to-b from-black via-[#0b0c10] to-black shadow-[0_0_16px_-4px_rgba(230,240,255,0.5)]",
                              )}
                              style={isBlack ? undefined : { borderColor: `${itemMeta.color}66`, background: `linear-gradient(180deg, transparent 30%, ${itemMeta.color}2e 100%)` }}
                            >
                              <span className="text-sm font-bold" style={{ color: isBlack ? "#dfe6ef" : itemMeta.color }}>
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
            /* ---- RESULT ---- */
            <motion.div
              key="result"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.35, ease: "easeOut" }}
              className="flex flex-col items-center gap-4 py-2"
            >
              <div className="absolute inset-0 pointer-events-none" style={{ background: activeBlack
                ? "radial-gradient(ellipse at 50% 30%, rgba(120,135,160,0.14), transparent 60%)"
                : `radial-gradient(ellipse at 50% 30%, ${meta.color}2e, transparent 60%)` }} />
              {(activeBlack || activeFragment?.rarity === "mythic") && (
                <p className="flex items-center gap-2 text-lg font-bold tracking-widest" style={{ color: activeBlack ? "#dfe6ef" : meta.color }}>
                  <Sparkles className="h-5 w-5" /> {activeBlack ? "BLACK DROP" : t("mythicDrop")} <Sparkles className="h-5 w-5" />
                </p>
              )}
              {activeBlack ? (
                /* the BLACK card — a pending prop-account claim, not a fragment */
                <div className="relative z-10 flex h-56 w-64 flex-col items-center justify-center gap-2 rounded-2xl border border-white/25 bg-gradient-to-b from-black via-[#0b0c10] to-black shadow-[0_0_44px_-8px_rgba(230,240,255,0.55)]">
                  <span className="text-3xl font-black tracking-[0.3em] text-slate-200">★ ★ ★</span>
                  <span className="px-3 text-center text-lg font-bold text-slate-100">{activeBlack.label}</span>
                  <span className="text-[10px] font-semibold uppercase tracking-[0.3em] text-slate-400">Black · Prop Account</span>
                  <span className="mt-1 px-4 text-center text-[11px] text-muted-foreground">
                    A pending prop-account claim has been deposited — check your Wallet claims.
                  </span>
                  {activeBlack.reference && <span className="text-[9px] text-muted-foreground/70">Ref {activeBlack.reference}</span>}
                </div>
              ) : (
                <div className="relative z-10 w-44">
                  <FragmentCard fragmentId={activeFragment!.id} highlight className="shadow-2xl" />
                </div>
              )}
              <div className="relative z-10 flex flex-col items-center gap-2">
                <p className="text-sm text-muted-foreground">{activeBlack ? "Prop account deposited" : t("fragmentCollected")}</p>
                <div className="flex items-center gap-2">
                  <Button onClick={onClose} className="rounded-xl font-semibold" style={{ backgroundColor: activeBlack ? "rgba(200,210,225,0.14)" : `${meta.color}26`, color: activeBlack ? "#dfe6ef" : meta.color, border: `1px solid ${activeBlack ? "rgba(230,240,255,0.4)" : meta.color + "55"}` }}>
                    {activeBlack ? "Collect" : t("addToCollection")}
                  </Button>
                  <Button variant="ghost" onClick={onClose} className="rounded-xl text-muted-foreground">
                    {t("notNow")}
                  </Button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
