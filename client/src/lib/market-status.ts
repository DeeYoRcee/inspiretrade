/**
 * market-status — pure session-window logic for the instrument explorer,
 * watchlist and info panel. Real exchange hours; no invented data:
 *  · crypto trades 24/7 → always open
 *  · forex + metals: the spot week runs Sun 22:00 UTC → Fri 21:00 UTC
 *    (the same convention the spot recorder uses)
 *  · indices: real exchange regular-hours windows in the exchange's own
 *    timezone (DST-safe via Intl)
 */
import { getInstrument } from "../../../shared/terminal.ts";

export type MarketStatus = "open" | "closed";

const INDEX_SESSIONS: Record<string, { tz: string; fromMin: number; toMin: number }> = {
  NAS100: { tz: "America/New_York", fromMin: 9 * 60 + 30, toMin: 16 * 60 },
  US30: { tz: "America/New_York", fromMin: 9 * 60 + 30, toMin: 16 * 60 },
  SPX500: { tz: "America/New_York", fromMin: 9 * 60 + 30, toMin: 16 * 60 },
  GER40: { tz: "Europe/Berlin", fromMin: 9 * 60, toMin: 17 * 60 + 30 },
  UK100: { tz: "Europe/London", fromMin: 8 * 60, toMin: 16 * 60 + 30 },
};

const DOW_BY_NAME: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** weekday (0=Sun) + minute-of-day in an IANA timezone (DST-safe). */
export function zonedParts(tz: string, at: number): { dow: number; min: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const parts: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(at))) parts[p.type] = p.value;
  let min = Number(parts.hour) * 60 + Number(parts.minute);
  if (!Number.isFinite(min)) min = 0;
  if (min === 24 * 60) min = 0; // some runtimes render midnight as "24:00"
  return { dow: DOW_BY_NAME[String(parts.weekday)] ?? 0, min };
}

export function marketStatus(symbol: string, at: number = Date.now()): MarketStatus {
  const inst = getInstrument(symbol);
  if (!inst) return "closed";
  if (inst.assetClass === "crypto") return "open";
  if (inst.assetClass === "index") {
    const s = INDEX_SESSIONS[symbol];
    if (!s) return "closed";
    const { dow, min } = zonedParts(s.tz, at);
    if (dow === 0 || dow === 6) return "closed";
    return min >= s.fromMin && min < s.toMin ? "open" : "closed";
  }
  // forex + metals: Sun 22:00 UTC → Fri 21:00 UTC (spot convention)
  const d = new Date(at);
  const dow = d.getUTCDay();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (dow === 6) return "closed"; // Saturday
  if (dow === 5) return mins < 21 * 60 ? "open" : "closed"; // Friday until 21:00 UTC
  if (dow === 0) return mins >= 22 * 60 ? "open" : "closed"; // Sunday from 22:00 UTC
  return "open";
}
