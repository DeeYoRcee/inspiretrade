/**
 * Workspace templates — named snapshots of the terminal configuration
 * (layout, symbol, timeframe, chart type, indicators, colors, volume) plus
 * optional per-symbol drawings, stored in RTDB `terminalTemplates/{uid}` and
 * restorable with one click after login.
 */
import { ref, get, set, remove } from "firebase/database";
import { db } from "@/lib/firebase";
import type { TerminalSettings } from "@/hooks/use-terminal-workspace";
import type { Drawing } from "@/lib/terminal/drawings";

export interface WorkspaceTemplate {
  id: string;
  name: string;
  createdAt: number;
  settings: TerminalSettings;
  /** optional drawing snapshots keyed by symbol */
  drawings?: Record<string, Drawing[]>;
}

const node = (uid: string) => `terminalTemplates/${uid}`;

export async function listTemplates(uid: string): Promise<WorkspaceTemplate[]> {
  const snap = await get(ref(db, node(uid)));
  return snap.exists() ? Object.values<WorkspaceTemplate>(snap.val()).sort((a, b) => b.createdAt - a.createdAt) : [];
}

export async function saveTemplate(uid: string, name: string, settings: TerminalSettings, drawings?: Record<string, Drawing[]>): Promise<WorkspaceTemplate> {
  const tpl: WorkspaceTemplate = {
    id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    name: name.trim() || "Template",
    createdAt: Date.now(),
    settings: JSON.parse(JSON.stringify(settings)),
    drawings: drawings ? JSON.parse(JSON.stringify(drawings)) : undefined,
  };
  await set(ref(db, `${node(uid)}/${tpl.id}`), tpl);
  return tpl;
}

export async function deleteTemplate(uid: string, id: string): Promise<void> {
  await remove(ref(db, `${node(uid)}/${id}`));
}
