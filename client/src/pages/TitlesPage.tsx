import { motion } from "framer-motion";
import { Crown, Sparkles, Award, Gem, Frame } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useUserProfile } from "@/hooks/use-premium";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/lib/language-context";
import { FramesGallery } from "@/components/profile/FramesGallery";
import { cn } from "@/lib/utils";

/**
 * Phase 32 — Titles. Titles are derived from account status and
 * a future-proof `profile.titles` map (owner-granted). They render as small
 * badge chips on the profile and public profile.
 */

export interface TitleDef {
  id: string;
  label: string;
  color: string; // tailwind text class
  border: string;
  bg: string;
  glow: string;
  icon: typeof Crown;
  description: string;
}

export const TITLE_DEFS: TitleDef[] = [
  {
    id: "ceo",
    label: "CEO",
    color: "text-amber-300",
    border: "border-amber-400/70",
    bg: "bg-gradient-to-br from-amber-500/25 via-amber-500/10 to-transparent",
    glow: "shadow-[0_0_22px_-4px_rgba(245,158,11,0.85)]",
    icon: Crown,
    description: "Platform owner — the gold-standard title.",
  },
  {
    id: "vip",
    label: "VIP",
    color: "text-violet-300",
    border: "border-violet-400/60",
    bg: "bg-gradient-to-br from-violet-500/25 via-violet-500/10 to-transparent",
    glow: "shadow-[0_0_22px_-4px_rgba(139,92,246,0.7)]",
    icon: Sparkles,
    description: "Premium membership status.",
  },
  {
    id: "collector",
    label: "Collector",
    color: "text-sky-300",
    border: "border-sky-400/60",
    bg: "bg-gradient-to-br from-sky-500/20 via-sky-500/10 to-transparent",
    glow: "shadow-[0_0_22px_-4px_rgba(56,189,248,0.6)]",
    icon: Gem,
    description: "Owns at least one collectible username.",
  },
];

/** Compute the title list for a profile snapshot shape. */
export function titlesForProfile(profile: {
  ceo?: boolean;
  isPremium?: boolean;
  premiumPlan?: string;
  emailVerified?: boolean;
  usernames?: unknown;
  titles?: Record<string, { title?: string; color?: string; at?: number }>;
} | null | undefined): TitleDef[] {
  if (!profile) return [];
  const out: TitleDef[] = [];
  if (profile.ceo) out.push(TITLE_DEFS[0]);
  if (profile.isPremium || profile.premiumPlan) out.push(TITLE_DEFS[1]);
  const held = profile.usernames ? Object.keys(profile.usernames as Record<string, unknown>).length : 0;
  // Phase 33: find by id — TITLE_DEFS[3] broke when the Verified title was removed
  const collector = TITLE_DEFS.find((tt) => tt.id === "collector");
  if (held > 0 && collector) out.push(collector);
  // owner-granted custom titles (profile.titles) render as neutral gold chips
  void profile.titles;
  return out;
}

/** Title strip — used on ProfilePage and ProfilePresentation. */
export function TitleStrip({ titles, size = "md" }: { titles: TitleDef[]; size?: "sm" | "md" }) {
  if (!titles.length) return null;
  return (
    <div className={cn("flex flex-wrap items-center justify-center gap-1.5", size === "sm" ? "mt-1.5" : "mt-2")}>
      {titles.map((t) => (
        <span
          key={t.id}
          title={t.description}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-bold uppercase tracking-wider",
            t.border, t.bg, t.color, t.glow,
            size === "sm" ? "text-[9px]" : "text-[10px]",
          )}
        >
          <t.icon className={size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3"} />
          {t.label}
        </span>
      ))}
    </div>
  );
}

export default function TitlesPage() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const { data: profile } = useUserProfile();
  const titles = titlesForProfile(profile ? { ...profile, emailVerified: user?.emailVerified } : null);

  return (
    <div className="container mx-auto max-w-3xl space-y-6 p-4 sm:px-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
          <Award className="h-6 w-6 text-amber-400" />
          {t("titles")}
        </h1>
        <p className="text-sm text-muted-foreground">Your titles shine on your profile.</p>
      </div>

      <Card className="glass-panel border-amber-500/25">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg"><Crown className="h-5 w-5 text-amber-400" />Your titles</CardTitle>
        </CardHeader>
        <CardContent>
          {titles.length ? (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap gap-2">
              {titles.map((tt) => (
                <span
                  key={tt.id}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-bold uppercase tracking-wider",
                    tt.border, tt.bg, tt.color, tt.glow,
                  )}
                >
                  <tt.icon className="h-4 w-4" />
                  {tt.label}
                </span>
              ))}
            </motion.div>
          ) : (
            <p className="text-sm text-muted-foreground">No titles yet — verify your email, go premium or collect a username to earn the first one.</p>
          )}
        </CardContent>
      </Card>

      <Card className="glass-panel border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">All titles</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {/* Phase 32b: the CEO title is personal — it is not listed here; Verified was removed */}
          {TITLE_DEFS.filter((tt) => tt.id !== "ceo").map((tt) => (
            <div key={tt.id} className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-card/40 px-3.5 py-2.5">
              <div className="flex items-center gap-3 min-w-0">
                <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider", tt.border, tt.bg, tt.color)}>
                  <tt.icon className="h-3 w-3" />{tt.label}
                </span>
                <span className="truncate text-xs text-muted-foreground">{tt.description}</span>
              </div>
              {titles.some((x) => x.id === tt.id) && (
                <Badge variant="outline" className="shrink-0 border-emerald-500/50 text-emerald-400">Owned</Badge>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* P64R2 user request — TITLES and FRAMES are two SEPARATE sections:
          the title cards stay grouped above; frames get their own section
          (own heading card) below a clear divider. */}
      <div className="flex items-center gap-3 pt-1" role="separator" aria-label="frames-section">
        <span className="h-px flex-1 bg-border/40" />
        <Frame className="h-4 w-4 text-primary/70" />
        <span className="h-px flex-1 bg-border/40" />
      </div>
      <FramesGallery />
    </div>
  );
}
