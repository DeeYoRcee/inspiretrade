import { useTheme } from "@/lib/theme-context";

/**
 * Steam-style animated theme backdrop: themes that ship with a looping video
 * play it behind the whole app — dimmed and veiled so every text layer stays
 * readable. The CSS scene layers of each theme still paint OVER it for depth.
 *
 * Phase 19: bull.mp4 (Bull Market — animated candlestick chart) and f1.mp4
 * (Formula 1 — speed streaks + checkered band) join knight's sword scene.
 */
const THEME_VIDEOS: Record<string, { src: string; opacity: number; veil: string }> = {
  knight: { src: "/videos/sword.mp4", opacity: 0.5, veil: "linear-gradient(180deg, rgba(11,14,20,0.62), rgba(11,14,20,0.34) 45%, rgba(11,14,20,0.66))" },
  bull: { src: "/videos/bull.mp4", opacity: 0.55, veil: "linear-gradient(180deg, rgba(14,3,5,0.66), rgba(40,6,10,0.34) 45%, rgba(14,3,5,0.68))" },
  f1: { src: "/videos/f1.mp4", opacity: 0.55, veil: "linear-gradient(180deg, rgba(18,4,4,0.62), rgba(60,8,8,0.30) 45%, rgba(18,4,4,0.66))" },
};

export function ThemeBackdrop() {
  const { theme } = useTheme();
  const conf = THEME_VIDEOS[theme];
  if (!conf) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[-2] overflow-hidden" aria-hidden>
      <video
        src={conf.src}
        autoPlay
        loop
        muted
        playsInline
        preload="metadata"
        className="h-full w-full object-cover"
        style={{ opacity: conf.opacity }}
      />
      {/* readability veil — keeps the theme mood while text stays crisp */}
      <div className="absolute inset-0" style={{ background: conf.veil }} />
    </div>
  );
}
