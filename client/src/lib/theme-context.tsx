import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export const THEMES = ["dark", "light", "glass", "ocean", "forest", "sunset"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_LABELS: Record<Theme, string> = {
  dark: "Dark",
  light: "Light",
  glass: "Glass",
  ocean: "Ocean",
  forest: "Forest",
  sunset: "Sunset",
};

function isTheme(value: string | null): value is Theme {
  return value !== null && THEMES.includes(value as Theme);
}

function getSavedTheme(): Theme {
  try {
    const stored = localStorage.getItem("tj-theme");
    return isTheme(stored) ? stored : "dark";
  } catch {
    return "dark";
  }
}

const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void; toggleTheme: () => void }>({
  theme: "dark",
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

    const colors: Record<Theme, string> = { dark: "#0a0a0f", light: "#f6f8fa", glass: "#252630", ocean: "#07131f", forest: "#0b1711", sunset: "#1a1020" };
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.setAttribute("content", colors[theme]));
  }, [theme]);

  const toggleTheme = () => setTheme((current) => THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]);
  return <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
