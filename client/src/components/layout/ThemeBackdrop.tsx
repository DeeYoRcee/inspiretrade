import { useTheme } from "@/lib/theme-context";

/**
 * Steam-style animated theme backdrop: when a theme ships with a looping
 * video (currently Knight → crossed-swords scene), it plays behind the whole
 * app — dimmed and veiled so every text layer stays readable. The CSS scene
 * layers of the theme (castle silhouette, fog) still paint OVER it for depth.
 */
export function ThemeBackdrop() {
  const { theme } = useTheme();
  if (theme !== "knight") return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[-2] overflow-hidden" aria-hidden>
      <video
        src="/videos/sword.mp4"
        autoPlay
        loop
        muted
        playsInline
        preload="metadata"
        className="h-full w-full object-cover"
        style={{ opacity: 0.5 }}
      />
      {/* readability veil — keeps the iron-night mood while text stays crisp */}
      <div
        className="absolute inset-0"
        style={{ background: "linear-gradient(180deg, rgba(11,14,20,0.62), rgba(11,14,20,0.34) 45%, rgba(11,14,20,0.66))" }}
      />
    </div>
  );
}
