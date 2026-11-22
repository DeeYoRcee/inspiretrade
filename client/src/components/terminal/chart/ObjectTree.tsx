/**
 * ObjectTree — P42: the Drawing Object Manager. One organized panel for
 * every drawing on the active chart: grouped folders, per-object rename /
 * visibility / lock, two-way selection sync with the chart, bulk actions,
 * search + category filter, full context menu, resizable width. The
 * templates & indicators sections are passed through as `children` so the
 * panel is the single "objects" surface.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Layers, Search, X, Eye, EyeOff, Lock, Unlock, Copy, Trash2, FolderPlus, Folder,
  ChevronRight, ChevronDown, ListChecks, PenLine, ArrowUpToLine, ArrowDownToLine,
  FolderInput, MoreVertical, Pencil,
} from "lucide-react";
import { ToolIcon, toolDisplayName, toolGroupTitle } from "./LeftRail";
import { effectiveName, type Drawing, type ZOrderAction } from "@/lib/drawings";
import { groupFlag, type DrawingGroup } from "@/lib/drawing-tree";
import { cn } from "@/lib/utils";

interface MenuItem {
  label: string;
  danger?: boolean;
  icon?: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  /** second level — "Move to group" */
  sub?: MenuItem[];
}

function TreeMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [sub, setSub] = useState<MenuItem[] | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // non-capture listeners — a capture-phase pointerdown would eat the
    // chart's own handlers (the exact bug ChartContextMenu fixed)
    const onDown = (e: PointerEvent) => { if (!el.contains(e.target as Node)) onClose(); };
    const onWheel = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("wheel", onWheel);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const shown = sub ?? items;
  const left = Math.max(4, Math.min(x, window.innerWidth - 204));
  const top = Math.max(4, Math.min(y, window.innerHeight - 60));
  return (
    <div ref={ref} data-chart-ui className="fixed z-50 w-48 rounded-lg border border-slate-700 bg-slate-900 py-1 shadow-2xl">
      {sub && (
        <button className="block w-full px-3 py-1.5 text-left text-xs text-slate-500 hover:bg-slate-800" onClick={() => setSub(null)}>
          ← Back
        </button>
      )}
      {shown.map((it, i) => (
        <button
          key={i}
          disabled={it.disabled}
          onClick={() => {
            if (it.sub) { setSub(it.sub); return; }
            it.onClick?.();
            onClose();
          }}
          className={cn(
            "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-transparent",
            it.danger ? "text-red-400" : "text-slate-300",
          )}
        >
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function ObjectTree({
  drawings, selectedDrawingId, selectedIds, groups,
  onSelect, onToggleSelect, onLocate,
  onRename, onPatch, onPatchMany, onDelete, onDuplicate, onEditProperties, onReorder,
  onGroupsChange, onCreateGroup, onRenameGroup, onDeleteGroup,
  onToggleGroupHidden, onToggleGroupLocked, onMoveToGroup,
  onClose,
  children,
}: {
  drawings: Drawing[];
  selectedDrawingId: string | null;
  selectedIds: string[];
  groups: Record<string, DrawingGroup>;
  onSelect: (id: string) => void;
  onToggleSelect: (id: string) => void;
  /** select + scroll the chart to the object */
  onLocate: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onPatch: (id: string, patch: Partial<Drawing>) => void;
  onPatchMany: (ids: string[], patch: Partial<Drawing>) => void;
  onDelete: (ids: string[]) => void;
  onDuplicate: (id: string) => void;
  onEditProperties: (id: string) => void;
  onReorder: (id: string, action: ZOrderAction) => void;
  /** collapse toggles persist on the group record */
  onGroupsChange: (next: Record<string, DrawingGroup>) => void;
  /** creates the group and RETURNS its id (used by move-to-new-group flows) */
  onCreateGroup: (name: string) => string;
  onRenameGroup: (id: string, name: string) => void;
  onDeleteGroup: (id: string) => void;
  onToggleGroupHidden: (id: string) => void;
  onToggleGroupLocked: (id: string) => void;
  onMoveToGroup: (ids: string[], groupId: string | null) => void;
  onClose: () => void;
  /** templates + indicators sections (PriceChart-owned state) */
  children?: ReactNode;
}) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingValue, setRenamingValue] = useState("");
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [width, setWidth] = useState(() => {
    try { const v = Number(localStorage.getItem("it_tree_width")); if (v >= 240 && v <= 460) return v; } catch { /* private mode */ }
    return 288;
  });

  const selSet = useMemo(() => new Set([...selectedIds, ...(selectedDrawingId ? [selectedDrawingId] : [])]), [selectedIds, selectedDrawingId]);
  const categories = useMemo(() => {
    const seen: string[] = [];
    for (const d of drawings) {
      const t = toolGroupTitle(d.type);
      if (!seen.includes(t)) seen.push(t);
    }
    return seen;
  }, [drawings]);

  const match = (d: Drawing): boolean => {
    if (cat && toolGroupTitle(d.type) !== cat) return false;
    if (!q.trim()) return true;
    return effectiveName(d).toLowerCase().includes(q.trim().toLowerCase());
  };
  const visibleRows = useMemo(() => drawings.filter(match), [drawings, q, cat]);

  const startRename = (d: Drawing) => { setRenamingId(d.id); setRenamingValue(effectiveName(d)); };
  const commitRename = () => {
    if (renamingId) onRename(renamingId, renamingValue);
    setRenamingId(null);
  };
  const startGroupRename = (g: DrawingGroup) => { setEditingGroupId(g.id); setRenamingValue(g.name); };
  const commitGroupRename = () => {
    if (editingGroupId && renamingValue.trim()) onRenameGroup(editingGroupId, renamingValue);
    setEditingGroupId(null);
  };

  // ---- resize handle (persisted) -------------------------------------------
  const resizeRef = useRef<{ x0: number; w0: number } | null>(null);
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    resizeRef.current = { x0: e.clientX, w0: width };
    const move = (ev: PointerEvent) => {
      const r = resizeRef.current!;
      setWidth(Math.min(460, Math.max(240, r.w0 - (ev.clientX - r.x0))));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const r = resizeRef.current!;
      const w = Math.min(460, Math.max(240, r.w0 - (ev.clientX - r.x0)));
      setWidth(w);
      try { localStorage.setItem("it_tree_width", String(w)); } catch { /* private mode */ }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ---- menus -----------------------------------------------------------------
  const moveGroupSub = (ids: string[]): MenuItem[] => [
    { label: "No group", onClick: () => onMoveToGroup(ids, null) },
    ...Object.values(groups)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      .map((g) => ({ label: g.name, icon: <Folder className="h-3 w-3 text-slate-500" />, onClick: () => onMoveToGroup(ids, g.id) })),
    {
      label: "＋ New group…",
      icon: <FolderPlus className="h-3 w-3 text-slate-500" />,
      onClick: () => {
        const name = window.prompt("New group name", "Group")?.trim();
        if (!name) return;
        onMoveToGroup(ids, onCreateGroup(name));
      },
    },
  ];
  const rowMenuFor = (d: Drawing): MenuItem[] => [
    { label: "Rename", icon: <Pencil className="h-3 w-3" />, onClick: () => startRename(d) },
    { label: "Edit properties", icon: <PenLine className="h-3 w-3" />, onClick: () => onEditProperties(d.id) },
    { label: "Duplicate", icon: <Copy className="h-3 w-3" />, onClick: () => onDuplicate(d.id) },
    { label: d.locked ? "Unlock" : "Lock", icon: d.locked ? <Unlock className="h-3 w-3" /> : <Lock className="h-3 w-3" />, onClick: () => onPatch(d.id, { locked: !d.locked }) },
    { label: d.hidden ? "Show" : "Hide", icon: d.hidden ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />, onClick: () => onPatch(d.id, { hidden: !d.hidden }) },
    { label: "Move to group", icon: <FolderInput className="h-3 w-3" />, sub: moveGroupSub([d.id]) },
    { label: "Bring to front", icon: <ArrowUpToLine className="h-3 w-3" />, onClick: () => onReorder(d.id, "front") },
    { label: "Send to back", icon: <ArrowDownToLine className="h-3 w-3" />, onClick: () => onReorder(d.id, "back") },
    { label: "Delete", danger: true, icon: <Trash2 className="h-3 w-3" />, disabled: d.locked, onClick: () => onDelete([d.id]) },
  ];
  const groupMenuFor = (g: DrawingGroup): MenuItem[] => {
    const memberIds = drawings.filter((d) => d.group === g.id).map((d) => d.id);
    const n = memberIds.length;
    return [
      { label: "Rename group", icon: <Pencil className="h-3 w-3" />, onClick: () => startGroupRename(g) },
      { label: groupFlag(drawings, g.id, "hidden") ? "Show all members" : "Hide all members", icon: <EyeOff className="h-3 w-3" />, disabled: !n, onClick: () => onToggleGroupHidden(g.id) },
      { label: groupFlag(drawings, g.id, "locked") ? "Unlock all members" : "Lock all members", icon: <Lock className="h-3 w-3" />, disabled: !n, onClick: () => onToggleGroupLocked(g.id) },
      {
        label: `Delete group (${n} → ungrouped)`,
        danger: true,
        icon: <Trash2 className="h-3 w-3" />,
        onClick: () => {
          if (window.confirm(`Delete group "${g.name}"? Its ${n} drawing(s) move back to Ungrouped — nothing is deleted.`)) onDeleteGroup(g.id);
        },
      },
    ];
  };

  // ---- row -------------------------------------------------------------------
  const row = (d: Drawing) => {
    const sel = selSet.has(d.id);
    return (
      <div
        key={d.id}
        className={cn("group/rw flex items-center gap-1 rounded px-1 py-0.5", sel && "bg-sky-500/20")}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: rowMenuFor(d) }); }}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-slate-400" title={toolDisplayName(d.type)}>
          <ToolIcon id={d.type} className="h-3.5 w-3.5" />
        </span>
        {renamingId === d.id ? (
          <input
            autoFocus
            value={renamingValue}
            onChange={(e) => setRenamingValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenamingId(null); }}
            onBlur={commitRename}
            className="h-5 min-w-0 flex-1 rounded border border-sky-600/60 bg-slate-800 px-1 text-[11px] text-slate-200 outline-none"
          />
        ) : (
          <button
            className={cn("min-w-0 flex-1 truncate text-left", d.hidden ? "text-slate-600" : "text-slate-300", sel ? "text-sky-200" : "hover:text-sky-300")}
            onClick={(e) => {
              if (e.ctrlKey || e.metaKey || e.shiftKey) onToggleSelect(d.id);
              else { onSelect(d.id); onLocate(d.id); }
            }}
            onDoubleClick={() => startRename(d)}
            title="Click: select + jump · Ctrl-click: multi-select · double-click: rename · right-click: menu"
          >
            {effectiveName(d)}
            {d.hidden && <span className="text-slate-600"> (hidden)</span>}
            {d.tfs?.length ? <span className="ml-1 text-[9px] text-sky-400">{d.tfs.map((x) => x.toUpperCase()).join(",")}</span> : null}
          </button>
        )}
        <button title={d.hidden ? "Show" : "Hide"} onClick={() => onPatch(d.id, { hidden: !d.hidden })} className="text-slate-500 hover:text-slate-200">
          {d.hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
        </button>
        <button
          title={d.locked ? "Unlock object" : "Lock object"}
          onClick={() => onPatch(d.id, { locked: !d.locked })}
          className={cn("text-slate-500 hover:text-slate-200", d.locked && "text-amber-400")}
        >
          {d.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
        </button>
      </div>
    );
  };

  const sectionHeader = (label: string, count: number, extra?: ReactNode) => (
    <div className="flex items-center gap-1 px-1 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
      <span className="min-w-0 flex-1 truncate">{label} · {count}</span>
      {extra}
    </div>
  );

  const orderedGroups = Object.values(groups).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const ungroupedRows = visibleRows.filter((d) => !d.group);
  const selIds = [...new Set([...selectedIds, ...(selectedDrawingId ? [selectedDrawingId] : [])])];
  const deletable = selIds.filter((id) => { const d = drawings.find((x) => x.id === id); return d && !d.locked; });

  return (
    <div
      data-chart-ui
      style={{ width }}
      className="absolute right-10 top-8 z-30 flex max-h-[calc(100%-2rem)] flex-col rounded-lg border border-slate-700 bg-slate-900/95 text-[11px] shadow-2xl backdrop-blur"
    >
      {/* header */}
      <div className="flex items-center gap-1 border-b border-slate-800 px-2 py-1.5">
        <Layers className="h-3.5 w-3.5 text-slate-400" />
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Objects · {drawings.length}</span>
        <span className="ml-auto flex items-center gap-0.5">
          <button
            title="Hide every drawing (each keeps its own state — Show all reverses it)"
            onClick={() => onPatchMany(drawings.map((d) => d.id), { hidden: true })}
            className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          >
            <EyeOff className="h-3.5 w-3.5" />
          </button>
          <button
            title="Show every drawing"
            onClick={() => onPatchMany(drawings.map((d) => d.id), { hidden: false })}
            className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          >
            <Eye className="h-3.5 w-3.5" />
          </button>
          <button
            title="New group"
            onClick={() => {
              const name = window.prompt("New group name", "Group")?.trim();
              if (name) onCreateGroup(name);
            }}
            className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
          <button title="Close the object tree" onClick={onClose} className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200">
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>

      {/* search + category filter */}
      <div className="flex items-center gap-1 border-b border-slate-800 px-2 py-1">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-600" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find drawing…"
            className="h-6 w-full rounded border border-slate-700 bg-slate-800 pl-6 pr-1 text-[11px] text-slate-200 placeholder:text-slate-600 outline-none focus:border-sky-600/60"
          />
        </div>
        <select
          title="Filter by drawing category"
          value={cat}
          onChange={(e) => setCat(e.target.value)}
          className="h-6 w-28 shrink-0 rounded border border-slate-700 bg-slate-800 px-1 text-[10px] text-slate-300 outline-none"
        >
          <option value="">All types</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* bulk bar */}
      <div className="flex items-center gap-0.5 border-b border-slate-800 px-2 py-1">
        <button
          title="Select all drawings in the list"
          onClick={() => { for (const d of visibleRows) if (!selSet.has(d.id)) onToggleSelect(d.id); }}
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200"
        >
          <ListChecks className="h-3.5 w-3.5" />
        </button>
        <button
          title="Duplicate the primary selected drawing"
          disabled={!selectedDrawingId}
          onClick={() => selectedDrawingId && onDuplicate(selectedDrawingId)}
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-30"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        <button
          title="Hide selected drawings"
          disabled={!selIds.length}
          onClick={() => onPatchMany(selIds, { hidden: true })}
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-30"
        >
          <EyeOff className="h-3.5 w-3.5" />
        </button>
        <button
          title="Lock selected drawings"
          disabled={!selIds.length}
          onClick={() => onPatchMany(selIds, { locked: true })}
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-30"
        >
          <Lock className="h-3.5 w-3.5" />
        </button>
        <button
          title="Move selected drawings into a group"
          disabled={!selIds.length}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 4, items: moveGroupSub(selIds) });
          }}
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200 disabled:opacity-30"
        >
          <FolderInput className="h-3.5 w-3.5" />
        </button>
        <button
          title="Delete selected drawings (locked ones are never deleted)"
          disabled={!deletable.length}
          onClick={() => onDelete(deletable)}
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-red-500/15 hover:text-red-300 disabled:opacity-30"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        {selIds.length > 0 && (
          <button title="Clear selection" onClick={() => { for (const id of selIds) onToggleSelect(id); }} className="ml-auto text-[10px] text-sky-400 hover:text-sky-300">
            {selIds.length} selected ✕
          </button>
        )}
      </div>

      {/* tree */}
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {drawings.length === 0 && (
          <p className="px-1 py-3 text-center leading-relaxed text-slate-600">
            No drawings yet — pick a tool from the left rail and click the chart.
          </p>
        )}

        {ungroupedRows.length > 0 && sectionHeader("Ungrouped", ungroupedRows.length)}
        {ungroupedRows.map(row)}

        {orderedGroups.map((g) => {
          const members = visibleRows.filter((d) => d.group === g.id);
          const total = drawings.filter((d) => d.group === g.id).length;
          const nameHit = g.name.toLowerCase().includes(q.trim().toLowerCase());
          if (members.length === 0 && !nameHit) return null;
          const collapsed = g.collapsed === true;
          return (
            <div key={g.id} className="mt-1">
              <div
                className="flex items-center gap-1 rounded bg-slate-800/60 px-1 py-0.5"
                onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: groupMenuFor(g) }); }}
              >
                <button
                  title={collapsed ? "Expand group" : "Collapse group"}
                  onClick={() => onGroupsChange({ ...groups, [g.id]: { ...g, collapsed: !collapsed } })}
                  className="flex h-4 w-4 items-center justify-center text-slate-500 hover:text-slate-300"
                >
                  {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </button>
                {editingGroupId === g.id ? (
                  <input
                    autoFocus
                    value={renamingValue}
                    onChange={(e) => setRenamingValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") commitGroupRename(); if (e.key === "Escape") setEditingGroupId(null); }}
                    onBlur={commitGroupRename}
                    className="h-5 min-w-0 flex-1 rounded border border-sky-600/60 bg-slate-800 px-1 text-[11px] text-slate-200 outline-none"
                  />
                ) : (
                  <button
                    className={cn("flex min-w-0 flex-1 items-center gap-1 truncate text-left text-slate-300", "hover:text-sky-300")}
                    onClick={() => onGroupsChange({ ...groups, [g.id]: { ...g, collapsed: !collapsed } })}
                    onDoubleClick={() => startGroupRename(g)}
                    title="Click: expand/collapse · double-click: rename · right-click: group menu"
                  >
                    <Folder className="h-3 w-3 shrink-0 text-amber-400/80" />
                    <span className="truncate normal-case">{g.name}</span>
                  </button>
                )}
                <span className="text-[9px] text-slate-600">{members.length}/{total}</span>
                <button
                  title={groupFlag(drawings, g.id, "hidden") ? "Show all members" : "Hide all members"}
                  onClick={() => onToggleGroupHidden(g.id)}
                  className={cn("text-slate-500 hover:text-slate-200", groupFlag(drawings, g.id, "hidden") && "text-slate-600")}
                >
                  <EyeOff className="h-3 w-3" />
                </button>
                <button
                  title={groupFlag(drawings, g.id, "locked") ? "Unlock all members" : "Lock all members"}
                  onClick={() => onToggleGroupLocked(g.id)}
                  className={cn("text-slate-500 hover:text-slate-200", groupFlag(drawings, g.id, "locked") && "text-amber-400")}
                >
                  <Lock className="h-3 w-3" />
                </button>
                <button
                  title="Group menu"
                  onClick={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setMenu({ x: r.left, y: r.bottom + 4, items: groupMenuFor(g) });
                  }}
                  className="text-slate-500 hover:text-slate-200"
                >
                  <MoreVertical className="h-3 w-3" />
                </button>
              </div>
              {!collapsed && members.map(row)}
            </div>
          );
        })}

        {/* templates + indicators — PriceChart-owned, same behavior as before */}
        {children}
      </div>

      {/* resize handle */}
      <div
        onPointerDown={startResize}
        className="absolute inset-y-0 left-0 w-1 cursor-ew-resize hover:bg-sky-500/40"
        title="Drag to resize the panel"
      />

      {menu && <TreeMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
