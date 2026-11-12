/**
 * Steam-style site-provided animated profile backgrounds.
 * Videos are small looping MP4s served from /public/videos — the user picks
 * one from the site gallery (no uploads). The choice is stored in RTDB at
 * `users/{uid}/profile/background` and copied into the public-profile snapshot.
 */

export interface ProfileBackground {
  id: string;
  name: string;
  src: string;
  /** fallback preview gradient while the video loads */
  tint: string;
}

export const PROFILE_BACKGROUNDS: ProfileBackground[] = [
  { id: "aurora", name: "Aurora", src: "/videos/aurora.mp4", tint: "linear-gradient(140deg, #02121b, #0b5e3c 55%, #063e55)" },
  { id: "gold", name: "Gold", src: "/videos/gold.mp4", tint: "linear-gradient(140deg, #0d0703, #7a4a08 55%, #b3730f)" },
  { id: "ocean", name: "Ocean", src: "/videos/ocean.mp4", tint: "linear-gradient(140deg, #020a14, #0a3d66 55%, #0b7f9e)" },
  { id: "nebula", name: "Nebula", src: "/videos/nebula.mp4", tint: "linear-gradient(140deg, #0c0316, #5b1785 55%, #9b2fa8)" },
];

export function getProfileBackground(id: string | null | undefined): ProfileBackground | null {
  if (!id) return null;
  return PROFILE_BACKGROUNDS.find((b) => b.id === id) || null;
}

/**
 * Muted looping <video> for a background. Render inside a relatively
 * positioned container; the caller overlays its own gradient for contrast.
 */
export function BackgroundVideo({
  background,
  className,
  opacity = 0.5,
}: {
  background: ProfileBackground;
  className?: string;
  opacity?: number;
}) {
  return (
    <video
      src={background.src}
      autoPlay
      loop
      muted
      playsInline
      preload="metadata"
      aria-hidden
      className={className}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
        opacity,
        pointerEvents: "none",
      }}
    />
  );
}
