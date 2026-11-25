/**
 * P64R user request — the frame gallery now lives INSIDE the Titles section:
 * a self-contained card (preview band + gallery chips + equip/remove) that
 * owns its hooks, so it can mount on any page. The live profile page reads
 * frames/{uid} directly and reflects an equip immediately; the published
 * public-profile snapshot picks the frame up on the next profile save.
 *
 * The CEO card only renders for accounts the SERVER reports as super_admin;
 * the actual equip check happens server-side regardless.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ProfileFrame } from "@/components/profile/ProfileFrame";
import { useAuth } from "@/hooks/use-auth";
import { useEquippedFrame, useFrameRole } from "@/hooks/use-frame";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language-context";
import { authedFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { FRAMES, getFrame } from "@shared/frames";

export function FramesGallery() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const { toast } = useToast();
  const equipped = useEquippedFrame(user?.uid);
  const isSuperAdmin = useFrameRole();
  const [previewFrame, setPreviewFrame] = useState<string | null>(null);
  const [frameBusy, setFrameBusy] = useState(false);

  const equippedFrame = equipped.frame;

  const applyFrame = async (id: string | null) => {
    if (frameBusy) return;
    setFrameBusy(true);
    try {
      if (id) await authedFetch("/api/admin?action=frame-equip", { frame: id });
      else await authedFetch("/api/admin?action=frame-clear", {});
      toast({ title: id ? t("frameEquipped") : t("frameRemoved") });
      setPreviewFrame(null);
    } catch (e: any) {
      toast({ title: t("serverError"), description: String(e?.message || ""), variant: "destructive" });
    } finally {
      setFrameBusy(false);
    }
  };

  return (
    <section className="rounded-3xl border border-border/50 bg-card/60 p-4">
      <div className="flex flex-col items-center gap-2">
        {/* the same rectangular PUBG-style preview band used on the profile card */}
        <div className="w-full max-w-[280px]">
          <ProfileFrame variant="card" frame={previewFrame ?? equippedFrame}>
            <div className="flex h-16 items-center justify-center bg-card/80 text-[10px] font-semibold uppercase tracking-[0.3em] text-muted-foreground">
              Preview
            </div>
          </ProfileFrame>
        </div>
        {(() => {
          const d = getFrame(previewFrame ?? equippedFrame);
          return d ? (
            <p className="max-w-xs text-center text-xs leading-relaxed text-muted-foreground">
              <span className="font-semibold text-foreground">{d.name}</span> — {d.desc}
            </p>
          ) : (
            <p className="text-center text-xs text-muted-foreground">{t("frameNone")}</p>
          );
        })()}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {FRAMES.filter((f) => f.id === "ceo" && (!f.exclusive || isSuperAdmin)).map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setPreviewFrame(f.id)}
            aria-label={f.name}
            className={cn(
              "rounded-full p-0.5 transition-transform hover:scale-105",
              (previewFrame ?? equippedFrame) === f.id && "ring-2 ring-primary ring-offset-2 ring-offset-background",
            )}
          >
            <span
              className="inline-flex h-9 w-24 items-center justify-center text-[11px] font-black uppercase tracking-[0.22em]"
              style={{ background: f.ring, boxShadow: `inset 0 0 0 1px ${f.edge}${f.glow ? `, 0 0 12px ${f.glow}` : ""}`, color: "#ffd66b" }}
            >
              {f.name}
            </span>
          </button>
        ))}
      </div>
      {previewFrame && previewFrame !== equippedFrame && (
        <Button size="sm" className="mt-3 w-full rounded-xl" disabled={frameBusy} onClick={() => applyFrame(previewFrame)}>
          {t("frameEquip")}
        </Button>
      )}
      {equippedFrame && !previewFrame && (
        <Button size="sm" variant="outline" className="mt-3 w-full rounded-xl" disabled={frameBusy} onClick={() => applyFrame(null)}>
          {t("frameRemove")}
        </Button>
      )}
    </section>
  );
}
