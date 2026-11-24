/**
 * P77 — XAUUSD data-accuracy guards. The Dukascopy tail merge must keep every
 * recorded observation genuine: only REAL provider minutes, minute-aligned
 * UTC, sane OHLC envelope, inside the price band, never the future. The union
 * merge must never lose the recorder's open/samples and must widen the H/L
 * envelope with the provider's real extremes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDukaTailBars, validateBars } from "../shared/feed-validation.ts";
import { recordSpotTick, mergeSpotSeries, validSpotCandle, type SpotCandle } from "../client/src/lib/spot-tail.ts";

const NOW = 1795540800; // 2026-11-24 ~17:20 UTC (market open, Tuesday)
const BAND: [number, number] = [1000, 20000];

const mk = (t: number, o: number, h: number, l: number, c: number) => ({ time: t, open: o, high: h, low: l, close: c });

test("duka tail: accepts genuine minute bars inside the band", () => {
  const r = validateDukaTailBars(
    [mk(NOW - 300, 3560, 3561.5, 3559.2, 3560.9), mk(NOW - 240, 3560.9, 3562.1, 3560.4, 3561.7)],
    NOW, BAND,
  );
  assert.equal(r.rejected, 0);
  assert.equal(r.bars.length, 2);
  assert.equal(r.bars[0].volume, 0); // provider-origin convention
});

test("duka tail: rejects future, misaligned, garbage and out-of-band bars", () => {
  const r = validateDukaTailBars(
    [
      mk(NOW + 120, 3560, 3561, 3559, 3560),          // future minute
      mk(NOW - 131, 3560, 3561, 3559, 3560),          // not minute-aligned
      mk(NOW - 180, 3560, 3559, 3561, 3560),          // h < max(o,c) envelope violation
      mk(NOW - 240, 3.5, 4.5, 3.2, 4.0),              // outside the XAU band (another instrument)
      mk(NaN as any, 1, 2, 0.5, 1.5),                 // garbage
      mk(NOW - 90 * 86400, 3560, 3561, 3559, 3560),   // beyond the 2-day depth
    ],
    NOW, BAND,
  );
  assert.equal(r.bars.length, 0);
  assert.equal(r.rejected, 6);
});

test("duka tail: union merge keeps the recorder's open and widens H/L only", () => {
  const rec: SpotCandle = { t: NOW - 300, o: 3560.10, h: 3560.90, l: 3559.40, c: 3560.50, s: 2 };
  const duka: SpotCandle = { t: NOW - 300, o: 3559.95, h: 3561.80, l: 3559.10, c: 3560.70, s: 0 };
  const merged = mergeSpotSeries([rec], [duka]);
  assert.equal(merged.length, 1);
  const m = merged[0];
  assert.equal(m.o, 3560.10); // earliest open preserved (recorder)
  assert.equal(m.h, 3561.80); // real provider extreme joins the envelope
  assert.equal(m.l, 3559.10);
  assert.equal(m.c, 3560.70); // the later writer's close (duka final tick)
  assert.equal(m.s, 2);       // recorder sample count preserved
  assert.ok(validSpotCandle(m, NOW));
});

test("duka tail: the merged bars pass the shared validateBars pipeline", () => {
  const duka = [mk(NOW - 300, 3560, 3561.5, 3559.2, 3560.9), mk(NOW - 240, 3560.9, 3562.1, 3560.4, 3561.7)];
  const { bars } = validateDukaTailBars(duka, NOW, BAND);
  const checked = validateBars(bars.map((b) => ({ ...b, volume: b.volume })));
  assert.equal(checked.bars.length, 2);
});

test("spot recorder: open is the first observed price, close the latest, high/low run", () => {
  let m: SpotCandle | null = null;
  for (const p of [3560.2, 3561.9, 3559.8, 3560.7]) m = recordSpotTick(m, p, NOW - 30);
  assert.ok(m);
  assert.equal(m.o, 3560.2);
  assert.equal(m.h, 3561.9);
  assert.equal(m.l, 3559.8);
  assert.equal(m.c, 3560.7);
  assert.equal(m.s, 4);
  // minute rollover opens a NEW candle at the real bucket boundary
  const next = recordSpotTick(m, 3560.5, NOW + 45);
  assert.equal(next.t, Math.floor((NOW + 45) / 60) * 60);
  assert.equal(next.o, 3560.5);
  assert.notEqual(next.t, m.t);
});
