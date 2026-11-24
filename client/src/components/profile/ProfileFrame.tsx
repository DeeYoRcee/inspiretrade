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
}: {
  /** catalog frame id; null/undefined renders children unchanged */
  frame?: string | null;
  className?: string;
  children: React.ReactNode;
}) {
  const def = getFrame(frame);
  if (!def) return <div className={cn("w-fit", className)}>{children}</div>;
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
