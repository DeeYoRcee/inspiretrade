import { useState } from "react";
import { motion } from "framer-motion";
import { Check, Clapperboard, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLanguage } from "@/lib/language-context";
import { useToast } from "@/hooks/use-toast";
import { saveUserProfile, type UserProfile } from "@/hooks/use-premium";
import { PROFILE_BACKGROUNDS, getProfileBackground, type ProfileBackground } from "@/lib/profile-backgrounds";
import { cn } from "@/lib/utils";

interface BackgroundPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  uid: string;
  profile: UserProfile | null;
  onSaved: (background: string | null) => void;
  /** set true to also re-publish the public profile snapshot after a change.
   *  Receives the newly chosen background id (or null). */
  publishPublic?: (background: string | null) => Promise<void>;
}

/**
 * Steam-Points-Shop-style gallery of site-provided animated backgrounds.
 * Users pick from the site catalog — uploads are not allowed. The choice is
 * saved to `users/{uid}/profile/background` via the same client RTDB write
 * used for the avatar.
 */
export function BackgroundPickerDialog({
  open,
  onOpenChange,
  uid,
  profile,
  onSaved,
  publishPublic,
}: BackgroundPickerDialogProps) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const current = profile?.background ?? null;

  const apply = async (id: string | null) => {
    if (!uid || busy) return;
    setBusy(id || "none");
    try {
      await saveUserProfile(uid, { background: id });
      onSaved(id);
      if (publishPublic) await publishPublic(id);
      toast({ title: t("profileBackgroundSaved") });
      onOpenChange(false);
    } catch {
      toast({ title: t("error"), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-panel max-w-lg border-border/60">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <Clapperboard className="h-5 w-5 text-primary" />
            {t("profileBackgroundTitle")}
          </DialogTitle>
          <DialogDescription>{t("profileBackgroundHint")}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          {/* None option */}
          <button
            type="button"
            onClick={() => apply(null)}
            disabled={!!busy}
            className={cn(
              "group relative flex h-28 flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border transition-all",
              current === null ? "border-primary bg-primary/10" : "border-border/60 hover:border-primary/40",
            )}
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
              {busy === "none" ? <Loader2 className="h-5 w-5 animate-spin" /> : <Clapperboard className="h-5 w-5" />}
            </span>
            <span className="text-sm font-semibold">{t("profileBackgroundNone")}</span>
            {current === null && (
              <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Check className="h-3.5 w-3.5" />
              </span>
            )}
          </button>

          {PROFILE_BACKGROUNDS.map((bg: ProfileBackground) => (
            <motion.button
              key={bg.id}
              type="button"
              whileHover={{ scale: busy ? 1 : 1.02 }}
              onClick={() => apply(bg.id)}
              disabled={!!busy}
              className={cn(
                "group relative flex h-28 flex-col justify-end overflow-hidden rounded-2xl border transition-all",
                current === bg.id ? "border-primary ring-2 ring-primary/40" : "border-border/60 hover:border-primary/40",
              )}
              style={{ background: bg.tint }}
            >
              <video
                src={bg.src}
                autoPlay
                loop
                muted
                playsInline
                preload="metadata"
                className="absolute inset-0 h-full w-full object-cover"
              />
              <span className="relative z-10 flex items-center justify-between bg-black/45 px-3 py-1.5 text-sm font-semibold text-white backdrop-blur-sm">
                {bg.name}
                {busy === bg.id && <Loader2 className="h-4 w-4 animate-spin" />}
                {current === bg.id && (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Check className="h-3.5 w-3.5" />
                  </span>
                )}
              </span>
            </motion.button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Convenience helper for tests/preview lookups. */
export function backgroundName(id: string | null | undefined): string {
  return getProfileBackground(id)?.name || "";
}
