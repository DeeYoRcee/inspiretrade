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
  /** P66 — optional animated overlay class (storm / petals) for image picks */
  fx?: string;
}

export const PROFILE_BACKGROUNDS: ProfileBackground[] = [
  { id: "gold", name: "Gold", src: "/videos/gold.mp4", tint: "linear-gradient(140deg, #0d0703, #7a4a08 55%, #b3730f)" },
  // "ocean" removed per user request (P66) — profiles still carrying the id
  // fall through getProfileBackground() to the plain look
  // P66 user request: image picks with animated overlays
  { id: "skywalker", name: "Skywalker", src: "/backgrounds/skywalker.jpg", tint: "linear-gradient(140deg, #050507, #17171d 55%, #0a0a0c)", fx: "bg-fx-storm" },
  { id: "knight", name: "Knight", src: "/backgrounds/knight.jpg", tint: "linear-gradient(140deg, #120a06, #3a2313 55%, #6b3d1a)", fx: "bg-fx-petals" },
  { id: "nebula", name: "Nebula", src: "/videos/nebula.mp4", tint: "linear-gradient(140deg, #0c0316, #5b1785 55%, #9b2fa8)" },
  { id: "storm", name: "Storm", src: "/videos/storm.mp4", tint: "linear-gradient(140deg, #0a0a10, #262838 55%, #1c2a52)" },
  { id: "embers", name: "Embers", src: "/videos/embers.mp4", tint: "linear-gradient(140deg, #0c0503, #301006 55%, #7a3008)" },
  // "frost" removed per user request — profiles already carrying the id fall
  // through getProfileBackground() to the plain (no-video) look
  // Phase 29-UI request: a Formula-1 pick for the gallery (the sword pick was
  // removed per user request — anyone still storing it falls back to none)
  { id: "f1", name: "Formula 1", src: "/videos/f1.mp4", tint: "linear-gradient(140deg, #120404, #7a1414 55%, #b3270f)" },
];

export function getProfileBackground(id: string | null | undefined): ProfileBackground | null {
  if (!id) return null;
  const hit = PROFILE_BACKGROUNDS.find((b) => b.id === id);
  if (hit) return hit;
  // owner UPLOAD: `media:{hash}` streams from the content-addressed store —
  // public (no auth) so signed-out visitors on /@username see it too
  const mediaMatch = /^media:([a-f0-9]{8,64})$/i.exec(id);
  if (mediaMatch) {
    return {
      id,
      name: "Upload",
      src: `/api/admin?action=media-get&id=${mediaMatch[1]}`,
      tint: "linear-gradient(140deg, #0b0d12, #23262e 60%, #14161c)",
    };
  }
  // owner custom background: a direct image/video URL stored instead of a catalog id
  if (/^https?:\/\//i.test(id)) {
    return { id, name: "Custom", src: id, tint: "linear-gradient(140deg, #0b0d12, #23262e 60%, #14161c)" };
  }
  return null;
}

function isImageUrl(src: string): boolean {
  return /\.(png|jpe?g|webp|gif|avif|svg)(\?|#|$)/i.test(src);
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
  // custom backgrounds may be a plain IMAGE url — render that without looping
  if (isImageUrl(background.src)) {
    return (
      <>
        <img
          src={background.src}
          alt=""
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
        {background.fx && <div aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden ${background.fx}`} />}
      </>
    );
  }
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
