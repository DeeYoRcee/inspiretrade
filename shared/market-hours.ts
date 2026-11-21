/**
 * Phase 27 — authoritative market-session hours.
 *
 * The single source of truth for "can this instrument be traded right now?"
 * Shared by the backend order guard (api/_src/trading) and the client UI
 * (watchlist dots, trading panel banner, chart honesty badge).
 *
 * Forex/metals convention (America/New_York wall clock, DST-correct via the
 * IANA database — never a fixed UTC offset):
 *   · FX week:  Sunday 17:00 NY → Friday 17:00 NY, continuous sessions.
 *   · Metals (CME): Sunday 18:00 NY → Friday 17:00 NY with a DAILY pause
 *     17:00–18:00 NY (instrument-specific refinement — the FX week is
 *     continuous Mon–Thu, metals are not).
 *   · Saturday: fully closed.
 * Crypto trades 24/7 — weekend restrictions must never apply to it.
 * Indices keep their real exchange regular-hours windows (own timezone).
 *
 * §7 holidays: NO holiday data exists for this deployment, so none is
 * invented — the HOLIDAY table stays empty and the "holiday" reason is
 * reserved for future verified schedules. Regular weekend closures are
 * always distinguishable from holiday closures via the `reason` field.
 */
import { tzWallClock } from "./sessions.ts";
import { getInstrument } from "./terminal.ts";

export type MarketClosedReason = "open" | "weekend" | "daily-break" | "holiday" | "unknown";

export interface MarketHours {
  open: boolean;
  /** why: "weekend" | "daily-break" | "holiday" | "unknown" — drives UI copy */
  reason: MarketClosedReason;
  /** next opening instant (ms) in UTC, or null when open / unknown */
  nextOpenMs: number | null;
}

/** §7: deliberately empty — never invent holiday schedules without data.
 *  Keys: instrument symbol → array of ISO dates ("YYYY-MM-DD") fully closed. */
const HOLIDAYS: Record<string, string[]> = {};

const NY = "America/New_York";
/** FX opens Sun 17:00 NY · closes Fri 17:00 NY. */
const FX_OPEN_DOW = 0; // Sunday
const FX_OPEN_MIN = 17 * 60;
const FX_CLOSE_DOW = 5; // Friday
const FX_CLOSE_MIN = 17 * 60;
/** CME metals: open Sun 18:00 NY, daily pause 17:00–18:00 NY Mon–Thu. */
const METAL_OPEN_MIN = 18 * 60;
const METAL_BREAK_FROM = 17 * 60;
const METAL_BREAK_TO = 18 * 60;

const INDEX_SESSIONS: Record<string, { tz: string; fromMin: number; toMin: number }> = {
  NAS100: { tz: "America/New_York", fromMin: 9 * 60 + 30, toMin: 16 * 60 },
  US30: { tz: "America/New_York", fromMin: 9 * 60 + 30, toMin: 16 * 60 },
  SPX500: { tz: "America/New_York", fromMin: 9 * 60 + 30, toMin: 16 * 60 },
  GER40: { tz: "Europe/Berlin", fromMin: 9 * 60, toMin: 17 * 60 + 30 },
  UK100: { tz: "Europe/London", fromMin: 8 * 60, toMin: 16 * 60 + 30 },
};

function isHoliday(symbol: string, at: number): boolean {
  const days = HOLIDAYS[symbol];
  if (!days || !days.length) return false;
  const d = tzWallClock("UTC", at);
  const iso = `${String(d.y).padStart(4, "0")}-${String(d.mo).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  return days.includes(iso);
}

/** Pure session window for FX/metals in the NY wall clock (DST-safe).
 *  No next-open computation inside — that lives in nextOpen() to keep
 *  marketHours ↔ nextOpen free of mutual recursion. */
function fxWindow(inst: { assetClass: string }, at: number): { open: boolean; reason: MarketClosedReason } {
  const w = tzWallClock(NY, at);
  const mins = w.h * 60 + w.mi;
  const metal = inst.assetClass === "metal";
  if (w.weekday === 6) return { open: false, reason: "weekend" }; // Saturday
  if (w.weekday === FX_CLOSE_DOW && mins >= FX_CLOSE_MIN) return { open: false, reason: "weekend" };
  if (w.weekday === FX_OPEN_DOW && mins < (metal ? METAL_OPEN_MIN : FX_OPEN_MIN)) {
    return { open: false, reason: "weekend" };
  }
  // metals-only daily maintenance pause 17:00–18:00 NY (Mon–Thu; Friday ≥17:00
  // is already the weekend close above)
  if (metal && w.weekday >= 1 && w.weekday <= 4 && mins >= METAL_BREAK_FROM && mins < METAL_BREAK_TO) {
    return { open: false, reason: "daily-break" };
  }
  return { open: true, reason: "open" };
}

/** Instrument class → session-window check WITHOUT next-open resolution. */
function windowAt(symbol: string, inst: { assetClass: string } | undefined, at: number): { open: boolean; reason: MarketClosedReason } {
  if (!inst) return { open: false, reason: "unknown" }; // unknown symbol: closed (phase 21 contract — a watchlist dot must never fake green)
  if (inst.assetClass === "crypto") return { open: true, reason: "open" };
  if (isHoliday(symbol, at)) return { open: false, reason: "holiday" };
  if (inst.assetClass === "index") {
    const s = INDEX_SESSIONS[symbol];
    if (!s) return { open: true, reason: "open" }; // no invented restriction
    const w = tzWallClock(s.tz, at);
    const mins = w.h * 60 + w.mi;
    const open = w.weekday >= 1 && w.weekday <= 5 && mins >= s.fromMin && mins < s.toMin;
    return { open, reason: open ? "open" : "weekend" };
  }
  if (inst.assetClass === "forex" || inst.assetClass === "metal") return fxWindow(inst, at);
  // unknown asset class: never block trading on an invented schedule
  return { open: true, reason: "open" };
}

/**
 * Is `symbol` tradable at instant `at`? Pure + injectable clock → the whole
 * Phase 27 §8 scenario matrix is unit-testable without waiting for Saturday.
 */
export function marketHours(symbol: string, at: number = Date.now()): MarketHours {
  const inst = getInstrument(symbol);
  const w = windowAt(symbol, inst, at);
  return { ...w, nextOpenMs: w.open ? null : nextOpen(symbol, at) };
}

/** Next opening instant (ms) — 15-minute forward scan over the pure window
 *  check, bounded ~9 days (the longest closure is the 64h weekend, so the
 *  bound can never be hit). No marketHours() calls → no recursion. */
export function nextOpen(symbol: string, at: number = Date.now()): number | null {
  const inst = getInstrument(symbol);
  if (windowAt(symbol, inst, at).open) return null; // already open — no next open
  const step = 15 * 60000;
  for (let t = Math.ceil(at / step) * step, n = 0; n < 9 * 96; n++, t += step) {
    if (windowAt(symbol, inst, t).open) return t;
  }
  return null;
}

/** Backend guard: throws the Phase 27 §2 contract error when closed. */
export function marketOpenOrThrow(symbol: string, at: number = Date.now()): void {
  const mh = marketHours(symbol, at);
  if (!mh.open) {
    throw new Error(`MARKET_CLOSED: Trading is unavailable for this instrument at the moment.`);
  }
}
