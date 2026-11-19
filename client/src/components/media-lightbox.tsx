/**
 * Telegram-style full-screen media viewer (Phase 18).
 * Click a profile photo or avatar video → it opens over a blurred dark
 * backdrop, centered, with the name captioned; click anywhere, the ✕ button
 * or Escape closes it. Body scroll is locked while open.
 */
import { useEffect, useCallback } from "react";
import { X } from "lucide-react";

export interface MediaLightboxProps {
  src: string | null;
  /** "video" when the source is a looping avatar/profile video */
  kind?: "image" | "video";
  caption?: string;
  onClose: () => void;
}

export function MediaLightbox({ src, kind = "image", caption, onClose }: MediaLightboxProps) {
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!src) return;
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [src, onKey]);

  if (!src) return null;

  return (
    <div
      className="fixed inset-0 z-[999] flex items-center justify-center bg-black/90 backdrop-blur-xl"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={caption || "Media viewer"}
    >
      <button
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 z-10 rounded-full bg-white/10 p-2.5 text-white/90 transition hover:bg-white/20"
      >
        <X className="h-5 w-5" />
      </button>
      {kind === "video" ? (
        <video
          src={src}
          autoPlay
          loop
          controls
          playsInline
          className="max-h-[86vh] max-w-[92vw] rounded-xl shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <img
          src={src}
          alt={caption || "Profile photo"}
          className="max-h-[86vh] max-w-[92vw] rounded-xl object-contain shadow-2xl"
          onClick={(e) => e.stopPropagation()}
          referrerPolicy="no-referrer"
        />
      )}
      {caption && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-4 py-1.5 text-sm font-medium text-white/90">
          {caption}
        </div>
      )}
    </div>
  );
}
