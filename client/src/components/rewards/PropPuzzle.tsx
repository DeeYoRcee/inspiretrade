import { motion } from "framer-motion";
import { Building2, Crown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/language-context";
import { CASES, RARITY_META, type CaseType } from "@shared/fragments";
import { cn } from "@/lib/utils";
import type { Inventory } from "@/hooks/use-economy";

interface PropPuzzleProps {
  inventory: Inventory | undefined;
  /** which prop account puzzle to render: inspire = $5,000, gold = $10,000 */
  set: CaseType;
  onComplete: () => void;
  completing: boolean;
}

// ---- jigsaw geometry (svg units; board is 3×3 pieces of 100×100) ----------
const S = 100; // piece size
const NECK = 13; // half width of the knob neck
const HEAD = 20; // half width of the knob head
const KNOB = 22; // how far a knob sticks out of an edge

type Pt = [number, number];
type Seg = { c1: Pt; c2: Pt; to: Pt } | { to: Pt };

/** Horizontal edge traversed left→right; dir 1 = knob up, -1 = knob down. */
function hEdge(x0: number, x1: number, y: number, dir: 1 | -1): Seg[] {
  const xm = (x0 + x1) / 2;
  const k = (v: number) => y - dir * v;
  return [
    { to: [xm - NECK, y] },
    { c1: [xm - NECK - 4, k(4)], c2: [xm - HEAD, k(9)], to: [xm - HEAD, k(14)] },
    { c1: [xm - HEAD, k(19)], c2: [xm - HEAD + 7, k(KNOB)], to: [xm, k(KNOB)] },
    { c1: [xm + HEAD - 7, k(KNOB)], c2: [xm + HEAD, k(19)], to: [xm + HEAD, k(14)] },
    { c1: [xm + HEAD, k(9)], c2: [xm + NECK + 4, k(4)], to: [xm + NECK, y] },
    { to: [x1, y] },
  ];
}

/** Vertical edge traversed top→bottom; dir 1 = knob left, -1 = knob right. */
function vEdge(y0: number, y1: number, x: number, dir: 1 | -1): Seg[] {
  const ym = (y0 + y1) / 2;
  const k = (v: number) => x - dir * v;
  return [
    { to: [x, ym - NECK] },
    { c1: [k(4), ym - NECK - 4], c2: [k(9), ym - HEAD], to: [k(14), ym - HEAD] },
    { c1: [k(19), ym - HEAD], c2: [k(KNOB), ym - HEAD + 7], to: [k(KNOB), ym] },
    { c1: [k(KNOB), ym + HEAD - 7], c2: [k(19), ym + HEAD], to: [k(14), ym + HEAD] },
    { c1: [k(9), ym + HEAD], c2: [k(4), ym + NECK + 4], to: [x, ym + NECK] },
    { to: [x, y1] },
  ];
}

/** Reverse a traversed edge (same curve, opposite direction). */
function reverse(segs: Seg[], start: Pt): Seg[] {
  const pts: Pt[] = [start, ...segs.map((s) => s.to)];
  const out: Seg[] = [];
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    out.push("c1" in s ? { c1: s.c2, c2: s.c1, to: pts[i] } : { to: pts[i] });
  }
  return out;
}

function toPath(start: Pt, segs: Seg[]): string {
  let d = `M ${start[0]} ${start[1]}`;
  for (const s of segs) {
    d +=
      "c1" in s
        ? ` C ${s.c1[0]} ${s.c1[1]} ${s.c2[0]} ${s.c2[1]} ${s.to[0]} ${s.to[1]}`
        : ` L ${s.to[0]} ${s.to[1]}`;
  }
  return `${d} Z`;
}

// Horizontal knobs always point up (out of the lower piece) so a piece label
// never collides with a notch; vertical knobs alternate for an organic look.
const vDir = (r: number, c: number): 1 | -1 => ((r * 5 + c * 3) % 2 === 0 ? 1 : -1);

/** Closed outline of the jigsaw piece at grid position (r, c). */
function piecePath(r: number, c: number): string {
  const x = c * S;
  const y = r * S;
  const TL: Pt = [x, y];
  const TR: Pt = [x + S, y];
  const BR: Pt = [x + S, y + S];
  const BL: Pt = [x, y + S];
  const segs: Seg[] = [];
  // top (TL → TR): knob up = out of this piece
  for (const s of r === 0 ? [{ to: TR } as Seg] : hEdge(x, x + S, y, 1)) segs.push(s);
  // right (TR → BR)
  for (const s of c === 2 ? [{ to: BR } as Seg] : vEdge(y, y + S, x + S, vDir(r, c + 1))) segs.push(s);
  // bottom (BR → BL): reversed edge shared with the piece below
  for (const s of r === 2 ? [{ to: BL } as Seg] : reverse(hEdge(x, x + S, y + S, 1), BL)) segs.push(s);
  // left (BL → TL): reversed edge shared with the piece on the left
  for (const s of c === 0 ? [{ to: TL } as Seg] : reverse(vEdge(y, y + S, x, vDir(r, c)), TL)) segs.push(s);
  return toPath(TL, segs);
}

// Precompute all 9 outlines once (pure geometry, no state).
const PIECE_PATHS = Array.from({ length: 9 }, (_, i) => piecePath(Math.floor(i / 3), i % 3));

/**
 * 9-piece jigsaw of a prop account. Each of the 9 fragment types
 * ("5k$ 1" … "5k$ 9" or "10k$ 1" … "10k$ 9") unlocks one interlocking
 * piece. Pieces show ONLY their number — the prop account tier (5k$/10k$)
 * is shown as a badge beside the puzzle. When all 9 are unlocked the puzzle
 * is assembled and the prop account can be claimed (burns one of each
 * fragment).
 */
export function PropPuzzle({ inventory, set, onComplete, completing }: PropPuzzleProps) {
  const { t } = useLanguage();
  const caseDef = CASES[set];
  const isGold = set === "gold";
  const fragmentList = caseDef.fragments;
  const unlocked = fragmentList.map((f) => (inventory?.[f.id] || 0) >= 1);
  const unlockedCount = unlocked.filter(Boolean).length;
  const complete = unlockedCount === fragmentList.length;

  const gradientId = `pz-open-${set}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className={cn("flex items-center gap-2 font-semibold", isGold && "text-amber-400")}>
            {isGold ? <Crown className="h-4 w-4 text-amber-400" /> : <Building2 className="h-4 w-4 text-amber-400" />}
            {isGold ? t("goldPuzzleTitle") : t("puzzleTitle")}
          </h3>
          <p className="text-xs text-muted-foreground">{isGold ? t("goldPuzzleSubtitle") : t("puzzleSubtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* which prop account this puzzle builds: 5k$ or 10k$ */}
          <span
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-bold",
              isGold
                ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                : "border-primary/40 bg-primary/10 text-primary",
            )}
          >
            {isGold ? "10k$" : "5k$"} {t("propAccount")}
          </span>
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
      </div>

      {/* 3×3 interlocking jigsaw — each unlocked piece is gold and shows its
          slice of the prop account card */}
      <div className="relative">
        {complete && (
          <motion.div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[2rem]"
            style={{ background: "radial-gradient(ellipse at center, rgba(245,158,11,0.30), transparent 65%)" }}
            animate={{ opacity: [0.35, 0.95, 0.35] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
          />
        )}
        <svg viewBox="-4 -4 308 308" className="relative mx-auto block w-full max-w-[420px]">
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.36" />
              <stop offset="52%" stopColor="#f59e0b" stopOpacity="0.10" />
              <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.24" />
            </linearGradient>
          </defs>

          {fragmentList.map((fragment, i) => {
            const r = Math.floor(i / 3);
            const c = i % 3;
            const isOpen = unlocked[i];
            const meta = RARITY_META[fragment.rarity];
            const cx = c * S + S / 2;
            const cy = r * S + S / 2;
            return (
              <g key={fragment.id}>
                <path
                  d={PIECE_PATHS[i]}
                  style={{
                    fill: isOpen ? `url(#${gradientId})` : "hsl(var(--card) / 0.45)",
                    stroke: complete
                      ? "rgba(245,158,11,0.30)"
                      : isOpen
                        ? "rgba(245,158,11,0.55)"
                        : "hsl(var(--border))",
                    strokeWidth: complete ? 1 : 1.6,
                    strokeDasharray: isOpen || complete ? undefined : "5 4",
                    transition: "fill 0.4s ease, stroke 0.4s ease",
                  }}
                />
                {isOpen ? (
                  <g style={{ pointerEvents: "none" }}>
                    <text
                      x={cx}
                      y={cy + 5}
                      textAnchor="middle"
                      fontSize="15"
                      fontWeight={800}
                      style={{ fill: "#fbbf24", letterSpacing: "0.05em" }}
                    >
                      {fragment.name}
                    </text>
                  </g>
                ) : (
                  <g style={{ pointerEvents: "none" }}>
                    <g
                      style={{
                        fill: "none",
                        stroke: "hsl(var(--muted-foreground) / 0.75)",
                        strokeWidth: 1.8,
                      }}
                    >
                      <rect x={cx - 7.5} y={cy - 3} width={15} height={11.5} rx={2.5} />
                      <path d={`M ${cx - 4} ${cy - 3} v -2.5 a 4 4 0 0 1 8 0 v 2.5`} />
                    </g>
                    <text
                      x={cx}
                      y={cy + 19}
                      textAnchor="middle"
                      fontSize="11"
                      fontWeight={700}
                      style={{ fill: "hsl(var(--muted-foreground) / 0.8)" }}
                    >
                      {fragment.name}
                    </text>
                  </g>
                )}
                {/* rarity dot */}
                <circle
                  cx={cx + 30}
                  cy={cy - 30}
                  r={3.2}
                  style={{ fill: isOpen ? meta.color : "hsl(var(--muted-foreground) / 0.4)" }}
                />
              </g>
            );
          })}
        </svg>
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
              {completing ? t("combining") : isGold ? t("claimGoldPropAccount") : t("claimPropAccount")}
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
