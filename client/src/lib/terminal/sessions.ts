/**
 * Trading session math — Sydney / Tokyo / London / New York.
 *
 * Sessions are defined in the exchange's own local wall-clock time and
 * evaluated through the standard `Intl` timezone database, so daylight
 * saving transitions are handled automatically (no hardcoded UTC offsets).
 * All inputs/outputs are UNIX seconds (UTC), matching Bar.time.
 */

export interface SessionDef {
  id: "sydney" | "tokyo" | "london" | "newyork";
  label: string;
  tz: string;
  /** Local wall-clock open/close, "HH:MM" 24h */
  open: string;
  close: string;
}

export const SESSIONS: SessionDef[] = [
  { id: "sydney", label: "Sydney", tz: "Australia/Sydney", open: "07:00", close: "16:00" },
  { id: "tokyo", label: "Tokyo", tz: "Asia/Tokyo", open: "09:00", close: "18:00" },
  { id: "london", label: "London", tz: "Europe/London", open: "08:00", close: "17:00" },
  { id: "newyork", label: "New York", tz: "America/New_York", open: "08:00", close: "17:00" },
];

export function getSession(id: string): SessionDef | undefined {
  return SESSIONS.find((s) => s.id === id);
}

/** Wall-clock "HH:MM" of a UTC instant in a timezone (Intl handles DST). */
export function wallTime(utcSec: number, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(utcSec * 1000));
    const h = parts.find((p) => p.type === "hour")?.value ?? "00";
    const m = parts.find((p) => p.type === "minute")?.value ?? "00";
    return `${h}:${m}`;
  } catch {
    return "00:00";
  }
}

/** Is the UTC instant inside the session's local open..close window? */
export function isInSession(s: SessionDef, utcSec: number): boolean {
  const t = wallTime(utcSec, s.tz);
  if (s.open <= s.close) return t >= s.open && t < s.close;
  return t >= s.open || t < s.close; // window crosses local midnight
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * The session window that CONTAINS `nearSec`, or the NEXT upcoming window
 * when `nearSec` is off-session. Found by scanning 15-minute steps for the
 * local open/close edges (Intl timezone DB → DST-correct UTC instants).
 */
export function sessionBoundsUTC(s: SessionDef, nearSec: number): { openUTC: number; closeUTC: number } | null {
  const openMin = minutesOf(s.open);
  const closeMin = minutesOf(s.close);
  const daySec = 86400;
  const start = Math.floor(nearSec / daySec) * daySec - daySec;
  const opens: number[] = [];
  const closes: number[] = [];
  for (let t = start; t <= start + 4 * daySec; t += 900) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: s.tz, hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(t * 1000));
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    const wall = h * 60 + m;
    if (wall >= openMin && wall < openMin + 15) opens.push(t);
    if (wall >= closeMin && wall < closeMin + 15) closes.push(t);
  }
  if (!opens.length || !closes.length) return null;
  // pair every open with the first close after it
  const windows = opens.map((o) => ({ openUTC: o, closeUTC: closes.find((c) => c > o) ?? o + daySec }));
  const containing = windows.find((w) => w.openUTC <= nearSec && nearSec < w.closeUTC);
  if (containing) return containing;
  const next = windows.find((w) => w.openUTC > nearSec);
  return next ?? windows[windows.length - 1];
}

export interface SessionStats {
  session: SessionDef;
  openUTC: number;
  closeUTC: number;
  open: number;
  high: number;
  low: number;
  close: number;
  range: number;
}

/** High/low/range of the session window that contains `nearSec`. */
export function sessionStats(bars: { time: number; open: number; high: number; low: number; close: number }[], s: SessionDef, nearSec: number): SessionStats | null {
  const b = sessionBoundsUTC(s, nearSec);
  if (!b) return null;
  const inWin = bars.filter((x) => x.time >= b.openUTC && x.time < b.closeUTC);
  if (!inWin.length) return null;
  const high = Math.max(...inWin.map((x) => x.high));
  const low = Math.min(...inWin.map((x) => x.low));
  return {
    session: s, openUTC: b.openUTC, closeUTC: b.closeUTC,
    open: inWin[0].open, high, low, close: inWin[inWin.length - 1].close,
    range: high - low,
  };
}

/** Average session range (price units) over the last `days` calendar days. */
export function avgSessionRange(bars: { time: number; high: number; low: number }[], s: SessionDef, days = 10): number {
  const daySec = 86400;
  const today = Math.floor(Date.now() / 1000 / daySec) * daySec;
  let sum = 0, n = 0;
  for (let d = 1; d <= days; d++) {
    const st = sessionStats(bars as any, s, today - d * daySec + 43200);
    if (st) { sum += st.range; n++; }
  }
  return n ? sum / n : 0;
}

/** Previous trading day high/low from daily-aggregated bars. */
export function prevDayHighLow(bars: { time: number; high: number; low: number }[]): { high: number; low: number } | null {
  const daySec = 86400;
  const today = Math.floor(Date.now() / 1000 / daySec) * daySec;
  const prev = bars.filter((b) => b.time >= today - daySec && b.time < today);
  if (!prev.length) {
    // intraday feed: approximate with bars before today
    const before = bars.filter((b) => b.time < today);
    if (!before.length) return null;
    const last = before[before.length - 1];
    const sameDay = before.filter((b) => Math.floor(b.time / daySec) === Math.floor(last.time / daySec));
    if (!sameDay.length) return null;
    return { high: Math.max(...sameDay.map((x) => x.high)), low: Math.min(...sameDay.map((x) => x.low)) };
  }
  return { high: Math.max(...prev.map((x) => x.high)), low: Math.min(...prev.map((x) => x.low)) };
}

/** Previous ISO week (Mon 00:00 UTC .. Sun 24:00) high/low. */
export function prevWeekHighLow(bars: { time: number; high: number; low: number }[]): { high: number; low: number } | null {
  const daySec = 86400;
  const now = Date.now() / 1000;
  const dow = (Math.floor(now / daySec) + 4) % 7; // 0=Mon (epoch Thu → +4)
  const weekStart = Math.floor(now / daySec) * daySec - dow * daySec;
  const prev = bars.filter((b) => b.time >= weekStart - 7 * daySec && b.time < weekStart);
  if (!prev.length) return null;
  return { high: Math.max(...prev.map((x) => x.high)), low: Math.min(...prev.map((x) => x.low)) };
}

/** Next session transition info relative to now (UTC seconds). */
export function nextSessionChange(nowSec = Date.now() / 1000): { current: SessionDef | null; next: SessionDef; nextChangeUTC: number } {
  let current: SessionDef | null = null;
  for (const s of SESSIONS) if (isInSession(s, nowSec)) { current = s; break; }
  // soonest open/close edge across all sessions
  let best: { s: SessionDef; t: number } | null = null;
  for (const s of SESSIONS) {
    const b = sessionBoundsUTC(s, nowSec);
    if (!b) continue;
    const inside = isInSession(s, nowSec);
    const edges = inside ? [b.closeUTC] : [b.openUTC, b.closeUTC];
    for (const e of edges) {
      if (e > nowSec && (!best || e < best.t)) best = { s, t: e };
    }
  }
  if (!best) return { current, next: SESSIONS[0], nextChangeUTC: nowSec + 3600 };
  return { current, next: best.s, nextChangeUTC: best.t };
}

/** Format a UTC instant in a user-selected timezone ("HH:MM"). */
export function fmtInTz(utcSec: number, userTz: string): string {
  return wallTime(utcSec, userTz);
}

export const TIMEZONES = [
  "UTC", "Europe/London", "Europe/Berlin", "Europe/Istanbul", "Asia/Tashkent",
  "Asia/Dubai", "Asia/Tokyo", "Asia/Shanghai", "Australia/Sydney",
  "America/New_York", "America/Chicago", "America/Los_Angeles",
];
