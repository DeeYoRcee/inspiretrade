/**
 * P44 §1 — TradingView-inspired compact color picker.
 *
 * One organized grid of standard swatches + ONE clearly identifiable custom
 * option (native OS picker + live hex input). Picks apply IMMEDIATELY to the
 * active drawing. Replaces the old 8-swatch row and the scattered native
 * `<input type=color>` widgets; used for line color, fill, text, Fibonacci
 * levels and position zones alike — never two competing selectors for the
 * same property.
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** TradingView-style dark-chart palette — ordered, deduplicated. */
export const SWATCHES: readonly string[] = [
  "#ffffff", "#c8cbd4", "#787b86", "#434651", "#000000",
  "#2962ff", "#38bdf8", "#00bcd4", "#26a69a", "#089981",
  "#4caf50", "#22c55e", "#fdd835", "#ff9800", "#f59e0b",
  "#f23645", "#a78bfa", "#7e57c2", "#f472b6",
];

const HEX_RE = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i;

/** Accepts "38bdf8" / "#38BDF8" → "#38bdf8"; anything else → null. */
export function normalizeHex(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  const cand = s.startsWith("#") ? s : `#${s}`;
  return HEX_RE.test(cand) ? cand.toLowerCase() : null;
}

export function ColorPicker({
  value, onChange, title = "Color", placement = "top", align = "left",
}: {
  value: string;
  onChange: (hex: string) => void;
  title?: string;
  /** popovers open upward by default (props bar sits at the chart bottom) */
  placement?: "top" | "bottom";
  align?: "left" | "right";
}) {
  // older saved drawings can carry a missing/non-hex color (rgba() strings,
  // undefined after a bad patch) — every internal consumer must stay crash-
  // proof and the native OS input demands a strict #rrggbb value
  const safe = typeof value === "string" && value ? value : "#2962ff";
  const native = /^#[0-9a-f]{6}$/i.test(safe) ? safe : "#2962ff";
  const [open, setOpen] = useState(false);
  const [hex, setHex] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  // close on any pointerdown outside this picker (capture — works even when
  // the chart canvas consumes the event)
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.("[data-colorpicker]")) setOpen(false);
    };
    document.addEventListener("pointerdown", onDoc, true);
    return () => document.removeEventListener("pointerdown", onDoc, true);
  }, [open]);
  useEffect(() => { if (open) setHex(safe); }, [open, safe]);

  return (
    <div ref={rootRef} data-colorpicker className="relative inline-flex">
      <button
        type="button"
        title={title}
        aria-label={title}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }}
        className={cn(
          "h-5 w-5 shrink-0 rounded border shadow-inner transition-shadow",
          open ? "border-sky-400 ring-1 ring-sky-400" : "border-slate-500/80 hover:border-slate-300",
        )}
        style={{ background: safe }}
      />
      {open && (
        <div
          className={cn(
            "absolute z-50 w-[15.5rem] rounded-lg border border-slate-700 bg-[#0d1526] p-1.5 shadow-2xl",
            placement === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          <div className="grid grid-cols-10 gap-1">
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                aria-label={`Color ${c}`}
                onClick={() => { onChange(c); setOpen(false); }}
                className={cn(
                  "h-5 w-5 rounded-full border transition-transform hover:scale-110",
                  safe.toLowerCase() === c
                    ? "border-white ring-2 ring-white/80 ring-offset-1 ring-offset-[#0d1526]"
                    : "border-white/15",
                )}
                style={{ background: c }}
              />
            ))}
            {/* the single custom option — native OS picker */}
            <label
              title="Custom color — pick any color"
              className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-[conic-gradient(red,#ff0,lime,cyan,blue,magenta,red)] transition-transform hover:scale-110"
            >
              <input
                type="color"
                value={native}
                onChange={(e) => onChange(e.target.value.toLowerCase())}
                className="sr-only"
                aria-label="Custom color"
              />
            </label>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <span className="text-[10px] font-semibold tracking-wide text-slate-500">HEX</span>
            <input
              value={hex}
              onChange={(e) => {
                setHex(e.target.value);
                const n = normalizeHex(e.target.value);
                if (n) onChange(n);
              }}
              onKeyDown={(e) => { if (e.key === "Enter") setOpen(false); }}
              placeholder="#38bdf8"
              className="num-input h-5 w-24 px-1 text-[10px]"
              aria-label="Hex color value"
            />
            <span
              className="ml-auto h-4 w-8 shrink-0 rounded border border-slate-600"
              style={{ background: safe }}
              title="Current color"
            />
          </div>
        </div>
      )}
    </div>
  );
}
