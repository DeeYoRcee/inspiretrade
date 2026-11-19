import { useTheme } from "@/lib/theme-context";

/**
 * Steam-style animated theme backdrop: themes that ship with a looping video
 * play it behind the whole app — dimmed and veiled so every text layer stays
 * readable. The CSS scene layers of each theme still paint OVER it for depth.
 *
 * Phase 20: money.mp4 (Money Rain — flipping gold coins + green banknotes)
 * replaced bull.mp4; f1.mp4 re-rendered WITHOUT the bottom finish band.
 */
const THEME_VIDEOS: Record<string, { src: string; opacity: number; veil: string }> = {
  knight: { src: "/videos/sword.mp4", opacity: 0.5, veil: "linear-gradient(180deg, rgba(11,14,20,0.62), rgba(11,14,20,0.34) 45%, rgba(11,14,20,0.66))" },
  money: { src: "/videos/money.mp4", opacity: 0.55, veil: "linear-gradient(180deg, rgba(4,20,13,0.66), rgba(10,50,32,0.34) 45%, rgba(4,20,13,0.68))" },
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
