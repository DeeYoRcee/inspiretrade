import { useMemo } from "react";
import {
  ShieldCheck, Hourglass, Scale, FlaskConical, ClipboardList, Brain,
  Repeat, Crosshair, Crown, Gem, Zap, Star, Target, Medal, Trophy,
  Rocket, Diamond, type LucideIcon,
} from "lucide-react";
import { getFragment, RARITY_META, type FragmentDef, type Rarity } from "@shared/fragments";
import { cn } from "@/lib/utils";

const ICONS: Record<string, LucideIcon> = {
  ShieldCheck, Hourglass, Scale, FlaskConical, ClipboardList, Brain,
  Repeat, Crosshair, Crown, Gem, Zap, Star, Target, Medal, Trophy,
  Rocket, Diamond,
};

/** Lucide icon by fragment `icon` name — shared with the case-opening reel. */
export function FragmentIcon({ icon, className }: { icon: string; className?: string }) {
  const Icon = ICONS[icon] || Crown;
  return <Icon className={className} />;
}

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

export function FragmentCard({ fragmentId, count, className, footer, highlight }: FragmentCardProps) {
  const fragment = useMemo<FragmentDef>(() => getFragment(fragmentId) || FRAGMENTS_FALLBACK, [fragmentId]);
  const meta = RARITY_META[fragment.rarity];
  const Icon = ICONS[fragment.icon] || Crown;

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
      <div
        className="mb-3 flex h-12 w-12 items-center justify-center rounded-full transition-transform duration-300 group-hover:scale-110"
        style={{ backgroundColor: `${meta.color}1f`, color: meta.color }}
      >
        <Icon className="h-6 w-6" />
      </div>
      <p className="text-sm font-semibold leading-tight text-foreground">{fragment.name}</p>
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
