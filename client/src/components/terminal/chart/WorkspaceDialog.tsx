/**
 * WorkspaceDialog — PHASE 60 Part 2/5/8: named workspace manager.
 *
 * · Switch / rename / duplicate / delete (confirm) / mark-default
 * · Presets gallery built from the REAL supported layouts (no fake data —
 *   presets only configure layout + panel scaffolding; instruments start on
 *   the current symbol)
 * · Export as a downloadable JSON file / import with validation
 * · Compact, chart-first: opens as an overlay anchored to the toolbar button
 */
import { useEffect, useRef, useState } from "react";
import {
  Check, Copy, Download, FileUp, LayoutGrid, Loader2, Pencil, Plus, Star, Trash2, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/language-context";
import { useToast } from "@/hooks/use-toast";
import {
  deleteWorkspacePreset, duplicateWorkspacePreset, exportWorkspaceFile, fetchWorkspaces,
  importWorkspaceFile, renameWorkspacePreset, saveWorkspacePreset, setDefaultWorkspace,
  WORKSPACE_EVENT, type WorkspacePreset,
} from "@/lib/workspace-presets";
import { LAYOUT_ORDER, LAYOUTS, type LayoutId } from "@/lib/chart-layouts";
import type { Timeframe } from "@shared/terminal";

const PRESETS: Array<{ name: string; layout: LayoutId; timeframes: (Timeframe | null)[]; hint: string }> = [
  { name: "Single Chart Analysis", layout: "1", timeframes: [null], hint: "1× full-height chart" },
  { name: "Two-Chart Comparison", layout: "2h", timeframes: [null, null], hint: "2 charts side by side" },
  { name: "Four-Chart MTF", layout: "4", timeframes: ["5m", "15m", "1h", "1d"], hint: "4× multi-timeframe" },
  { name: "Six-Chart Overview", layout: "6", timeframes: ["1m", "5m", "15m", "1h", "4h", "1d"], hint: "6× market overview" },
];

export function WorkspaceDialog({
  open, onClose, currentSymbol, currentTimeframe, onApply, activeId,
}: {
  open: boolean;
  onClose: () => void;
  currentSymbol: string;
  currentTimeframe: Timeframe;
  /** rebuild the grid from a workspace preset (instruments + timeframes + layout) */
  onApply: (w: WorkspacePreset) => void;
  activeId: string | null;
}) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [list, setList] = useState<WorkspacePreset[]>([]);
  const [busy, setBusy] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef(list);
  listRef.current = list;

  const refresh = () => {
    setBusy(true);
    fetchWorkspaces().then((w) => setList(w)).catch(() => setList([])).finally(() => setBusy(false));
  };
  useEffect(() => {
    if (!open) return;
    refresh();
    const on = () => refresh();
    window.addEventListener(WORKSPACE_EVENT, on);
    return () => window.removeEventListener(WORKSPACE_EVENT, on);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const createFromCurrent = async () => {
    const name = window.prompt(t("wsNamePrompt"), `${currentSymbol} ${currentTimeframe.toUpperCase()}`);
    if (!name?.trim()) return;
    setBusy(true);
    try {
      await saveWorkspacePreset({
        id: `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        name: name.trim().slice(0, 60),
        layout: "1",
        panels: [{ symbol: currentSymbol, timeframe: currentTimeframe }],
        updatedAt: Date.now(),
      });
      toast({ title: t("wsCreated") });
    } finally { setBusy(false); }
  };

  const applyPreset = async (p: (typeof PRESETS)[number]) => {
    setBusy(true);
    try {
      const w: WorkspacePreset = {
        id: `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        name: p.name,
        layout: p.layout,
        panels: p.timeframes.map((tf, i) => ({
          symbol: currentSymbol,
          timeframe: tf ?? currentTf(i),
        })),
        updatedAt: Date.now(),
      };
      await saveWorkspacePreset(w);
      onApply(w);
      onClose();
    } finally { setBusy(false); }
  };
  const currentTf = (_i: number): Timeframe => currentTimeframe;

  const doImport = async (file: File) => {
    try {
      const text = await file.text();
      const w = importWorkspaceFile(text);
      setBusy(true);
      await saveWorkspacePreset(w); // saved under the CURRENT uid — ownership safe
      refresh();
      toast({ title: t("wsImported"), description: w.name });
    } catch (e: any) {
      toast({ title: t("wsImportFailed"), description: String(e?.message || ""), variant: "destructive" });
    } finally { setBusy(false); }
  };

  return (
    <div className="absolute inset-0 z-[70] flex items-start justify-center bg-black/60 p-4 pt-10" onClick={() => !confirmDelete && onClose()}>
      <div
        className="w-full max-w-md space-y-3 rounded-2xl border border-slate-700/70 bg-slate-950/97 p-3 text-xs shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold text-slate-200">
            <LayoutGrid className="h-4 w-4 text-sky-400" />
            {t("wsTitle")}
          </div>
          <div className="flex items-center gap-1">
            <button title={t("wsImportTitle")} onClick={() => fileRef.current?.click()} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200">
              <FileUp className="h-4 w-4" />
            </button>
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImport(f); e.target.value = ""; }} />
            <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* presets gallery */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-2">
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">{t("wsPresetsTitle")}</p>
          <div className="grid grid-cols-2 gap-1.5">
            {PRESETS.map((p) => (
              <button key={p.name} disabled={busy} onClick={() => void applyPreset(p)}
                className="rounded-lg border border-slate-700/70 bg-slate-900/70 p-2 text-left transition hover:border-sky-500/60 hover:bg-sky-500/10 disabled:opacity-50">
                <div className="font-semibold text-slate-200">{p.name}</div>
                <div className="text-[10px] text-slate-500">{p.hint}</div>
              </button>
            ))}
          </div>
        </div>

        {/* saved workspaces */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{t("wsSavedTitle")}</p>
            <button disabled={busy} onClick={() => void createFromCurrent()}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 font-semibold text-sky-300 hover:bg-sky-500/10 disabled:opacity-50">
              <Plus className="h-3 w-3" />{t("wsCreateCurrent")}
            </button>
          </div>
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {busy && <div className="flex justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-slate-500" /></div>}
            {list.map((w) => (
              <div key={w.id} className={cn(
                "rounded-lg border px-2 py-1.5",
                activeId === w.id ? "border-sky-500/60 bg-sky-500/10" : "border-slate-800 bg-slate-900/50",
              )}>
                {renameId === w.id ? (
                  <div className="flex gap-1">
                    <input
                      autoFocus
                      value={renameVal}
                      onChange={(e) => setRenameVal(e.target.value.slice(0, 60))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && renameVal.trim()) {
                          void renameWorkspacePreset(w.id, renameVal).then(() => { setRenameId(null); refresh(); });
                        }
                        if (e.key === "Escape") setRenameId(null);
                      }}
                      className="h-6 min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 px-1.5 text-slate-200"
                    />
                    <button onClick={() => { if (renameVal.trim()) void renameWorkspacePreset(w.id, renameVal).then(() => { setRenameId(null); refresh(); }); }}
                      className="rounded p-1 text-emerald-400 hover:bg-emerald-500/10"><Check className="h-3.5 w-3.5" /></button>
                    <button onClick={() => setRenameId(null)} className="rounded p-1 text-slate-500 hover:bg-slate-800"><X className="h-3.5 w-3.5" /></button>
                  </div>
                ) : confirmDelete === w.id ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-red-300">{`${t("wsDeleteConfirm")}: ${w.name}`}</span>
                    <div className="flex gap-1">
                      <button onClick={() => void deleteWorkspacePreset(w.id).then(refresh)}
                        className="rounded border border-red-500/60 px-2 py-0.5 font-semibold text-red-400 hover:bg-red-500/10">{t("wsDeleteYes")}</button>
                      <button onClick={() => setConfirmDelete(null)}
                        className="rounded border border-slate-600 px-2 py-0.5 font-semibold text-slate-300 hover:bg-slate-800">{t("wsDeleteNo")}</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-1">
                    <button onClick={() => { onApply(w); onClose(); }} className="min-w-0 flex-1 text-left" title={t("wsSwitch")}>
                      <div className="flex items-center gap-1.5 truncate font-semibold text-slate-200">
                        {w.default && <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />}
                        {w.name}
                      </div>
                      <div className="truncate text-[10px] text-slate-500">
                        {LAYOUTS[w.layout]?.label ?? w.layout} · {w.panels.map((p) => p.symbol).join(", ")}
                      </div>
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button title={t("wsSetDefault")} onClick={() => void setDefaultWorkspace(w.id).then(refresh)}
                        className={cn("rounded p-1 hover:bg-slate-800", w.default ? "text-amber-400" : "text-slate-500 hover:text-amber-300")}>
                        <Star className={cn("h-3.5 w-3.5", w.default && "fill-current")} />
                      </button>
                      <button title={t("wsRename")} onClick={() => { setRenameId(w.id); setRenameVal(w.name); }}
                        className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200"><Pencil className="h-3.5 w-3.5" /></button>
                      <button title={t("wsDuplicate")} onClick={() => void duplicateWorkspacePreset(w).then(() => { toast({ title: t("wsDuplicated") }); refresh(); })}
                        className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200"><Copy className="h-3.5 w-3.5" /></button>
                      <button title={t("wsExport")} onClick={() => {
                        const blob = new Blob([JSON.stringify(exportWorkspaceFile(w), null, 2)], { type: "application/json" });
                        const a = document.createElement("a");
                        a.href = URL.createObjectURL(blob);
                        a.download = `${w.name.replace(/[^\w-]+/g, "_")}.workspace.json`;
                        a.click();
                        URL.revokeObjectURL(a.href);
                      }} className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-200"><Download className="h-3.5 w-3.5" /></button>
                      <button title={t("wsDelete")} onClick={() => setConfirmDelete(w.id)}
                        className="rounded p-1 text-slate-500 hover:bg-red-500/10 hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {!busy && !list.length && (
              <p className="py-3 text-center text-slate-500">{t("wsNoSaved")}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
