import { useEffect, useRef, useState } from "react";
import { MailCheck, RefreshCw, LogOut, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { auth } from "@/lib/firebase";
import { sendEmailVerification } from "firebase/auth";
import { useAuth } from "@/hooks/use-auth";
import { motion } from "framer-motion";

/**
 * Phase 32 — mandatory email verification gate. Every AppLayout page renders
 * this instead of its content while the signed-in user's email is unverified.
 * Google accounts are verified by default, so they never see this screen.
 */
export default function VerifyEmailScreen() {
  const { user, logout } = useAuth();
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [checking, setChecking] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    timer.current = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [cooldown]);

  // auto-check: Firebase only learns about verification after a token refresh,
  // so poll reload() quietly; the app refreshes itself the moment it flips.
  useEffect(() => {
    const id = window.setInterval(async () => {
      try {
        await auth.currentUser?.reload();
        if (auth.currentUser?.emailVerified) window.location.reload();
      } catch { /* transient — keep polling */ }
    }, 5000);
    return () => window.clearInterval(id);
  }, []);

  const resend = async () => {
    setSending(true);
    setHint(null);
    try {
      await auth.currentUser?.reload();
      if (auth.currentUser?.emailVerified) { window.location.reload(); return; }
      if (auth.currentUser) await sendEmailVerification(auth.currentUser);
      setCooldown(60);
      setHint("Confirmation link sent — check your inbox and spam folder.");
    } catch (e: any) {
      const code = String(e?.code || "");
      setHint(code === "auth/too-many-requests" ? "Too many emails — wait a minute before resending." : e?.message || "Could not send the email.");
    } finally {
      setSending(false);
    }
  };

  const checkNow = async () => {
    setChecking(true);
    try {
      await auth.currentUser?.reload();
      if (auth.currentUser?.emailVerified) window.location.reload();
      else setHint("Not verified yet — click the link in your email first, then try again.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="min-h-dvh flex items-center justify-center p-4 bg-background">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-md glass-panel rounded-2xl border border-border/50 shadow-2xl p-8 text-center"
      >
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10">
          <MailCheck className="h-7 w-7 text-primary" />
        </div>
        <h1 className="font-display text-2xl font-semibold">Verify your email</h1>
        <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
          One quick step before the terminal: we sent a confirmation link to
          <span className="block mt-1 font-medium text-foreground break-all">{user?.email}</span>
        </p>
        {hint && <p className="mt-4 rounded-lg border border-border/50 bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">{hint}</p>}
        <div className="mt-6 space-y-2.5">
          <Button onClick={resend} disabled={sending || cooldown > 0} className="w-full h-11 hover-glow font-medium" variant="outline">
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {cooldown > 0 ? `Resend available in ${cooldown}s` : "Resend verification email"}
          </Button>
          <Button onClick={checkNow} disabled={checking} className="w-full h-11 hover-glow font-semibold">
            {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            I've verified — continue
          </Button>
        </div>
        <button
          onClick={() => logout()}
          className="mt-5 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-destructive transition-colors"
        >
          <LogOut className="h-3.5 w-3.5" /> Use a different account
        </button>
      </motion.div>
    </div>
  );
}
