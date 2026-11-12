/**
 * IndicatorDialog — searchable indicator library with parameter editing.
 * Adds/removes indicators on the active chart; params use each definition's
 * defaults and are recomputed live.
 */
import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Search, Plus, X, Settings2 } from "lucide-react";
import { INDICATORS, getIndicator } from "@/lib/terminal/indicators";
import type { ActiveIndicator } from "./TerminalChart";
import { useLanguage } from "@/lib/language-context";
import { cn } from "@/lib/utils";

export function IndicatorDialog({
  open, onOpenChange, active, onChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  active: ActiveIndicator[];
  onChange: (list: ActiveIndicator[]) => void;
}) {
  const { t } = useLanguage();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<string | null>(null);

  const groups = useMemo(() => {
    const q = search.toLowerCase();
    const list = INDICATORS.filter((i) => i.label.toLowerCase().includes(q));
    const order = ["MA", "Momentum", "Trend", "Volatility", "Volume"] as const;
    return order.map((g) => ({ g, items: list.filter((i) => i.group === g) })).filter((x) => x.items.length);
  }, [search]);

  const isActive = (id: string) => active.some((a) => a.id === id);

  const add = (id: string) => {
    const def = getIndicator(id)!;
    if (isActive(id)) return;
    onChange([...active, { id, params: { ...def.defaults } }]);
  };
  const remove = (id: string) => onChange(active.filter((a) => a.id !== id));
  const patchParams = (id: string, key: string, value: number) =>
    onChange(active.map((a) => (a.id === id ? { ...a, params: { ...a.params, [key]: value } } : a)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto rounded-xl border-border/60 bg-card sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{t("indicators")}</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="RSI, MACD, EMA…"
            className="h-9 w-full rounded-lg border border-border/60 bg-background/60 pl-8 pr-2 text-sm outline-none focus:border-emerald-500/50"
          />
        </div>
        <div className="space-y-3">
          {groups.map(({ g, items }) => (
            <div key={g}>
              <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{g}</div>
              <div className="grid grid-cols-2 gap-1.5">
                {items.map((def) => {
                  const on = isActive(def.id);
                  return (
                    <div key={def.id} className={cn("rounded-lg border px-2 py-1.5 text-xs", on ? "border-emerald-500/50 bg-emerald-500/10" : "border-border/60")}>
                      <div className="flex items-center gap-1">
                        <span className="min-w-0 flex-1 truncate font-medium">{def.label}</span>
                        {on ? (
                          <>
                            <button onClick={() => setEditing(editing === def.id ? null : def.id)} className="text-muted-foreground hover:text-foreground" title="Params"><Settings2 className="h-3.5 w-3.5" /></button>
                            <button onClick={() => remove(def.id)} className="text-muted-foreground hover:text-red-400" title="Remove"><X className="h-3.5 w-3.5" /></button>
                          </>
                        ) : (
                          <button onClick={() => add(def.id)} className="text-emerald-400 hover:text-emerald-300"><Plus className="h-3.5 w-3.5" /></button>
                        )}
                      </div>
                      {on && editing === def.id && (() => {
                        const a = active.find((x) => x.id === def.id)!;
                        const def2 = getIndicator(def.id)!;
                        return (
                          <div className="mt-1.5 space-y-1 border-t border-border/40 pt-1.5">
                            {Object.keys(def2.defaults).map((k) => (
                              <label key={k} className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                                {k}
                                <input
                                  type="number" step="any"
                                  value={a.params[k] ?? def2.defaults[k]}
                                  onChange={(e) => patchParams(def.id, k, Number(e.target.value))}
                                  className="num-input h-6 w-16 text-[11px]"
                                />
                              </label>
                            ))}
                            {Object.keys(def2.defaults).length === 0 && <div className="text-[10px] text-muted-foreground">—</div>}
                          </div>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
