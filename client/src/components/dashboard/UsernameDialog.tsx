import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { checkUsernameAvailable, saveUserProfile } from "@/hooks/use-premium";
import { get, ref, remove, set, runTransaction } from "firebase/database";
import { db } from "@/lib/firebase";
import { Loader2, AtSign, CheckCircle2, XCircle } from "lucide-react";
import { useLanguage } from "@/lib/language-context";

interface UsernameDialogProps {
  open: boolean;
  currentUsername?: string | null;
  isPremium?: boolean;
  onClose: () => void;
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

export function UsernameDialog({ open, currentUsername, isPremium, onClose }: UsernameDialogProps) {
  const { user } = useAuth();
  const { t } = useLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [value, setValue] = useState(currentUsername || "");
  const [checking, setChecking] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  const validate = (v: string) => USERNAME_RE.test(v);

  const handleCheck = async () => {
    if (!validate(value)) return;
    setChecking(true);
    setAvailable(null);
    try {
      const ok = await checkUsernameAvailable(value);
      setAvailable(ok || value.toLowerCase() === currentUsername?.toLowerCase());
    } catch (e: any) {
      setAvailable(null);
      toast({
        title: t("error"),
        description: e?.message || "Could not check username availability",
        variant: "destructive",
      });
    } finally {
      setChecking(false);
    }
  };

  const handleSave = async () => {
    if (!user || !validate(value)) return;
    setSaving(true);
    const usernameKey = value.toLowerCase();
    const currentUsernameKey = currentUsername?.toLowerCase();
    let claimedNewUsername = false;
    try {
      // Claim atomically so two users cannot save the same username.
      const claim = await runTransaction(ref(db, `usernames/${usernameKey}`), (existing) => {
        if (existing === null || existing === user.uid) return user.uid;
        return;
      });

      if (!claim.committed) {
        setAvailable(false);
        toast({ title: t("usernameTaken"), variant: "destructive" });
        return;
      }
      claimedNewUsername = usernameKey !== currentUsernameKey;
      await saveUserProfile(user.uid, { username: value });

      // Revoke a previously shared public URL after a username change.
      if (currentUsernameKey && currentUsernameKey !== usernameKey) {
        try {
          const oldPublicProfileRef = ref(db, `publicProfiles/${currentUsernameKey}`);
          const oldPublicProfile = await get(oldPublicProfileRef);
          if (oldPublicProfile.exists() && oldPublicProfile.val()?.uid === user.uid) {
            await remove(oldPublicProfileRef);
          }
        } catch (cleanupError) {
          // Username changes must continue to work if public-profile rules are not live yet.
          console.warn("Could not revoke the previous public profile URL.", cleanupError);
        }
      }

      // Release the previous username only after the new one is saved.
      if (currentUsernameKey && currentUsernameKey !== usernameKey) {
        await set(ref(db, `usernames/${currentUsernameKey}`), null);
      }

      setAvailable(true);
      queryClient.invalidateQueries({ queryKey: ["userProfile", user.uid] });
      queryClient.invalidateQueries({ queryKey: ["leaderboard"] });
      toast({ title: `✅ ${t("usernameSaved")}` });
      onClose();
    } catch (e: any) {
      if (claimedNewUsername) {
        await set(ref(db, `usernames/${usernameKey}`), null).catch(() => undefined);
      }
      toast({ title: t("error"), description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const isChanged = value !== currentUsername;
   const canSave = validate(value) && available !== false && !saving;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="glass-panel border-border/60 max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-display">{t("setUsername")}</DialogTitle>
          <DialogDescription>
            {isPremium
              ? t("usernameVisible")
              : t("usernamePremiumOnly")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          <div className="relative">
            <AtSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={value}
              onChange={e => { setValue(e.target.value.replace(/\s/g, "")); setAvailable(null); }}
              placeholder="username"
              className="pl-9 pr-10"
              maxLength={20}
            />
            {value && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                {checking ? (
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                ) : available === true ? (
                  <CheckCircle2 className="w-4 h-4 text-success" />
                ) : available === false ? (
                  <XCircle className="w-4 h-4 text-destructive" />
                ) : null}
              </div>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
             {t("usernameHint")}
          </p>

          {value && !validate(value) && (
           <p className="text-xs text-destructive">{t("invalidFormat")}</p>
          )}
           {available === true && (
             <p className="text-xs text-success">{t("usernameAvailable")}</p>
           )}
           {available === false && (
             <p className="text-xs text-destructive">{t("usernameTaken")}</p>
           )}

          <div className="flex gap-2">
            {isChanged && validate(value) && available === null && (
              <Button variant="outline" size="sm" onClick={handleCheck} disabled={checking} className="flex-1 gap-1">
                {checking && <Loader2 className="w-3 h-3 animate-spin" />}
                 {t("check")}
              </Button>
            )}
            <Button
              onClick={handleSave}
              disabled={!canSave}
              className="flex-1 gap-1"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
               {t("save")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
