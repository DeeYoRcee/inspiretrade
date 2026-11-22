/**
 * P41 §2 — favorite drawing tools, per authenticated user. PURE part:
 * sanitize / LS mirror / toggle / reorder. The RTDB sync lives in
 * chart-persistence.ts (saveFavorites / subscribeFavorites). Order IS
 * data — the floating toolbar renders and drag-reorders this array.
 */

const LS_KEY = (uid: string) => `it_chart_favorites_${uid || "anon"}`;
export const MAX_FAVORITES = 16;

function sanitize(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((x): x is string => typeof x === "string" && x.length > 0))].slice(0, MAX_FAVORITES);
}

export function readFavoritesLocal(uid: string): string[] {
  try {
    const raw = localStorage.getItem(LS_KEY(uid));
    return raw ? sanitize(JSON.parse(raw)) : [];
  } catch { return []; }
}

export function writeFavoritesLocal(uid: string, list: string[]): void {
  const clean = sanitize(list);
  try { localStorage.setItem(LS_KEY(uid), JSON.stringify(clean)); } catch { /* private mode */ }
}

/** Pure toggle — dedupes and caps the list; when full, the OLDEST favorite
 *  yields its slot so the just-added tool is always present. */
export function toggleFavorite(list: string[], id: string): string[] {
  if (list.includes(id)) return list.filter((x) => x !== id);
  const next = [...list, id];
  return next.length > MAX_FAVORITES ? next.slice(next.length - MAX_FAVORITES) : next;
}

/** Pure reorder used by the toolbar's drag & drop. */
export function reorderFavorites(list: string[], from: number, to: number): string[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
