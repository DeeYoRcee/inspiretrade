import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase";

export const THEMES = ["dark", "light", "ocean", "forest", "vader", "aurora", "neon", "cosmos", "knight", "money", "f1"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_LABELS: Record<Theme, string> = {
  dark: "Dark",
  light: "Light",
  ocean: "Ocean",
  forest: "Forest",
  vader: "Skywalker",
  aurora: "Aurora",
  neon: "Neon Grid",
  cosmos: "Cosmos",
  knight: "Knight",
  money: "Money Rain",
  f1: "Formula 1",
};

function isTheme(value: string | null): value is Theme {
  return value !== null && THEMES.includes(value as Theme);
}

function getSavedTheme(): Theme {
  try {
    const stored = localStorage.getItem("tj-theme");
    // user request: Skywalker is the site's DEFAULT theme — the one a new
    // visitor lands on; a saved personal choice still wins
    return isTheme(stored) ? stored : "vader";
  } catch {
    return "vader";
  }
}

const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void; toggleTheme: () => void }>({
  theme: "vader",
  setTheme: () => {},
  toggleTheme: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(getSavedTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.classList.toggle("light", theme === "light");
    root.classList.toggle("dark", theme !== "light");
    try { localStorage.setItem("tj-theme", theme); } catch { /* Continue without persisted storage. */ }

    const colors: Record<Theme, string> = { dark: "#0a0a0f", light: "#f6f8fa", ocean: "#07131f", forest: "#0b1711", vader: "#050505", aurora: "#04141c", neon: "#0d0618", cosmos: "#05060f", knight: "#0b0e14", money: "#04140d", f1: "#120404" };
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.setAttribute("content", colors[theme]));
  }, [theme]);

  const toggleTheme = () => setTheme((current) => THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]);

  // P55 §13 — theme syncs across devices via RTDB `users/{uid}/prefs/theme`.
  // A local change always wins immediately and is pushed with an updatedAt
  // stamp; the remote value is read ONCE per login and only applied when it is
  // NEWER than the local stamp (a stale device never overwrites a newer choice).
  const setThemeSync = (t: Theme) => {
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
          if (!remote?.theme || !isTheme(remote.theme)) return;
          let localStamp = 0;
          try { localStamp = Number(localStorage.getItem("tj-theme-at") ?? 0); } catch { /* private mode */ }
          if ((remote.updatedAt ?? 0) <= localStamp) return;
          try { localStorage.setItem("tj-theme-at", String(remote.updatedAt ?? Date.now())); } catch { /* private mode */ }
          setTheme(remote.theme);
        }).catch(() => { /* offline → local choice stays */ });
      }).catch(() => { /* firebase unavailable */ });
    });
    return () => unsub();
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme: setThemeSync, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
