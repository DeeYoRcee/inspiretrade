/**
 * P42 — Drawing Object Tree data model (PURE, unit-tested).
 * Groups are lightweight folders: a drawing carries `group?: string` (the
 * group id; undefined = the Ungrouped root) and the group metadata lives in
 * `chart/{uid}/groups/{symbol}` (see chart-persistence). Group-level
 * hide/lock are BULK operations on the member drawings — every state stays
 * on the object itself, survives refresh, and nothing is virtually inherited.
 */

export interface DrawingGroup {
  id: string;
  /** display name, clamped to 40 chars */
  name: string;
  /** tree UI state — persisted so the tree reopens as the user left it */
  collapsed?: boolean;
  createdAt?: number;
}

type TreeDrawing = { id: string; group?: string; hidden?: boolean; locked?: boolean };

let gidCounter = 0;
export function newGroupId(): string {
  gidCounter = (gidCounter + 1) % 1_000_000;
  return `g${Date.now().toString(36)}${gidCounter.toString(36)}`;
}

/** Validate a raw RTDB/LS payload — corrupted groups never reach the UI.
 *  The map KEY is the group id (RTDB convention); an inner `id` field is
 *  ignored so a mismatched copy can never shadow the key. */
export function sanitizeGroups(raw: unknown): Record<string, DrawingGroup> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, DrawingGroup> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    if (!/^[a-z0-9]{2,48}$/i.test(id)) continue;
    const g = v as Record<string, unknown>;
    const name = typeof g.name === "string" ? g.name.trim().slice(0, 40) : "";
    if (!name) continue;
    out[id] = {
      id,
      name,
      ...(g.collapsed === true ? { collapsed: true } : {}),
      ...(Number.isFinite(Number(g.createdAt)) ? { createdAt: Number(g.createdAt) } : {}),
    };
  }
  return out;
}

/** Assign (or clear, when groupId is null) the group of the given objects. */
export function moveToGroup<T extends TreeDrawing>(list: T[], ids: string[], groupId: string | null): T[] {
  const set = new Set(ids);
  if (!set.size) return list;
  return list.map((d) => (set.has(d.id) ? { ...d, group: groupId ?? undefined } : d));
}

/** All member ids of a group (order = list order). */
export function groupMemberIds(list: TreeDrawing[], groupId: string): string[] {
  return list.filter((d) => d.group === groupId).map((d) => d.id);
}

/**
 * Deleting a group NEVER deletes drawings — members return to the Ungrouped
 * root and the group record is dropped.
 */
export function dissolveGroup<T extends TreeDrawing>(list: T[], groupId: string): T[] {
  return list.map((d) => (d.group === groupId ? { ...d, group: undefined } : d));
}

/** Bulk patch for a set of ids (skips objects not in the list). */
export function bulkPatch<T extends { id: string }>(list: T[], ids: string[], patch: Partial<T>): T[] {
  const set = new Set(ids);
  if (!set.size) return list;
  return list.map((d) => (set.has(d.id) ? { ...d, ...patch } : d));
}

/** Group state summary for the header toggles: true only when EVERY member has it. */
export function groupFlag(list: TreeDrawing[], groupId: string, flag: "hidden" | "locked"): boolean {
  const members = list.filter((d) => d.group === groupId);
  return members.length > 0 && members.every((d) => d[flag] === true);
}
