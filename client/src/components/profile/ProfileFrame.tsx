/**
 * P75 — profile frame renderer.
 *
 * A frame is a subtle double-bezel ring around the circular avatar, built
 * from the shared catalog's CSS values (gradients only — no images, no heavy
 * animation). The inner bg-background layer keeps the avatar's own size and
 * proportions untouched. Used by the own-profile page, the public profile
 * poster and the gallery previews so every surface renders the same ring.
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
  if (!def) return <>{children}</>;
  return (
    <div
      className={cn("rounded-full p-[3px]", className)}
      style={{ background: def.ring, boxShadow: def.glow ? `0 0 12px ${def.glow}` : undefined }}
    >
      <div className="rounded-full bg-background p-[2px]" style={{ boxShadow: `inset 0 0 0 1px ${def.edge}` }}>
        {children}
      </div>
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
