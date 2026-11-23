/**
 * workspace-presets — PHASE 48 Part 4: saved multi-chart workspaces.
 *
 * · Signed in: RTDB `chartWorkspaces/{uid}/{id}` (user-scoped rules) — the
 *   presets and the LAST-ACTIVE snapshot follow the user across devices.
 * · Signed out: localStorage mirror (`it_mc_last`) keeps the workspace
 *   restore working without an account.
 *
 * A preset captures layout + per-panel instrument/timeframe/chart-type +
 * sync toggles — everything needed to rebuild the grid exactly.
 */
import { ref as dbRef, get, remove as dbRemove, set, update } from "firebase/database";
import { db, auth } from "@/lib/firebase";
import type { Timeframe } from "@shared/terminal";
import type { LayoutId } from "@/lib/chart-layouts";
import { sanitizePreset, exportWorkspaceFile, importWorkspaceFile, type PanelCfg, type WorkspacePreset } from "@/lib/workspace-schema";
export { exportWorkspaceFile, importWorkspaceFile } from "@/lib/workspace-schema";

export type { PanelCfg, WorkspacePreset };

export const WORKSPACE_EVENT = "it_mc_workspaces_changed";

const LAST_LS_KEY = "it_mc_last";
const LS_KEY = "it_mc_workspaces";

const sanitizeWs = (raw: WorkspacePreset) => sanitizePreset(raw);

// ---- signed-in store (RTDB) ----------------------------------------------------

export async function fetchWorkspaces(): Promise<WorkspacePreset[]> {
  const uid = auth.currentUser?.uid;
  if (!uid) return readLocalWorkspaces();
  const snap = await get(dbRef(db, `chartWorkspaces/${uid}`)).catch(() => null);
  const val = snap?.val() || {};
  const out: WorkspacePreset[] = [];
  for (const [id, raw] of Object.entries<any>(val)) {
    if (id === "last") continue;
    const clean = sanitizeWs({ ...raw, id });
    if (clean) out.push(clean);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveWorkspacePreset(p: WorkspacePreset): Promise<void> {
  const uid = auth.currentUser?.uid;
  const clean = sanitizeWs(p);
  if (!clean) throw new Error("Invalid workspace");
  if (uid) {
    await set(dbRef(db, `chartWorkspaces/${uid}/${clean.id}`), clean);
  } else {
    saveLocalWorkspaces([clean, ...readLocalWorkspaces().filter((w) => w.id !== clean.id)]);
  }
  window.dispatchEvent(new CustomEvent(WORKSPACE_EVENT));
}

export async function deleteWorkspacePreset(id: string): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (uid) await dbRemove(dbRef(db, `chartWorkspaces/${uid}/${id}`));
  else saveLocalWorkspaces(readLocalWorkspaces().filter((w) => w.id !== id));
  window.dispatchEvent(new CustomEvent(WORKSPACE_EVENT));
}

export async function renameWorkspacePreset(id: string, name: string): Promise<void> {
  const clean = String(name || "").trim().slice(0, 60);
  if (!clean) return;
  const uid = auth.currentUser?.uid;
  if (uid) await update(dbRef(db, `chartWorkspaces/${uid}/${id}`), { name: clean, updatedAt: Date.now() });
  else saveLocalWorkspaces(readLocalWorkspaces().map((w) => (w.id === id ? { ...w, name: clean, updatedAt: Date.now() } : w)));
  window.dispatchEvent(new CustomEvent(WORKSPACE_EVENT));
}

/** PHASE 60: mark one workspace as the user's default (clears the flag on the
 * rest). The default is restored when no last-active snapshot exists. */
export async function setDefaultWorkspace(id: string): Promise<void> {
  const uid = auth.currentUser?.uid;
  const all = await fetchWorkspaces();
  for (const w of all) {
    if ((w.default ?? false) !== (w.id === id)) {
      w.default = w.id === id;
      w.updatedAt = Date.now();
      if (uid) await set(dbRef(db, `chartWorkspaces/${uid}/${w.id}`), w);
    }
  }
  saveLocalWorkspaces(all.map((w) => ({ ...w, default: w.id === id })));
  window.dispatchEvent(new CustomEvent(WORKSPACE_EVENT));
}

/** PHASE 60: fetchWorkspaces does not surface the default flag ordering —
 * dedicated helper for the restore path. */
export async function getDefaultWorkspace(): Promise<WorkspacePreset | null> {
  const all = await fetchWorkspaces();
  return all.find((w) => w.default === true) ?? null;
}

export async function duplicateWorkspacePreset(src: WorkspacePreset): Promise<WorkspacePreset> {
  const copy: WorkspacePreset = {
    ...src,
    id: `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: `${src.name} copy`,
    updatedAt: Date.now(),
  };
  await saveWorkspacePreset(copy);
  return copy;
}

// ---- last-active snapshot (restore on open / refresh / re-login) ---------------

export interface LastActive {
  layout: LayoutId;
  panels: PanelCfg[];
  colW?: number[];
  rowH?: number[];
}

export async function saveLastActive(s: LastActive): Promise<void> {
  const uid = auth.currentUser?.uid;
  try {
    if (uid) await set(dbRef(db, `chartWorkspaces/${uid}/last`), { ...s, at: Date.now() });
    else localStorage.setItem(LAST_LS_KEY, JSON.stringify(s));
  } catch { /* private mode / offline — localStorage mirror below still helps */
    try { localStorage.setItem(LAST_LS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
  }
}

export async function loadLastActive(): Promise<LastActive | null> {
  const uid = auth.currentUser?.uid;
  if (uid) {
    const snap = await get(dbRef(db, `chartWorkspaces/${uid}/last`)).catch(() => null);
    const raw = snap?.val();
    if (raw?.panels?.length) {
      const clean = sanitizeWs({ ...raw, id: "last", name: "last" });
      if (clean) return { layout: clean.layout, panels: clean.panels, colW: clean.colW, rowH: clean.rowH };
    }
  }
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_LS_KEY) || "null");
    if (raw?.panels?.length) {
      const clean = sanitizeWs({ ...raw, id: "last", name: "last" });
      if (clean) return { layout: clean.layout, panels: clean.panels, colW: clean.colW, rowH: clean.rowH };
    }
  } catch { /* ignore */ }
  return null;
}

// ---- signed-out local store -----------------------------------------------------

function readLocalWorkspaces(): WorkspacePreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || "[]") as WorkspacePreset[];
    return raw.map((w) => sanitizeWs(w)).filter(Boolean) as WorkspacePreset[];
  } catch {
    return [];
  }
}

function saveLocalWorkspaces(list: WorkspacePreset[]): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, 20))); } catch { /* private mode */ }
}
