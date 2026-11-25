import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useToast } from "@/hooks/use-toast";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase";

export const THEMES = ["dark", "light", "ocean", "forest", "vader", "cr7", "knight", "neon", "cosmos", "money", "f1", "snow"] as const;
export type Theme = (typeof THEMES)[number];

/** P64R user request — six themes became part of Premium: Formula 1, Money
 *  Rain, Cosmos, Neon Grid, Knight and CR7. Free users keep Dark, Light,
 *  Ocean, Forest, Skywalker (vader) and Snow. */
export const VIP_THEMES: readonly Theme[] = ["cr7", "knight", "neon", "cosmos", "money", "f1"] as const;
export const isVipTheme = (t: Theme): boolean => VIP_THEMES.includes(t);

/** P77 — the Christmas theme was replaced by Snow: old saved keys (localStorage
 *  and the RTDB prefs sync) migrate silently to "snow". */
export function normalizeTheme(value: string | null): Theme | null {
  if (value === "christmas") return "snow";
  return isTheme(value) ? value : null;
}

export const THEME_LABELS: Record<Theme, string> = {
  dark: "Dark",
  light: "Light",
  ocean: "Ocean",
  forest: "Forest",
  vader: "Skywalker",
  cr7: "CR7",
  knight: "Knight",
  neon: "Neon Grid",
  cosmos: "Cosmos",
  money: "Money Rain",
  f1: "Formula 1",
  snow: "Snow",
};

function isTheme(value: string | null): value is Theme {
  return value !== null && THEMES.includes(value as Theme);
}

function getSavedTheme(): Theme {
  try {
    // P77 — legacy "christmas" saved keys migrate to "snow"
    return normalizeTheme(localStorage.getItem("tj-theme")) ?? "vader";
  } catch {
    return "vader";
  }
}

const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void; toggleTheme: () => void; isVip: boolean }>({
  theme: "vader",
  setTheme: () => {},
  toggleTheme: () => {},
  isVip: false,
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(getSavedTheme);
  // P64R — Premium themes are gated on this flag (RTDB users/{uid}):
  // isPremium/premiumPlan/ceo unlock the VIP theme set.
  const [isVip, setIsVip] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.classList.toggle("light", theme === "light");
    root.classList.toggle("dark", theme !== "light");
    try { localStorage.setItem("tj-theme", theme); } catch { /* Continue without persisted storage. */ }

    const colors: Record<Theme, string> = { dark: "#0a0a0f", light: "#f6f8fa", ocean: "#07131f", forest: "#0b1711", vader: "#050505", cr7: "#0a0908", knight: "#07080c", neon: "#0d0618", cosmos: "#05060f", money: "#04140d", f1: "#120404", snow: "#070d16" };
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.setAttribute("content", colors[theme]));
  }, [theme]);

  const toggleTheme = () => setTheme((current) => THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]);

  // P55 §13 — theme syncs across devices via RTDB `users/{uid}/prefs/theme`.
  // A local change always wins immediately and is pushed with an updatedAt
  // stamp; the remote value is read ONCE per login and only applied when it is
  // NEWER than the local stamp (a stale device never overwrites a newer choice).
  const setThemeSync = (t: Theme) => {
    // backstop: a locked VIP theme can never be applied without Premium —
    // the pickers show a lock and route users to the Premium page instead
    if (isVipTheme(t) && !isVip) return;
    setTheme(t);
    try { localStorage.setItem("tj-theme-at", String(Date.now())); } catch { /* private mode */ }
  };

  useEffect(() => {
    const u = auth.currentUser;
    if (!u) return;
    void import("firebase/database").then(({ getDatabase, ref, set }) => {
      void set(ref(getDatabase(), `users/${u.uid}/prefs/theme`), { theme, updatedAt: Date.now() }).catch(() => { /* offline → LS only */ });
    }).catch(() => { /* firebase unavailable */ });
  }, [theme]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      if (!u) return;
      void import("firebase/database").then(({ getDatabase, ref, get }) => {
        void get(ref(getDatabase(), `users/${u.uid}/prefs/theme`)).then((snap) => {
          if (!snap.exists()) return;
          const remote = snap.val() as { theme?: string; updatedAt?: number };
          const migrated = normalizeTheme(remote?.theme ?? null);
          if (!migrated) return;
          let localStamp = 0;
          try { localStamp = Number(localStorage.getItem("tj-theme-at") ?? 0); } catch { /* private mode */ }
          if ((remote.updatedAt ?? 0) <= localStamp) return;
          try { localStorage.setItem("tj-theme-at", String(remote.updatedAt ?? Date.now())); } catch { /* private mode */ }
          setTheme(migrated);
        }).catch(() => { /* offline → local choice stays */ });
      }).catch(() => { /* firebase unavailable */ });
    });
    return () => unsub();
  }, []);

  // P64R — Premium status for theme gating (single read per auth change;
  // cheap, and premium upgrades propagate on the next page load / re-login).
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      if (!u) { setIsVip(false); return; }
      void import("firebase/database").then(({ getDatabase, ref, get }) => {
        // FIX (P64R2 user report): the premium flags live on the PROFILE node,
        // users/{uid}/profile — reading users/{uid} returned null fields, so
        // actual VIP members were being treated as free (locked themes).
        void get(ref(getDatabase(), `users/${u.uid}/profile`)).then((snap) => {
          const v = (snap.val() ?? {}) as { isPremium?: boolean; premiumPlan?: string | null; ceo?: boolean };
          setIsVip(v.isPremium === true || (typeof v.premiumPlan === "string" && v.premiumPlan.length > 0) || v.ceo === true);
        }).catch(() => { /* offline → keep last known state */ });
      }).catch(() => { /* firebase unavailable */ });
    });
    return () => unsub();
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme: setThemeSync, toggleTheme, isVip }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);

/** P64R — shared behavior for locked Premium themes on every theme picker:
 *  show a lock, and a click explains the paywall instead of switching. */
export function useThemeChipGuard() {
  const { isVip } = useTheme();
  const { toast } = useToast();
  return (th: Theme): boolean => {
    if (isVipTheme(th) && !isVip) {
      toast({ title: "Premium theme", description: `${THEME_LABELS[th]} is part of Premium — unlock it on the Premium page.`, duration: 4200 });
      return false;
    }
    return true;
  };
}
