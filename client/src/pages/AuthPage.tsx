import { useEffect, useState } from "react";
import {
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signInWithPopup, signInWithRedirect, sendPasswordResetEmail, sendEmailVerification,
} from "firebase/auth";
import { auth, googleProvider } from "@/lib/firebase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Lock, Mail, Eye, EyeOff, LineChart, BookOpen, Briefcase, Newspaper, CalendarDays, Gift, TerminalSquare, ArrowRight } from "lucide-react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";

/**
 * Phase 32 — premium entry redesign. Visual shell only: every auth handler
 * (email sign-in/sign-up, Google, validation, toasts) is the original flow.
 * Sign-up now also fires the mandatory email verification (item 5).
 */

type Mode = "signin" | "signup" | "forgot";

const ECOSYSTEM = [
  { icon: TerminalSquare, label: "Trading Terminal" },
  { icon: BookOpen, label: "Trade Journal" },
  { icon: Briefcase, label: "Prop Firm Tools" },
  { icon: Newspaper, label: "Market News" },
  { icon: CalendarDays, label: "Economic Calendar" },
  { icon: Gift, label: "Rewards & Marketplace" },
];

/** Official four-color Google G — inline SVG, no extra dependency. */
function GoogleG() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
      <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.57 5.57 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.27 14.29A7.2 7.2 0 0 1 4.89 12c0-.8.14-1.57.38-2.29V6.62H1.29a11.99 11.99 0 0 0 0 10.76l3.98-3.09z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.69 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z" />
    </svg>
  );
}

const SYMBOLS = [
  { name: "XAUUSD", price: "4,391.20", delta: "+0.84%", up: true, top: "12%", left: "8%", dur: 7 },
  { name: "EURUSD", price: "1.0842", delta: "-0.12%", up: false, top: "30%", left: "58%", dur: 8.5 },
  { name: "BTCUSD", price: "96,410", delta: "+2.31%", up: true, top: "70%", left: "55%", dur: 9.5 },
];

/** Floating candlestick cluster — lightweight SVG + transform animations. */
function CandleScene({ reduced }: { reduced: boolean }) {
  const candles = [
    { x: 10, o: 46, c: 30, wick: [22, 54], up: true },
    { x: 34, o: 34, c: 42, wick: [28, 50], up: false },
    { x: 58, o: 40, c: 22, wick: [16, 48], up: true },
    { x: 82, o: 26, c: 38, wick: [20, 46], up: false },
    { x: 106, o: 36, c: 16, wick: [10, 42], up: true },
    { x: 130, o: 20, c: 32, wick: [14, 40], up: false },
  ];
  return (
    <svg viewBox="0 0 150 70" className="w-full max-w-md h-auto" aria-hidden>
      <defs>
        <linearGradient id="hero-line" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="hsl(142 71% 45%)" stopOpacity="0.1" />
          <stop offset="100%" stopColor="hsl(142 71% 45%)" stopOpacity="0.9" />
        </linearGradient>
      </defs>
      {/* subtle animated price path behind the candles */}
      <path
        d="M0,58 L18,50 L36,54 L54,38 L72,44 L90,28 L108,33 L126,18 L150,22"
        fill="none" stroke="url(#hero-line)" strokeWidth="1.6" strokeLinecap="round"
        strokeDasharray="240" className="hero-dash" opacity={reduced ? 0.5 : 0.9}
      />
      {candles.map((cd, i) => (
        <motion.g
          key={i}
          animate={reduced ? undefined : { y: [0, i % 2 ? 5 : -5, 0] }}
          transition={{ duration: 5 + i * 0.7, repeat: Infinity, ease: "easeInOut", delay: i * 0.35 }}
        >
          <line x1={cd.x + 7} y1={cd.wick[0]} x2={cd.x + 7} y2={cd.wick[1]} stroke={cd.up ? "hsl(142 71% 45%)" : "hsl(348 83% 55%)"} strokeWidth="1.4" opacity="0.85" />
          <rect x={cd.x} y={Math.min(cd.o, cd.c)} width="14" height={Math.abs(cd.o - cd.c) + 3} rx="2"
            fill={cd.up ? "hsl(142 71% 45% / 0.28)" : "hsl(348 83% 55% / 0.28)"}
            stroke={cd.up ? "hsl(142 71% 45%)" : "hsl(348 83% 55%)"} strokeWidth="1.2" />
        </motion.g>
      ))}
    </svg>
  );
}

/** Glowing data particles (few, cheap). */
function Particles({ reduced }: { reduced: boolean }) {
  const dots = Array.from({ length: 9 }, (_, i) => ({
    left: `${6 + (i * 11) % 88}%`, top: `${12 + (i * 27) % 74}%`,
    dur: 6 + (i % 4) * 2, delay: i * 0.6, size: i % 3 === 0 ? 5 : 3,
  }));
  return (
    <div className="absolute inset-0 pointer-events-none" aria-hidden>
      {dots.map((d, i) => (
        <motion.span
          key={i}
          className="absolute rounded-full bg-primary/40 blur-[1px]"
          style={{ left: d.left, top: d.top, width: d.size, height: d.size }}
          animate={reduced ? undefined : { y: [0, -14, 0], opacity: [0.25, 0.7, 0.25] }}
          transition={{ duration: d.dur, repeat: Infinity, ease: "easeInOut", delay: d.delay }}
        />
      ))}
    </div>
  );
}

export default function AuthPage() {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const { toast } = useToast();
  const reduced = useReducedMotion() ?? false;

  // light parallax on the hero visual (pointer-only devices, motion allowed)
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const onHeroMove = (e: React.MouseEvent) => {
    if (reduced) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setTilt({ x: ((e.clientX - r.left) / r.width - 0.5) * 10, y: ((e.clientY - r.top) / r.height - 0.5) * -10 });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "forgot") {
        await sendPasswordResetEmail(auth, email);
        setResetSent(true);
        toast({ title: "Reset email sent", description: "Check your inbox for the password reset link." });
      } else if (mode === "signin") {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        // Phase 32: mandatory email verification — the app stays gated
        // (AppLayout → VerifyEmailScreen) until the address is confirmed.
        await sendEmailVerification(cred.user);
        toast({ title: "Verify your email", description: "We sent a confirmation link to your inbox." });
      }
    } catch (error: any) {
      const code = String(error?.code || "");
      const friendly =
        code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found"
          ? "Incorrect email or password."
          : code === "auth/email-already-in-use"
            ? "An account with this email already exists — sign in instead."
            : code === "auth/weak-password"
              ? "Password must be at least 6 characters."
              : code === "auth/too-many-requests"
                ? "Too many attempts — please wait a moment and try again."
                : error?.message || "An error occurred during authentication";
      toast({ title: "Authentication Failed", description: friendly, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error: any) {
      if (error?.code === "auth/popup-blocked") {
        await signInWithRedirect(auth, googleProvider);
        return;
      }
      if (error?.code === "auth/popup-closed-by-user") return;
      toast({
        title: "Google Sign-In Failed",
        description: error.message || "Could not sign in with Google",
        variant: "destructive",
      });
    } finally {
      setGoogleLoading(false);
    }
  };

  const heroHeadline = (
    <>
      <h1 className="font-display text-4xl lg:text-5xl xl:text-6xl font-semibold leading-[1.08] tracking-tight text-foreground">
        Everything About Trading.
        <span className="block text-muted-foreground">All in One Place.</span>
      </h1>
      <p className="mt-5 max-w-lg text-base lg:text-lg text-muted-foreground leading-relaxed">
        Analyze the markets. Track your performance. Master your risk. Build your trading journey with InspireTrade.
      </p>
    </>
  );

  const ecosystemGrid = (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 max-w-2xl">
      {ECOSYSTEM.map(({ icon: Icon, label }, i) => (
        <motion.div
          key={label}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 + i * 0.06, duration: 0.4 }}
          className="group flex items-center gap-2.5 rounded-xl border border-border/50 bg-card/40 backdrop-blur-md px-3.5 py-2.5 transition-all duration-300 hover:border-primary/40 hover:bg-card/70 hover:-translate-y-0.5"
        >
          <Icon className="h-4 w-4 shrink-0 text-primary/80 transition-colors group-hover:text-primary" />
          <span className="text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground whitespace-nowrap">{label}</span>
        </motion.div>
      ))}
    </div>
  );

  return (
    <div className="min-h-dvh w-full bg-background text-foreground grid lg:grid-cols-[1.15fr_1fr]">
      {/* ================= HERO — trading universe (desktop left) ============ */}
      <div
        className="relative hidden lg:flex flex-col justify-center overflow-hidden border-r border-border/40 px-10 xl:px-16 py-12"
        onMouseMove={onHeroMove}
        style={{
          background:
            "radial-gradient(1100px 500px at 20% 10%, hsl(210 40% 98% / 0.05), transparent 60%), radial-gradient(900px 600px at 85% 85%, hsl(142 71% 45% / 0.06), transparent 55%), linear-gradient(160deg, hsl(240 10% 5%) 0%, hsl(240 10% 3%) 100%)",
        }}
      >
        <Particles reduced={reduced} />
        {/* floating symbol chips */}
        {!reduced && SYMBOLS.map((s) => (
          <motion.div
            key={s.name}
            className="absolute z-10 flex items-center gap-2.5 rounded-xl border border-border/60 bg-card/60 backdrop-blur-md px-3 py-2 shadow-lg shadow-black/30"
            style={{ top: s.top, left: s.left }}
            animate={{ y: [0, -10, 0] }}
            transition={{ duration: s.dur, repeat: Infinity, ease: "easeInOut" }}
          >
            <span className="text-[11px] font-semibold tracking-wide text-foreground">{s.name}</span>
            <span className="font-number text-[11px] text-muted-foreground">{s.price}</span>
            <span className={`text-[11px] font-medium ${s.up ? "text-success" : "text-destructive"}`}>{s.delta}</span>
          </motion.div>
        ))}

        <motion.div
          style={reduced ? undefined : { transform: `perspective(900px) rotateX(${tilt.y}deg) rotateY(${tilt.x}deg)` }}
          className="relative z-10 transition-transform duration-200 ease-out will-change-transform"
        >
          <div className="mb-10 flex items-center gap-3">
            <img src="/logo.png" alt="InspireTrade" draggable={false} onDragStart={(e) => e.preventDefault()} onContextMenu={(e) => e.preventDefault()} className="select-none h-10 w-auto object-contain" />
          </div>
          {heroHeadline}
          <div className="mt-10 max-w-xl">
            <CandleScene reduced={reduced} />
          </div>
          <div className="mt-10">{ecosystemGrid}</div>
          <p className="mt-8 text-xs text-muted-foreground/60 max-w-md">
            Real spot data · Professional charts · Prop-account rewards — one serious platform.
          </p>
        </motion.div>
      </div>

      {/* ================= AUTH PANEL (right) ================================ */}
      <div className="relative flex items-center justify-center p-4 sm:p-8 min-h-dvh lg:min-h-0"
        style={{ background: "radial-gradient(700px 420px at 50% 0%, hsl(210 40% 98% / 0.04), transparent 65%)" }}
      >
        <Particles reduced={reduced} />
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="w-full max-w-md relative z-10"
        >
          {/* mobile compact branding */}
          <div className="flex flex-col items-center mb-6 lg:hidden">
            <img src="/logo.png" alt="InspireTrade" draggable={false} onDragStart={(e) => e.preventDefault()} onContextMenu={(e) => e.preventDefault()} className="select-none h-12 w-auto object-contain mb-3" />
            <h1 className="font-display text-xl font-semibold text-center leading-snug">Everything About Trading.<br /><span className="text-muted-foreground">All in One Place.</span></h1>
          </div>

          <div className="glass-panel rounded-2xl border border-border/50 shadow-2xl overflow-hidden">
            <div className="p-6 sm:p-8">
              <div className="hidden lg:flex items-center gap-2.5 mb-6">
                <img src="/logo.png" alt="InspireTrade" draggable={false} className="select-none h-8 w-auto object-contain" />
              </div>

              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={mode}
                  initial={{ opacity: 0, x: 14 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -14 }}
                  transition={{ duration: 0.22, ease: "easeOut" }}
                >
                  <h2 className="font-display text-2xl font-semibold tracking-tight">
                    {mode === "signin" ? "Welcome Back" : mode === "signup" ? "Create Your Account" : "Reset Password"}
                  </h2>
                  <p className="mt-1.5 text-sm text-muted-foreground">
                    {mode === "signin"
                      ? "Sign in to continue your trading journey."
                      : mode === "signup"
                        ? "Start tracking your performance — it takes a minute."
                        : "Enter your email and we'll send you a reset link."}
                  </p>
                </motion.div>
              </AnimatePresence>

              {resetSent && (
                <div className="mt-4 rounded-lg border border-success/40 bg-success/10 px-3.5 py-2.5 text-sm text-success">
                  Reset link sent — check your inbox (and spam folder).
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4 mt-6">
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="email"
                      type="email"
                      name="email"
                      autoComplete="email"
                      placeholder="trader@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="pl-9 bg-background/50 border-border/50 focus:border-primary transition-colors h-10"
                      required
                    />
                  </div>
                </div>

                {mode !== "forgot" && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="password">Password</Label>
                      {mode === "signin" && (
                        <button
                          type="button"
                          onClick={() => { setMode("forgot"); setResetSent(false); }}
                          className="text-xs text-muted-foreground hover:text-primary transition-colors"
                        >
                          Forgot password?
                        </button>
                      )}
                    </div>
                    <div className="relative">
                      <Lock className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="password"
                        type={showPassword ? "text" : "password"}
                        name="password"
                        autoComplete={mode === "signin" ? "current-password" : "new-password"}
                        placeholder="••••••••"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="pl-9 pr-10 bg-background/50 border-border/50 focus:border-primary transition-colors h-10"
                        minLength={6}
                        required
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-label={showPassword ? "Hide password" : "Show password"}
                        className="absolute right-2.5 top-2 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                )}

                <Button type="submit" className="w-full h-11 hover-glow font-semibold" disabled={loading}>
                  {loading ? (
                    <span className="flex items-center gap-2">
                      <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      Please wait…
                    </span>
                  ) : mode === "signin" ? (
                    <span className="flex items-center gap-2">Sign In <ArrowRight className="h-4 w-4" /></span>
                  ) : mode === "signup" ? (
                    "Create Account"
                  ) : (
                    "Send Reset Link"
                  )}
                </Button>
              </form>

              {mode === "forgot" ? (
                <div className="text-center text-sm mt-5">
                  <button type="button" onClick={() => setMode("signin")} className="text-primary hover:underline font-medium">
                    Back to sign in
                  </button>
                </div>
              ) : (
                <>
                  {/* Google */}
                  <div className="relative mt-6">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t border-border/40" />
                    </div>
                    <div className="relative flex justify-center text-xs">
                      <span className="px-3 bg-card text-muted-foreground">or</span>
                    </div>
                  </div>
                  {/* Phase 32b: premium trading-grade Google button */}
                  <button
                    type="button"
                    onClick={handleGoogleSignIn}
                    disabled={googleLoading}
                    className="group relative mt-4 flex h-12 w-full items-center justify-center gap-3 overflow-hidden rounded-xl border border-white/10 bg-gradient-to-b from-white/[0.06] to-white/[0.02] font-medium text-foreground transition-all duration-300 hover:border-primary/40 hover:from-white/[0.1] hover:shadow-[0_0_28px_-8px_hsl(var(--primary)/0.45)] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-60"
                  >
                    <span className="absolute inset-x-10 -top-px h-px bg-gradient-to-r from-transparent via-white/25 to-transparent transition-all duration-300 group-hover:via-primary/60" aria-hidden />
                    {googleLoading ? (
                      <span className="h-5 w-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white shadow-sm transition-transform duration-300 group-hover:scale-105">
                        <GoogleG />
                      </span>
                    )}
                    <span>{googleLoading ? "Signing in…" : "Continue with Google"}</span>
                    <ArrowRight className="h-4 w-4 -translate-x-1 text-muted-foreground opacity-0 transition-all duration-300 group-hover:translate-x-0 group-hover:opacity-100" aria-hidden />
                  </button>

                  <div className="text-center text-sm mt-6">
                    <span className="text-muted-foreground">
                      {mode === "signin" ? "New to InspireTrade? " : "Already have an account? "}
                    </span>
                    <button
                      type="button"
                      onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
                      className="text-primary hover:underline font-medium focus:outline-none"
                    >
                      {mode === "signin" ? "Create an account" : "Sign in"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          <p className="mt-5 text-center text-[11px] text-muted-foreground/70">
            By continuing you agree to the InspireTrade terms and fair-use policy.
          </p>
        </motion.div>
      </div>
    </div>
  );
}
