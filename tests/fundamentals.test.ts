/**
 * Phase-5 tests — market sessions (DST correctness, countdowns, overlaps)
 * and the economic-calendar normalizer / knowledge base / symbol maps.
 * Run: node --test tests/fundamentals.test.ts  (also picked up by npm test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sessionStates, currentOverlaps, activityLabel, sessionWindows24h,
  tzWallClock, tzOffsetMs, fmtCountdown,
} from "../shared/sessions.ts";
import {
  normalizeFfCalendar, normalizeFfEvent, countryMeta, symbolCurrencies,
  symbolNewsTags, newsCategories, eventKnowledge,
} from "../shared/econ.ts";

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

// Fixed instants (UTC):
const TUE_2026 = Date.UTC(2026, 10, 17, 9, 0, 0); // Tue 2026-11-17 09:00 UTC
const SAT = Date.UTC(2026, 10, 21, 12, 0, 0);     // Sat 2026-11-21 12:00 UTC

test("sessions: wall clock in known zones", () => {
  const w = tzWallClock("Asia/Tokyo", TUE_2026); // UTC+9, no DST
  assert.equal(w.h, 18);
  assert.equal(w.weekday, 2); // Tuesday
  const off = tzOffsetMs("Asia/Tokyo", TUE_2026);
  assert.equal(off, 9 * 3600000);
});

test("sessions: London state on a Tuesday morning (UTC 09:00 = BST over? Nov → GMT)", () => {
  const st = sessionStates(TUE_2026).find((s) => s.def.id === "london")!;
  // November → London is GMT (UTC+0): 09:00 local → inside 08:00-17:00 → open
  assert.equal(st.open, true);
  assert.equal(st.nextKind, "close");
  // next close is today 17:00 local = 17:00 UTC (GMT in November)
  assert.equal(st.nextAt, Date.UTC(2026, 10, 17, 17, 0, 0));
});

test("sessions: New York closed before open, next open respects DST (EST UTC-5 in Nov)", () => {
  const st = sessionStates(TUE_2026).find((s) => s.def.id === "newyork")!;
  // 09:00 UTC = 04:00 EST → closed, opens today 08:00 EST = 13:00 UTC
  assert.equal(st.open, false);
  assert.equal(st.nextKind, "open");
  assert.equal(st.nextAt, Date.UTC(2026, 10, 17, 13, 0, 0));
});

test("sessions: weekend → all closed, next open is Monday", () => {
  const states = sessionStates(SAT);
  for (const s of states) {
    assert.equal(s.open, false, `${s.def.id} must be closed on Saturday`);
    assert.equal(s.nextKind, "open");
  }
  // Sydney Monday 07:00 local (UTC+11 in Nov) = Sun 20:00 UTC
  const syd = states.find((s) => s.def.id === "sydney")!;
  assert.equal(syd.nextAt, Date.UTC(2026, 10, 22, 20, 0, 0));
});

test("sessions: Friday evening → next open skips the weekend (London)", () => {
  // Fri 2026-11-20 18:00 UTC = 18:00 London (GMT) → after Friday close (17:00)
  const fri = Date.UTC(2026, 10, 20, 18, 0, 0);
  const st = sessionStates(fri).find((s) => s.def.id === "london")!;
  assert.equal(st.open, false);
  // Monday 2026-11-23 08:00 GMT = 08:00 UTC
  assert.equal(st.nextAt, Date.UTC(2026, 10, 23, 8, 0, 0));
});

test("sessions: DST spring shift — London late March is BST (UTC+1)", () => {
  // Wed 2026-04-01 07:30 UTC = 08:30 BST → open
  const st = sessionStates(Date.UTC(2026, 3, 1, 7, 30, 0)).find((s) => s.def.id === "london")!;
  assert.equal(st.open, true);
  // close today 17:00 BST = 16:00 UTC
  assert.equal(st.nextAt, Date.UTC(2026, 3, 1, 16, 0, 0));
});

test("sessions: overlaps — London × New York flagged as flagship on a Tuesday 14:00 UTC", () => {
  // Tue 14:00 UTC Nov: London 14:00 open, NY 09:00 EST open → overlap
  const t = Date.UTC(2026, 10, 17, 14, 0, 0);
  const ov = currentOverlaps(t);
  const flagship = ov.find((o) => o.flagship);
  assert.ok(flagship, "london × newyork overlap must exist");
  const a = activityLabel(2);
  assert.equal(a.label, "Active");
});

test("sessions: 24h windows produce sane bounds for every session", () => {
  const wins = sessionWindows24h(TUE_2026);
  assert.equal(wins.length, 4);
  for (const w of wins) {
    assert.ok(w.start <= w.end, "window start before end");
    assert.ok(w.end - w.start >= 8 * 3600000, "session window at least 8h");
    assert.ok(w.start >= TUE_2026 - 86400000, "window not in the far past");
  }
});

test("sessions: countdown formatter", () => {
  assert.equal(fmtCountdown(3725000), "1h 02m 05s");
  assert.equal(fmtCountdown(125000), "2m 05s");
});

// ---------------------------------------------------------------------------
// econ normalizer
// ---------------------------------------------------------------------------

test("calendar: normalizeFfCalendar keeps all impacts, maps country→currency, dedupes, sorts", () => {
  const raw = [
    { title: "CPI m/m", country: "US", date: "2026-11-18T08:30:00-05:00", impact: "High", forecast: "0.2%", previous: "0.1%", actual: "0.3%" },
    { title: "Retail Sales", country: "US", date: "2026-11-18T08:30:00-05:00", impact: "Medium", forecast: "0.4%", previous: "0.5%" },
    { title: "CPI m/m", country: "US", date: "2026-11-18T08:30:00-05:00", impact: "High", forecast: "0.2%", previous: "0.1%" }, // dup
    { title: "", country: "EU", date: "2026-11-19T10:00:00+01:00", impact: "Low" }, // unusable
    { title: "Bank Holiday", country: "GB", date: "2026-11-20T00:00:00+00:00", impact: "Holiday" },
  ];
  const { events, ok } = normalizeFfCalendar(raw);
  assert.equal(ok, true);
  assert.equal(events.length, 3); // dup + unusable dropped
  const cpi = events[0];
  assert.equal(cpi.currency, "USD");
  assert.equal(cpi.flag, "🇺🇸");
  assert.equal(cpi.impact, "High");
  assert.equal(cpi.actual, "0.3%");
  assert.equal(events[2].impact, "Holiday");
  assert.ok(events[0].date < events[2].date, "sorted by time");
});

test("calendar: offset dates convert to the correct absolute instant", () => {
  const ev = normalizeFfEvent({ title: "ECB Rate", country: "EU", date: "2026-11-19T14:15:00+01:00", impact: "High" });
  assert.ok(ev);
  assert.equal(ev.date, Date.UTC(2026, 10, 19, 13, 15, 0)); // 14:15 CET = 13:15 UTC
});

test("calendar: unknown country falls back to its code", () => {
  const meta = countryMeta("ZZ");
  assert.equal(meta.currency, "ZZ");
});

// ---------------------------------------------------------------------------
// symbol maps + news categories
// ---------------------------------------------------------------------------

test("symbol maps: currencies and news tags per instrument", () => {
  assert.deepEqual(symbolCurrencies("XAUUSD"), ["USD"]);
  assert.deepEqual(symbolCurrencies("EURUSD"), ["EUR", "USD"]);
  assert.deepEqual(symbolCurrencies("USDJPY"), ["USD", "JPY"]);
  assert.deepEqual(symbolCurrencies("GER40"), ["EUR"]);
  assert.deepEqual(symbolCurrencies("BTCUSD"), ["USD"]);
  assert.deepEqual(symbolNewsTags("XAUUSD"), ["XAUUSD", "USD"]);
  assert.deepEqual(symbolNewsTags("BTCUSD"), ["BTC", "USD"]);
  assert.deepEqual(symbolNewsTags("NAS100"), ["NASDAQ", "USD"]);
  assert.deepEqual(symbolNewsTags("USDCHF"), ["USD"]);
});

test("news categories: keyword buckets, several per story, sane fallback", () => {
  const fedGold = newsCategories({ title: "Gold surges as the Fed signals slower rate hikes", summary: "" });
  assert.ok(fedGold.includes("Gold") && fedGold.includes("USD & Fed"));
  const ecb = newsCategories({ title: "ECB officials split on the pace of cuts", summary: "" });
  assert.ok(ecb.includes("EUR & ECB"));
  const fallback = newsCategories({ title: "Totally unclassifiable headline xyzzy", summary: "", symbols: ["XAUUSD"] });
  assert.deepEqual(fallback, ["Gold"]);
});

// ---------------------------------------------------------------------------
// knowledge base
// ---------------------------------------------------------------------------

test("event knowledge: matches common release types, labels everything", () => {
  const nfp = eventKnowledge("Non-Farm Employment Change");
  assert.ok(nfp && nfp.key === "nfp");
  assert.ok(nfp.affects.includes("USD"));
  const cpi = eventKnowledge("CPI y/y");
  assert.ok(cpi && cpi.key === "cpi");
  const decision = eventKnowledge("Interest Rate Decision");
  assert.ok(decision && decision.key === "rate-decision");
  assert.equal(eventKnowledge("Totally bespoke survey"), null);
});
