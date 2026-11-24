/**
 * P75 — profile frame catalog (PURE, no Firebase imports so the test runner
 * and BOTH the api bundles and the client share one source of truth).
 *
 * A frame is a cosmetic avatar ring rendered by the client ProfileFrame
 * component. The catalog carries the visual design as CSS values so every
 * surface (own profile, public profile, gallery preview) renders the exact
 * same ring.
 *
 * Security note: ownership/equipping is NOT stored here — the server keeps
 * frames/<uid> (API-written only) and the "ceo" frame additionally requires
 * a super_admin role server-side. This file is only the visual catalog.
 */

export interface FrameDef {
  id: string;
  name: string;
  desc: string;
  /** CSS background for the ring layer (gradients only — no images). */
  ring: string;
  /** inner hairline color between ring and avatar */
  edge: string;
  /** subtle outer shadow color; "" = none (no glow by design) */
  glow: string;
  /** exclusive frames cannot be equipped by normal users (server-enforced) */
  exclusive?: boolean;
}

const FRAMES_LIST: FrameDef[] = [
  {
    id: "classic",
    name: "Classic",
    desc: "Clean graphite ring — quiet and professional.",
    ring: "linear-gradient(135deg, #6b7482 0%, #313945 55%, #4c5563 100%)",
    edge: "#1b2029",
    glow: "",
  },
  {
    id: "premium",
    name: "Premium",
    desc: "Violet-to-magenta gradient for Premium members' profiles.",
    ring: "linear-gradient(135deg, #a78bfa 0%, #7c3aed 45%, #e879f9 100%)",
    edge: "#2a1e4a",
    glow: "rgba(167, 139, 250, 0.30)",
  },
  {
    id: "elite",
    name: "Elite",
    desc: "Dark luxury — charcoal with a platinum highlight sweep.",
    ring: "conic-gradient(from 210deg, #474f5e 0%, #14181f 22%, #97a1b2 46%, #14181f 72%, #474f5e 100%)",
    edge: "#101318",
    glow: "rgba(151, 161, 178, 0.18)",
  },
  {
    id: "royal",
    name: "Royal",
    desc: "Distinctive gold — a warm metallic double sweep.",
    ring: "conic-gradient(from 45deg, #f2d47a 0%, #8a6d1f 28%, #fde68a 52%, #8a6d1f 78%, #f2d47a 100%)",
    edge: "#241c08",
    glow: "rgba(242, 212, 122, 0.25)",
  },
  {
    id: "diamond",
    name: "Diamond",
    desc: "Icy cyan crystalline gradient with a silver inner line.",
    ring: "linear-gradient(135deg, #a5f3fc 0%, #38bdf8 40%, #e0f2fe 62%, #0ea5e9 100%)",
    edge: "#0b2739",
    glow: "rgba(165, 243, 252, 0.28)",
  },
  {
    id: "cyber",
    name: "Cyber",
    desc: "Modern tech — cyan circuit sweep on deep teal.",
    ring: "conic-gradient(from 0deg, #22d3ee 0%, #0e7490 25%, #164e63 48%, #22d3ee 62%, #0e7490 85%, #164e63 100%)",
    edge: "#052029",
    glow: "rgba(34, 211, 238, 0.22)",
  },
  {
    id: "legendary",
    name: "Legendary",
    desc: "Prestigious ember — molten orange over dark bronze.",
    ring: "conic-gradient(from 120deg, #fb923c 0%, #7c2d12 30%, #fbbf24 50%, #7c2d12 72%, #fb923c 100%)",
    edge: "#2a1005",
    glow: "rgba(251, 146, 60, 0.26)",
  },
  {
    id: "ceo",
    name: "CEO",
    desc: "Official InspireTrade CEO frame — black and gold metallic bezel. Exclusive to the platform's CEO account.",
    ring: "conic-gradient(from 90deg, #facc15 0%, #111114 18%, #fde68a 38%, #111114 58%, #facc15 78%, #111114 100%)",
    edge: "#0a0a0c",
    glow: "rgba(250, 204, 21, 0.30)",
    exclusive: true,
  },
];

/** Catalog order is also the gallery order. */
export const FRAMES: FrameDef[] = FRAMES_LIST;

export const FRAME_IDS: string[] = FRAMES_LIST.map((f) => f.id);

export function getFrame(id: string | null | undefined): FrameDef | null {
  if (!id) return null;
  return FRAMES_LIST.find((f) => f.id === id) ?? null;
}
