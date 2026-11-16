import { useState } from "react";
import { motion } from "framer-motion";
import { Check, Clapperboard, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/language-context";
import { useToast } from "@/hooks/use-toast";
import { useIsAdmin } from "@/hooks/use-admin";
import { saveUserProfile } from "@/hooks/use-premium";
import { PROFILE_BACKGROUNDS, getProfileBackground } from "@/lib/profile-backgrounds";
import { cn } from "@/lib/utils";
/**
 * Steam-Points-Shop-style gallery of site-provided animated backgrounds.
 * Users pick from the site catalog — uploads are not allowed. The choice is
 * saved to `users/{uid}/profile/background` via the same client RTDB write
 * used for the avatar.
 */
export function BackgroundPickerDialog({ open, onOpenChange, uid, profile, onSaved, publishPublic, }) {
    const { t } = useLanguage();
    const { toast } = useToast();
    const isAdmin = useIsAdmin();
    const [busy, setBusy] = useState(null);
    const [customUrl, setCustomUrl] = useState("");
    const current = profile?.background ?? null;
    const apply = async (id) => {
        if (!uid || busy)
            return;
        setBusy(id || "none");
        try {
            await saveUserProfile(uid, { background: id });
            onSaved(id);
            // re-publishing the public snapshot is BEST-EFFORT: the private choice
            // above is what actually renders on the profile, and the publish path
            // depends on the public-profile rules — never fail the whole pick
            // (the reported "error" toast) because of it.
            if (publishPublic) {
                try {
                    await publishPublic(id);
                }
                catch { /* keep the saved pick */ }
            }
            toast({ title: t("profileBackgroundSaved") });
            onOpenChange(false);
        }
        catch {
            toast({ title: t("error"), variant: "destructive" });
        }
        finally {
            setBusy(null);
        }
    };
    return (<Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-panel max-w-lg border-border/60">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <Clapperboard className="h-5 w-5 text-primary"/>
            {t("profileBackgroundTitle")}
          </DialogTitle>
          <DialogDescription>{t("profileBackgroundHint")}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          {/* None option */}
          <button type="button" onClick={() => apply(null)} disabled={!!busy} className={cn("group relative flex h-28 flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border transition-all", current === null ? "border-primary bg-primary/10" : "border-border/60 hover:border-primary/40")}>
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
              {busy === "none" ? <Loader2 className="h-5 w-5 animate-spin"/> : <Clapperboard className="h-5 w-5"/>}
            </span>
            <span className="text-sm font-semibold">{t("profileBackgroundNone")}</span>
            {current === null && (<span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Check className="h-3.5 w-3.5"/>
              </span>)}
          </button>

          {PROFILE_BACKGROUNDS.map((bg) => (<motion.button key={bg.id} type="button" whileHover={{ scale: busy ? 1 : 1.02 }} onClick={() => apply(bg.id)} disabled={!!busy} className={cn("group relative flex h-28 flex-col justify-end overflow-hidden rounded-2xl border transition-all", current === bg.id ? "border-primary ring-2 ring-primary/40" : "border-border/60 hover:border-primary/40")} style={{ background: bg.tint }}>
              <video src={bg.src} autoPlay loop muted playsInline preload="metadata" className="absolute inset-0 h-full w-full object-cover"/>
              <span className="relative z-10 flex items-center justify-between bg-black/45 px-3 py-1.5 text-sm font-semibold text-white backdrop-blur-sm">
                {bg.name}
                {busy === bg.id && <Loader2 className="h-4 w-4 animate-spin"/>}
                {current === bg.id && (<span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Check className="h-3.5 w-3.5"/>
                  </span>)}
              </span>
            </motion.button>))}
        </div>

        {/* owner-only: ANY image/video URL as profile background */}
        {isAdmin && (<div className="mt-4 space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="text-xs font-bold uppercase tracking-widest text-amber-400">Owner — custom background</div>
            <p className="text-[11px] text-muted-foreground">Paste any image or video URL — it becomes your profile background.</p>
            <div className="flex gap-2">
              <input value={customUrl} onChange={(e) => setCustomUrl(e.target.value)} placeholder="https://… (.mp4 / .png / .gif)" className="num-input h-8 flex-1 text-[11px]"/>
              <Button size="sm" className="bg-amber-500 font-semibold text-black hover:bg-amber-400" disabled={!/^https?:\/\//i.test(customUrl.trim()) || !!busy} onClick={() => apply(customUrl.trim())}>
                {busy === customUrl.trim() ? <Loader2 className="h-4 w-4 animate-spin"/> : "Apply"}
              </Button>
            </div>
            {current && current.startsWith("http") && (<p className="text-[10px] text-emerald-400">Current custom URL is active.</p>)}
          </div>)}
      </DialogContent>
    </Dialog>);
}
/** Convenience helper for tests/preview lookups. */
export function backgroundName(id) {
    return getProfileBackground(id)?.name || "";
}
