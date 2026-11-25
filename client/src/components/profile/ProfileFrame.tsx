/**
 * P75 — profile frame renderer.
 *
 * P76 user request: the frame must NOT hug the avatar photo. It renders as a
 * STANDING OUTER RING — a bigger circle outside the avatar with a visible gap
 * between the avatar and the ring (story-ring style). Built from the shared
 * catalog's CSS values (gradients only — no images, no heavy animation). The
 * gap stays transparent so the profile background shows through. Used by the
 * own-profile page, the public profile poster and the gallery previews so
 * every surface renders the same outer ring.
 */
import { getFrame } from "@shared/frames";
import { cn } from "@/lib/utils";

export function ProfileFrame({
  frame,
  className,
  children,
  /** P77 — "ring" (default): the story-style circle around the avatar.
   *  "card": the frame band wraps a WHOLE CARD (hero card) with the card's
   *  rounded-3xl shape — the user pointed at the hero card edges, the
   *  avatar stays frameless. */
  variant = "ring",
}: {
  /** catalog frame id; null/undefined renders children unchanged */
  frame?: string | null;
  className?: string;
  children: React.ReactNode;
  variant?: "ring" | "card";
}) {
  const def = getFrame(frame);
  if (!def) return <div className={cn(variant === "card" ? "w-full" : "w-fit", className)}>{children}</div>;
  if (variant === "card") {
    // P77 user request — PUBG-Mobile-style frame: a THICK RECTANGULAR band
    // (7px gradient body + a crisp bright inner edge line + a soft outer
    // glow) with the frame NAME as a gold nameplate centered on the bottom
    // band — like PUBG Mobile profile frames
    return (
      <div
        className={cn("relative w-full rounded-lg p-[7px]", className)}
        style={{
          background: def.ring,
          boxShadow: def.glow
            ? `inset 0 0 0 1px ${def.edge}, 0 0 24px ${def.glow}`
            : `inset 0 0 0 1px ${def.edge}`,
        }}
      >
        {/* small rounding squashes the child card's rounded-3xl corners — the
            band reads as one clean PUBG rectangle with no corner notches */}
        <div
          className="overflow-hidden rounded-[5px]"
          style={{ boxShadow: `inset 0 0 0 1.5px ${def.edge}, inset 0 0 0 3px rgba(0,0,0,0.35)` }}
        >
          {children}
        </div>
        {/* gold nameplate on the bottom band, dead-center (PUBG look) */}
        <span
          className="absolute -bottom-[9px] left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border px-3 py-[2px] text-[11px] font-black uppercase tracking-[0.22em]"
          style={{
            color: "#ffd66b",
            borderColor: "rgba(255,214,107,0.55)",
            background: "linear-gradient(180deg, rgba(28,22,8,0.96), rgba(10,8,3,0.96))",
            textShadow: "0 0 8px rgba(255,190,60,0.55)",
            boxShadow: "0 2px 10px rgba(0,0,0,0.55), 0 0 14px rgba(255,190,60,0.25)",
          }}
        >
          {def.name}
        </span>
      </div>
    );
  }
  return (
    // 3px gradient ring band at the OUTER edge + 11px transparent gap — the
    // avatar inside keeps its own size and proportions untouched
    <div
      className={cn("w-fit rounded-full p-[3px]", className)}
      style={{
        background: def.ring,
        boxShadow: def.glow
          ? `inset 0 0 0 1px ${def.edge}, 0 0 14px ${def.glow}`
          : `inset 0 0 0 1px ${def.edge}`,
      }}
    >
      <div className="rounded-full p-[11px]">{children}</div>
    </div>
  );
}

/** Small circular gallery swatch — the ring around a soft token dot. */
export function FrameSwatch({ frame, className }: { frame: string; className?: string }) {
  const def = getFrame(frame);
  if (!def) return null;
  return (
    <span
      className={cn("inline-flex h-10 w-10 items-center justify-center rounded-full p-[3px]", className)}
      style={{ background: def.ring, boxShadow: def.glow ? `0 0 10px ${def.glow}` : undefined }}
    >
      <span className="flex h-full w-full items-center justify-center rounded-full bg-background" style={{ boxShadow: `inset 0 0 0 1px ${def.edge}` }}>
        <span className="h-3 w-3 rounded-full" style={{ background: def.ring }} />
      </span>
    </span>
  );
}
