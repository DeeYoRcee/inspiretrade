/**
 * market-sessions — P56 §4/§6: DST-correct FX session windows.
 *
 * Definitions (standard FX convention, wall-clock in each zone so daylight
 * saving is handled by the tz database, never a fixed UTC offset):
 *   Tokyo/Asian — 09:00–18:00 Asia/Tokyo
 *   London      — 08:00–17:00 Europe/London
 *   New York    — 08:00–17:00 America/New_York
 *
 * Pure module (node --test loadable): `zoneWallTimeToUtc` resolves a zone's
 * wall-clock on a calendar day to a UTC instant with the two-pass Intl trick.
 */

export type SessionId = "tokyo" | "london" | "newyork";

export interface SessionWindow {
  id: SessionId;
  label: string;
  tz: string;
  /** wall-clock open/close minutes from midnight in the session zone */
  fromMin: number;
  toMin: number;
}

export const SESSION_WINDOWS: SessionWindow[] = [
  { id: "tokyo", label: "Tokyo", tz: "Asia/Tokyo", fromMin: 9 * 60, toMin: 18 * 60 },
  { id: "london", label: "London", tz: "Europe/London", fromMin: 8 * 60, toMin: 17 * 60 },
  { id: "newyork", label: "New York", tz: "America/New_York", fromMin: 8 * 60, toMin: 17 * 60 },
];

export interface SessionInfo extends SessionWindow {
  /** UTC boundaries of TODAY's calendar session in its own zone */
  todayStartUtc: number;
  todayEndUtc: number;
  /** display window used for session H/L: yesterday's window while today's
   *  has not opened yet (the FX day is still running on it), else today's */
  startUtc: number;
  endUtc: number;
  open: boolean;
  /** next future start — today's start if still ahead, else tomorrow's */
  nextStartUtc: number;
}

/** minutes-of-day for a zone at instant `ts` (DST-aware) */
export function zoneMinutesOfDay(tz: string, ts: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ts));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}

/** the zone's calendar date (Y-M-D) at instant `ts` */
function zoneDateKey(tz: string, ts: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ts));
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const mo = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${mo}-${d}`;
}

/** the zone's wall-clock as a UTC ms value (the wall time mapped naively onto
 *  the UTC timeline) — used as the fixed target for resolution */
function zoneShift(tz: string, ts: number): number {
  const mins = zoneMinutesOfDay(tz, ts);
  const day = zoneDateKey(tz, ts);
  const [y, mo, d] = day.split("-").map(Number);
  return Date.UTC(y, mo - 1, d, Math.floor(mins / 60), mins % 60);
}

/** UTC instant for wall-clock `minutes` on `dateKey` in `tz` — iterative
 *  refinement against the tz database (converges in ≤2 passes through every
 *  real DST transition; no fixed UTC offsets anywhere) */
export function zoneWallTimeToUtc(tz: string, dateKey: string, minutes: number): number {
  const target = Date.UTC(Number(dateKey.slice(0, 4)), Number(dateKey.slice(5, 7)) - 1, Number(dateKey.slice(8, 10)), Math.floor(minutes / 60), minutes % 60);
  let utc = target;
  for (let i = 0; i < 3; i++) {
    const wall = zoneShift(tz, utc);
    utc = utc - (wall - target);
  }
  return utc;
}

/** the three sessions whose UTC windows bracket/precede `ts` (today in each
 *  session's own zone). FX sessions roll on their LOCAL date. */
export function sessionsFor(ts: number = Date.now()): SessionInfo[] {
  return SESSION_WINDOWS.map((w) => {
    const dateKey = zoneDateKey(w.tz, ts);
    const todayStartUtc = zoneWallTimeToUtc(w.tz, dateKey, w.fromMin);
    const todayEndUtc = zoneWallTimeToUtc(w.tz, dateKey, w.toMin);
    const open = ts >= todayStartUtc && ts < todayEndUtc;
    // H/L display: before today's local open the FX day still rides on
    // yesterday's session window
    const useYesterday = ts < todayStartUtc;
    const yKey = zoneDateKey(w.tz, todayStartUtc - 86400_000);
    const startUtc = useYesterday ? zoneWallTimeToUtc(w.tz, yKey, w.fromMin) : todayStartUtc;
    const endUtc = useYesterday ? zoneWallTimeToUtc(w.tz, yKey, w.toMin) : todayEndUtc;
    const nextStartUtc = useYesterday ? todayStartUtc : todayEndUtc <= ts ? todayStartUtc + 86400_000 : todayStartUtc;
    return { ...w, todayStartUtc, todayEndUtc, startUtc, endUtc, open, nextStartUtc };
  });
}

export function activeSession(ts: number = Date.now()): SessionInfo | null {
  return sessionsFor(ts).find((s) => s.open) ?? null;
}

/** soonest future session start after `ts` (ms + label), null = none today */
export function nextSessionStart(ts: number = Date.now()): { id: SessionId; label: string; at: number } | null {
  const sessions = sessionsFor(ts);
  const future = sessions.filter((s) => s.nextStartUtc > ts).sort((a, b) => a.nextStartUtc - b.nextStartUtc);
  if (future.length) return { id: future[0].id, label: future[0].label, at: future[0].nextStartUtc };
  return null;
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
