import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, Search } from "lucide-react";
import {
  SHORTCUT_DEFS, formatBinding, normalizeBinding, findConflicts,
  type ShortcutAction,
} from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

/**
 * P55 §11 — searchable, customizable keyboard-shortcuts panel. Click a key
 * cell and press the new combination (Esc cancels); conflicts are highlighted
 * live; "Reset all" restores the defaults.
 */
export function ShortcutsPanel({
  bindings, onChange, onResetAll,
}: {
  bindings: Record<ShortcutAction, string>;
  onChange: (next: Record<ShortcutAction, string>) => void;
  onResetAll: () => void;
}) {
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);
  const [query, setQuery] = useState("");
  const captureRef = useRef<ShortcutAction | null>(null);
  captureRef.current = capturing;

  // capture mode: the next keydown (anywhere) becomes the binding
  useEffect(() => {
    if (!capturing) return;
    const h = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setCapturing(null); return; }
      const raw = [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", e.metaKey && "meta", e.key.toLowerCase()]
        .filter(Boolean).join("+");
      const norm = normalizeBinding(raw);
      // letters and digits may ONLY be combined with modifiers — plain typing
      // must stay safe; function keys / special keys are fine bare
      const bare = !["ctrl", "alt", "shift", "meta"].some((m) => norm.includes(m + "+"));
      if (bare && /^[a-z]$/.test(norm)) return; // reject bare letters silently
      if (!norm) return;
      onChange({ ...bindings, [capturing]: norm });
      setCapturing(null);
    };
    window.addEventListener("keydown", h, { capture: true });
    return () => window.removeEventListener("keydown", h, { capture: true } as any);
  }, [capturing, bindings, onChange]);

  const conflicts = useMemo(() => {
    const set = new Set<string>();
    for (const group of findConflicts(bindings)) for (const a of group) set.add(a);
    return set;
  }, [bindings]);

  const q = query.trim().toLowerCase();
  const rows = SHORTCUT_DEFS.filter((d) => !q || d.label.toLowerCase().includes(q) || d.hint.toLowerCase().includes(q) || d.action.includes(q));

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search shortcuts…"
          aria-label="Search shortcuts"
          className="h-8 w-full rounded-lg border border-slate-700/60 bg-slate-900/60 ps-8 pe-2 text-xs text-slate-300 placeholder:text-slate-500 focus:border-primary/60 focus:outline-none"
        />
      </div>
      <div className="overflow-hidden rounded-lg border border-slate-800/70">
        {rows.map((d) => {
          const b = bindings[d.action] ?? "";
          return (
            <div key={d.action} className="flex items-center gap-2 border-b border-slate-800/50 px-2.5 py-1.5 last:border-b-0">
              <div className="min-w-0 flex-1">
                <p className={cn("truncate text-xs font-semibold", conflicts.has(d.action) ? "text-amber-400" : "text-slate-200")}>
                  {d.label}
                  {conflicts.has(d.action) && <span className="ms-1.5 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-bold uppercase text-amber-400">conflict</span>}
                </p>
                <p className="truncate text-[10px] text-slate-500">{d.hint}</p>
              </div>
              <button
                onClick={() => setCapturing(capturing === d.action ? null : d.action)}
                aria-label={`Change shortcut for ${d.label}`}
                className={cn(
                  "min-w-[88px] rounded-md border px-2 py-1 text-[11px] font-semibold transition-colors",
                  capturing === d.action ? "animate-pulse border-primary bg-primary/15 text-primary" :
                    b ? "border-slate-700/70 text-slate-300 hover:border-primary/50 hover:text-primary" : "border-dashed border-slate-700 text-slate-500 hover:text-slate-300",
                  conflicts.has(d.action) && b && "border-amber-500/60",
                )}
              >
                {capturing === d.action ? "Press keys…" : b ? formatBinding(b) : "Not set"}
              </button>
            </div>
          );
        })}
        {!rows.length && <p className="px-2.5 py-4 text-center text-xs text-slate-500">No shortcut matches "{query}"</p>}
      </div>
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-muted-foreground">Shortcuts never fire while typing in inputs. Browser/OS combos are untouched.</p>
        <button
          onClick={onResetAll}
          className="flex items-center gap-1.5 rounded-lg border border-border/60 px-2 py-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground"
        >
          <RotateCcw className="h-3 w-3" /> Reset all
        </button>
      </div>
    </div>
  );
}
