/**
 * P76 — bar-replay playback primitives (pure logic from shared/replay-engine).
 * These encode the TradingView-style contract the chart-integrated replay UI
 * depends on: speed options, ticks-to-candles math, and starting-point
 * validation (no future candles, no beyond-history starts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REPLAY_SPEED_OPTIONS, speedBarsPerTick, REPLAY_TICK_MS, BAR_MS_AT_1X,
  validateReplayStart,
} from "../shared/replay-engine.ts";

test("replay speeds: exactly the TradingView set 0.5..10", () => {
  assert.deepEqual([...REPLAY_SPEED_OPTIONS], [0.5, 1, 2, 3, 5, 10]);
});

test("replay speeds: 1x reveals one candle every 2 seconds", () => {
  const barsPerTick = speedBarsPerTick(1);
  const msPerCandle = REPLAY_TICK_MS / barsPerTick; // ms per full candle
  assert.equal(msPerCandle, BAR_MS_AT_1X);
  assert.equal(msPerCandle, 2000);
});

test("replay speeds: 0.5x is exactly half the rate of 1x", () => {
  assert.equal(speedBarsPerTick(0.5), speedBarsPerTick(1) / 2);
});

test("replay speeds: 10x reveals a candle every 200ms", () => {
  assert.equal(speedBarsPerTick(10), 0.5); // 0.5 candles per 100ms tick
});

test("replay start validation: rejects future and invalid candles", () => {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  assert.ok(validateReplayStart(nowSec + 3600, 300, null, now)?.includes("future"));
  assert.ok(validateReplayStart(0, 300, null, now)?.includes("candle"));
  assert.ok(validateReplayStart(NaN, 300, null, now) != null);
  assert.ok(validateReplayStart(-5, 300, null, now) != null);
});

test("replay start validation: rejects candles older than the provider window", () => {
  const now = Date.now();
  const tooOld = Math.floor(now / 1000) - 40 * 86400; // 40 days back
  const ok = Math.floor(now / 1000) - 10 * 86400;     // 10 days back
  assert.ok(validateReplayStart(tooOld, 300, 30, now)?.includes("provider"));
  assert.equal(validateReplayStart(ok, 300, 30, now), null);
});

test("replay start validation: passes for any past candle with unlimited history", () => {
  const now = Date.now();
  const past = Math.floor(now / 1000) - 300 * 86400;
  assert.equal(validateReplayStart(past, 3600, null, now), null);
});

test("replay start validation: current forming candle (last tf slot) is future", () => {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  // a candle opened less than one tf ago has not closed yet
  assert.ok(validateReplayStart(nowSec - 60, 300, null, now)?.includes("future"));
});
