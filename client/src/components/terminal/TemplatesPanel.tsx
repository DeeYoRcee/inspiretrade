/**
 * TemplatesPanel — save the current terminal configuration (layout, symbol,
 * timeframe, chart type, indicators, colors, volume) as a named workspace
 * template in Firebase, list them, restore with one click and delete.
 * Optionally also snapshots the current symbol's drawings.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Save, Trash2 } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import type { TerminalSettings } from "@/hooks/use-terminal-workspace";
import { listTemplates, saveTemplate, deleteTemplate, type WorkspaceTemplate } from "@/lib/terminal/templates";
import type { Drawing } from "@/lib/terminal/drawings";
import { cn } from "@/lib/utils";

export function TemplatesPanel({ settings, currentDrawings, onApply, className }: {
  settings: TerminalSettings;
  currentDrawings: Drawing[];
  onApply: (s: TerminalSettings) => void;
  className?: string;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [withDrawings, setWithDrawings] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["workspaceTemplates", user?.uid],
    enabled: !!user,
    queryFn: () => listTemplates(user!.uid),
  });

  const save = async () => {
    if (!user || !name.trim()) return;
    await saveTemplate(user.uid, name, settings, withDrawings ? { [settings.symbol]: currentDrawings } : undefined);
    setName("");
    setMsg("Template saved.");
    qc.invalidateQueries({ queryKey: ["workspaceTemplates", user.uid] });
    setTimeout(() => setMsg(null), 2500);
  };

  const apply = (tpl: WorkspaceTemplate) => {
    onApply({ ...settings, ...tpl.settings });
    setMsg(`“${tpl.name}” applied.`);
    setTimeout(() => setMsg(null), 2500);
  };

  return (
    <div className={cn("space-y-3 text-[11px]", className)}>
      <section className="rounded-xl border border-border/50 bg-card/40 p-2.5">
        <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Save current workspace</div>
        <div className="flex gap-1.5">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name…" className="num-input h-7 flex-1" />
          <button onClick={save} disabled={!name.trim() || !user} className="flex h-7 items-center gap-1 rounded-lg border border-emerald-500/40 px-2 font-bold text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-40"><Save className="h-3 w-3" />Save</button>
        </div>
        <label className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
          <input type="checkbox" checked={withDrawings} onChange={(e) => setWithDrawings(e.target.checked)} className="accent-emerald-500" />
          include drawings of {settings.symbol}
        </label>
        <p className="mt-1 text-[9px] text-muted-foreground">Snapshot: layout, symbol, timeframe, chart type, indicators, colors, volume. Restored after login from Firebase.</p>
      </section>

      <section className="space-y-1.5">
        <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Saved templates</div>
        {q.isLoading && <div className="py-3 text-center text-muted-foreground">Loading…</div>}
        {!(q.data ?? []).length && !q.isLoading && <div className="rounded-lg border border-border/40 px-2 py-3 text-center text-muted-foreground">No templates yet — configure the terminal and save it.</div>}
        {(q.data ?? []).map((tpl) => (
          <div key={tpl.id} className="flex items-center gap-2 rounded-lg border border-border/50 bg-card/40 px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="truncate font-bold">{tpl.name}</div>
              <div className="text-[9px] text-muted-foreground">{tpl.settings.symbol} · {tpl.settings.timeframe} · {tpl.settings.indicators.length} indicators · {tpl.settings.layout}-chart</div>
            </div>
            <button onClick={() => apply(tpl)} className="rounded border border-emerald-500/40 px-2 py-0.5 text-[10px] font-bold text-emerald-400 hover:bg-emerald-500/10">Apply</button>
            <button onClick={async () => { if (user) { await deleteTemplate(user.uid, tpl.id); qc.invalidateQueries({ queryKey: ["workspaceTemplates", user.uid] }); } }} className="text-muted-foreground hover:text-red-400"><Trash2 className="h-3 w-3" /></button>
          </div>
        ))}
      </section>
      {msg && <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5 text-emerald-300">{msg}</div>}
      {!user && <p className="text-[9px] text-amber-400">Sign in to save templates to your account.</p>}
    </div>
  );
}
