/**
 * Market sessions (Phase 5) — Sydney / Tokyo / London / New York.
 *
 * Pure, timezone-correct computation over Intl (no libraries): session
 * windows are defined in each city's LOCAL wall clock, so DST transitions are
 * handled automatically by the IANA tz database. All functions take an
 * explicit `now` instant, which makes them unit-testable.
 */

export interface SessionDef {
  id: string;
  city: string;
  tz: string;
  flag: string;
  /** session window in local wall-clock minutes from midnight */
  openMin: number;
  closeMin: number;
}

export const SESSIONS: SessionDef[] = [
  { id: "sydney", city: "Sydney", tz: "Australia/Sydney", flag: "🇦🇺", openMin: 7 * 60, closeMin: 16 * 60 },
  { id: "tokyo", city: "Tokyo", tz: "Asia/Tokyo", flag: "🇯🇵", openMin: 9 * 60, closeMin: 18 * 60 },
  { id: "london", city: "London", tz: "Europe/London", flag: "🇬🇧", openMin: 8 * 60, closeMin: 17 * 60 },
  { id: "newyork", city: "New York", tz: "America/New_York", flag: "🇺🇸", openMin: 8 * 60, closeMin: 17 * 60 },
];

export interface WallClock {
  y: number; mo: number; d: number; h: number; mi: number; s: number;
  /** 0 = Sunday … 6 = Saturday (local to the zone) */
  weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Local wall-clock parts of an instant in a zone. */
export function tzWallClock(tz: string, instant: number): WallClock {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, weekday: "short",
  });
  const parts = dtf.formatToParts(new Date(instant));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const h = Number(get("hour")) % 24; // en-US can yield "24" at midnight
  return {
    y: Number(get("year")), mo: Number(get("month")), d: Number(get("day")),
    h, mi: Number(get("minute")), s: Number(get("second")),
    weekday: Math.max(0, WEEKDAYS.indexOf(get("weekday"))),
  };
}

/** Offset (ms) of a zone at an instant: wallClockAsUTC − instant. */
export function tzOffsetMs(tz: string, instant: number): number {
  const w = tzWallClock(tz, instant);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - instant;
}

/**
 * Find the instant whose wall clock in `tz` equals the given local date +
 * minutes-from-midnight. Two refinement passes converge across DST jumps.
 */
function instantForWall(tz: string, y: number, mo: number, d: number, minutes: number): number {
  const midnightUtc = Date.UTC(y, mo - 1, d);
  let guess = midnightUtc - tzOffsetMs(tz, midnightUtc) + minutes * 60000;
  guess = midnightUtc - tzOffsetMs(tz, guess) + minutes * 60000;
  return guess;
}

function isWeekend(w: WallClock): boolean {
  return w.weekday === 0 || w.weekday === 6;
}

export type SessionState = {
  def: SessionDef;
  /** session currently trading? */
  open: boolean;
  /** next open/close transition (epoch ms) */
  nextAt: number;
  nextKind: "open" | "close";
};

function nextWeekdayFrom(tz: string, now: number, startDayOff: number): { y: number; mo: number; d: number } | null {
  for (let off = startDayOff; off <= startDayOff + 9; off++) {
    const w = tzWallClock(tz, now + off * 86400000);
    if (!isWeekend(w)) return { y: w.y, mo: w.mo, d: w.d };
  }
  return null;
}

function stateFor(def: SessionDef, now: number): SessionState {
  const w = tzWallClock(def.tz, now);
  const nowMin = w.h * 60 + w.mi;
  const weekend = isWeekend(w);
  const open = !weekend && nowMin >= def.openMin && nowMin < def.closeMin;

  if (open) {
    // next transition: today's close (openMin < closeMin always, no overnight windows)
    return { def, open, nextAt: instantForWall(def.tz, w.y, w.mo, w.d, def.closeMin), nextKind: "close" };
  }
  // closed — next open: today (if weekday, before open) or the next weekday
  const day = weekend ? nextWeekdayFrom(def.tz, now, 1) : (nowMin < def.openMin ? { y: w.y, mo: w.mo, d: w.d } : nextWeekdayFrom(def.tz, now, 1));
  if (!day) return { def, open, nextAt: now + 86400000, nextKind: "open" };
  return { def, open, nextAt: instantForWall(def.tz, day.y, day.mo, day.d, def.openMin), nextKind: "open" };
}

/** All four sessions with open/close state + next transition. */
export function sessionStates(now: number): SessionState[] {
  return SESSIONS.map((s) => stateFor(s, now));
}

export interface OverlapInfo {
  a: string;
  b: string;
  /** the London/New York flagship overlap gets special treatment in the UI */
  flagship: boolean;
}

/** Sessions trading at the same moment right now. */
export function currentOverlaps(now: number, states?: SessionState[]): OverlapInfo[] {
  const st = states ?? sessionStates(now);
  const openIds = st.filter((s) => s.open).map((s) => s.def.id);
  const out: OverlapInfo[] = [];
  for (let i = 0; i < openIds.length; i++) {
    for (let j = i + 1; j < openIds.length; j++) {
      out.push({
        a: openIds[i], b: openIds[j],
        flagship: (openIds[i] === "london" && openIds[j] === "newyork") || (openIds[i] === "newyork" && openIds[j] === "london"),
      });
    }
  }
  return out;
}

/** 0-4 open sessions → market activity label. */
export function activityLabel(openCount: number): { label: string; tone: "quiet" | "moderate" | "active" | "peak" } {
  if (openCount >= 3) return { label: "Peak liquidity", tone: "peak" };
  if (openCount === 2) return { label: "Active", tone: "active" };
  if (openCount === 1) return { label: "Moderate", tone: "moderate" };
  return { label: "Quiet", tone: "quiet" };
}

export interface SessionWindow {
  id: string;
  /** UTC epoch bounds of the current or next trading window */
  start: number;
  end: number;
}

/**
 * For each session the CURRENT window (if open) or the NEXT window, as UTC
 * instants — used by the 24-hour timeline strip.
 */
export function sessionWindows24h(now: number): SessionWindow[] {
  const out: SessionWindow[] = [];
  for (const def of SESSIONS) {
    const st = stateFor(def, now);
    if (st.open) {
      const w = tzWallClock(def.tz, now);
      out.push({ id: def.id, start: instantForWall(def.tz, w.y, w.mo, w.d, def.openMin), end: st.nextAt });
    } else {
      // find the local date the next open lands on, close it on the same date
      const ow = tzWallClock(def.tz, st.nextAt);
      out.push({
        id: def.id,
        start: st.nextAt,
        end: instantForWall(def.tz, ow.y, ow.mo, ow.d, def.closeMin),
      });
    }
  }
  return out;
}

/** mm:ss-style countdown builder shared by the UI. */
export function fmtCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s` : `${m}m ${String(s).padStart(2, "0")}s`;
}
