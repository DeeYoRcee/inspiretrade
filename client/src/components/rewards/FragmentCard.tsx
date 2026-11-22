import { useMemo } from "react";
import { getFragment, RARITY_META, type FragmentDef, type Rarity } from "@shared/fragments";
import { cn } from "@/lib/utils";

export function rarityStyle(rarity: Rarity) {
  const meta = RARITY_META[rarity];
  return {
    color: meta.color,
    borderColor: `${meta.color}55`,
    background: `linear-gradient(180deg, transparent 55%, ${meta.color}1f 100%)`,
  };
}

interface FragmentCardProps {
  fragmentId: string;
  count?: number;
  className?: string;
  footer?: React.ReactNode;
  highlight?: boolean;
}

/** P42 — icon stickers removed: the fragment label ("5k$ 1") is the top
 *  element, the rarity badge sits under it. No icons on fragment cards. */
export function FragmentCard({ fragmentId, count, className, footer, highlight }: FragmentCardProps) {
  const fragment = useMemo<FragmentDef>(() => getFragment(fragmentId) || FRAGMENTS_FALLBACK, [fragmentId]);
  const meta = RARITY_META[fragment.rarity];

  return (
    <div
      className={cn(
        "group relative flex flex-col items-center overflow-hidden rounded-xl border p-4 text-center transition-all duration-300",
        "bg-card/60 backdrop-blur-sm hover-glow",
        highlight && "shadow-lg",
        className,
      )}
      style={{ borderColor: `${meta.color}44` }}
    >
      {typeof count === "number" && count > 1 && (
        <span className="absolute right-2 top-2 rounded-full px-2 py-0.5 text-xs font-bold" style={{ backgroundColor: `${meta.color}26`, color: meta.color }}>
          ×{count}
        </span>
      )}
      <p className="mt-3 text-lg font-bold leading-tight text-foreground">{fragment.name}</p>
      <span className="mt-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider" style={{ backgroundColor: `${meta.color}1f`, color: meta.color }}>
        {meta.label}
      </span>
      {footer}
      {/* CS2-style rarity bar */}
      <div className="absolute bottom-0 left-0 h-1 w-full opacity-80" style={{ background: `linear-gradient(90deg, ${meta.color}00, ${meta.color}, ${meta.color}00)` }} />
    </div>
  );
}

const FRAGMENTS_FALLBACK: FragmentDef = {
  id: "unknown",
  name: "Unknown",
  icon: "Crown",
  rarity: "common",
  dropPercent: 0,
};
