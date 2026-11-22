/**
 * P44 §5 — per-tool drawing style defaults (PURE logic — persistence lives in
 * chart-persistence.ts so this module stays unit-testable in node).
 *
 * Map: tool id → style patch applied ON TOP of the global chart-settings
 * defaults when a NEW object of that tool is created. Editing an existing
 * drawing never touches this map, and existing objects keep their own style —
 * only creation-time defaults change.
 */
import type { DrawingStyle } from "@/lib/drawings";

export type ToolDefaultPatch = Partial<DrawingStyle>;
export type DrawingDefaultsMap = Record<string, ToolDefaultPatch | undefined>;

/** Fields persisted for a tool default — text CONTENT stays per-object. */
const DEFAULT_FIELDS = [
  "color", "width", "dash", "fontSize", "fill", "opacity", "extend",
  "textColor", "textPos", "fontWeight", "textAlign", "textBg",
  "profitColor", "lossColor",
] as const;

const STRING_FIELDS = new Set([
  "color", "dash", "extend", "textColor", "textPos", "fontWeight",
  "textAlign", "textBg", "profitColor", "lossColor",
]);
const NUMBER_FIELDS = new Set(["width", "fontSize", "opacity"]);

/** validate one style patch — only correctly-typed DEFAULT_FIELDS survive */
function sanitizePatch(raw: unknown): ToolDefaultPatch | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const clean: Record<string, unknown> = {};
  for (const k of DEFAULT_FIELDS) {
    const v = (raw as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (STRING_FIELDS.has(k) && typeof v === "string" && v) clean[k] = v;
    else if (NUMBER_FIELDS.has(k) && typeof v === "number" && Number.isFinite(v)) clean[k] = v;
    else if (k === "fill" && v && typeof v === "object" && !Array.isArray(v)) {
      const f = v as Record<string, unknown>;
      const fill: { color?: string; opacity?: number } = {};
      if (typeof f.color === "string" && f.color) fill.color = f.color;
      if (typeof f.opacity === "number" && Number.isFinite(f.opacity)) fill.opacity = f.opacity;
      if (Object.keys(fill).length) clean[k] = fill;
    }
  }
  return Object.keys(clean).length ? (clean as ToolDefaultPatch) : undefined;
}

/** Extract the persistable style subset from a live drawing's style. */
export function newDefaultFromStyle(style: DrawingStyle): ToolDefaultPatch {
  const src = style as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of DEFAULT_FIELDS) {
    const v = src[k];
    if (v !== undefined) out[k] = v;
  }
  return out as ToolDefaultPatch;
}

/** Validate an incoming map (RTDB snapshot / LS mirror) — drops junk safely. */
export function sanitizeDefaultsMap(raw: unknown): DrawingDefaultsMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: DrawingDefaultsMap = {};
  for (const [tool, patch] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof tool !== "string" || !tool || tool === "savedAt") continue;
    const clean = sanitizePatch(patch);
    if (clean) out[tool] = clean;
  }
  return out;
}

/** Creation-time merge: global fallback (chart settings) ← per-tool default. */
export function styleForTool(
  map: DrawingDefaultsMap,
  tool: string | null,
  fallback: Partial<DrawingStyle>,
): Partial<DrawingStyle> {
  const toolPatch = tool ? map[tool] : undefined;
  return { ...fallback, ...(toolPatch || {}) };
}
