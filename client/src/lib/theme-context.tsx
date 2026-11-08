import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export const THEMES = ["dark", "light", "glass", "ocean", "forest", "sunset"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_LABELS: Record<Theme, string> = {
  dark: "Qorong‘i",
  light: "Yorug‘",
  glass: "Shaffof kulrang",
  ocean: "Okean ko‘ki",
  forest: "O‘rmon yashili",
  sunset: "Binafsha shom",
};

const isTheme = (value: string | null): value is Theme =>
  value !== null && THEMES.includes(value as Theme);

const ThemeContext = createContext<{
  theme: Theme;
  themeLabel: string;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}>({
  theme: "dark",
  themeLabel: THEME_LABELS.dark,
  setTheme: () => {},
  toggleTheme: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const savedTheme = localStorage.getItem("tj-theme");
      return isTheme(savedTheme) ? savedTheme : "dark";
    } catch {
      return "dark";
    }
  });

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.classList.toggle("light", theme === "light");
    root.classList.toggle("dark", theme !== "light");

    try {
      localStorage.setItem("tj-theme", theme);
    } catch {
      // Theme still applies for this session when storage is unavailable.
    }

    const themeColors: Record<Theme, string> = {
      dark: "#0a0a0f",
      light: "#f6f8fa",
      glass: "#222329",
      ocean: "#07131f",
      forest: "#0b1711",
      sunset: "#1a1020",
    };
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
      meta.setAttribute("content", themeColors[theme]);
    });
  }, [theme]);

  const toggleTheme = () => {
    setTheme((current) => THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]);
  };

  return (
    <ThemeContext.Provider value={{ theme, themeLabel: THEME_LABELS[theme], setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
