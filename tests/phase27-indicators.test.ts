/**
 * Phase 27 — the 16 new indicator functions. Every expectation was produced
 * by an INDEPENDENT python implementation (scripts/gen_indicator_golden.py)
 * run on the same fixed 30-bar synthetic series — two code paths (TS + py)
 * must agree to 1e-6. Warm-up windows must be null, never 0 or fabricated.
 * Run: node --test tests/phase27-indicators.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  wma, hma, supertrend, donchian, keltner, psar, ichimoku, adx, williamsR,
  cci, stochRsi, mfi, obv, trix, awesomeOscillator, roc, type Point,
} from "../client/src/lib/indicators.ts";

const O = [10, 10.5, 11.2, 11.8, 12.3, 12.1, 11.6, 12.0, 12.8, 13.5, 14.2, 14.0, 13.4, 12.8, 12.2, 11.8, 12.4, 13.0, 13.2, 12.9, 12.5, 12.1, 11.7, 11.3, 11.0, 11.4, 11.9, 12.3, 12.6, 12.8];
const H = O.map((o) => o + 0.8);
const L = O.map((o) => o - 0.7);
const C = O.map((o) => o + 0.3);
const V = [100, 137, 174, 211, 248, 285, 322, 100, 137, 174, 211, 248, 285, 322, 100, 137, 174, 211, 248, 285, 322, 100, 137, 174, 211, 248, 285, 322, 100, 137];
const bars = O.map((open, i) => ({ time: i * 60, open, high: H[i], low: L[i], close: C[i], volume: V[i] }));

const GOLDEN: Record<string, Point[]> = {
  adx14: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 18.786805, 19.107583],
  adx5: [null, null, null, null, null, null, null, null, null, null, 69.61918, 69.292785, 61.51129, 49.584964, 43.665296, 41.357499, 33.658788, 30.814773, 29.874546, 25.730812, 22.750279, 23.687134, 27.177118, 32.217232, 37.695549, 35.631236, 29.140837, 27.694782, 28.935705, 31.427965],
  ao: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
  ao3_10: [null, null, null, null, null, null, null, null, null, 0.986667, 1.3, 1.35, 1.096667, 0.53, -0.06, -0.563333, -0.776667, -0.61, -0.183333, 0.043333, 0.046667, -0.13, -0.36, -0.61, -0.856667, -0.916667, -0.666667, -0.163333, 0.296667, 0.606667],
  cci5: [null, null, null, null, 104.395604, 59.360731, -41.666667, 12.820513, 136.752137, 122.222222, 111.650485, 64.814815, -28.846154, -125.0, -113.821138, -100.775194, -17.241379, 101.449275, 97.701149, 35.714286, -71.428571, -121.212121, -112.068966, -111.111111, -103.448276, -20.833333, 107.843137, 115.384615, 98.958333, 90.909091],
  don20_basis: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 12.15, 12.4, 12.75, 12.95, 12.8, 12.65, 12.65, 12.65, 12.65, 12.65, 12.65],
  don20_lower: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 9.3, 9.8, 10.5, 10.9, 10.6, 10.3, 10.3, 10.3, 10.3, 10.3, 10.3],
  don20_up: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 15.0, 15.0, 15.0, 15.0, 15.0, 15.0, 15.0, 15.0, 15.0, 15.0, 15.0],
  don5_basis: [null, null, null, null, 11.2, 11.45, 11.8, 12.0, 12.25, 12.6, 12.95, 13.15, 13.55, 13.55, 13.25, 12.95, 12.65, 12.45, 12.55, 12.55, 12.85, 12.7, 12.5, 12.15, 11.8, 11.6, 11.5, 11.7, 11.85, 12.15],
  don5_lower: [null, null, null, null, 9.3, 9.8, 10.5, 10.9, 10.9, 10.9, 10.9, 11.3, 12.1, 12.1, 11.5, 11.1, 11.1, 11.1, 11.1, 11.1, 11.7, 11.4, 11.0, 10.6, 10.3, 10.3, 10.3, 10.3, 10.3, 10.7],
  don5_up: [null, null, null, null, 13.1, 13.1, 13.1, 13.1, 13.6, 14.3, 15.0, 15.0, 15.0, 15.0, 15.0, 14.8, 14.2, 13.8, 14.0, 14.0, 14.0, 14.0, 14.0, 13.7, 13.3, 12.9, 12.7, 13.1, 13.4, 13.6],
  hma21: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 12.270182, 12.005911, 11.817408, 11.733714, 11.768012, 11.912877],
  ichi92652_k: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 12.15, 12.4, 12.65, 12.65, 12.65],
  ichi92652_sa: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 12.15, 12.275, 12.325, 12.25, 12.3],
  ichi92652_sb: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
  ichi92652_t: [null, null, null, null, null, null, null, null, 11.45, 12.05, 12.75, 12.95, 12.95, 12.95, 12.95, 13.05, 13.05, 13.05, 13.05, 12.95, 12.65, 12.55, 12.5, 12.3, 12.15, 12.15, 12.15, 12.0, 11.85, 11.95],
  ichi_k: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 12.15, 12.4, 12.65, 12.65, 12.65],
  ichi_sa: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 12.15, 12.275, 12.325, 12.25, 12.3],
  ichi_sb: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 12.15, 12.4, 12.65, 12.65, 12.65],
  ichi_t: [null, null, null, null, null, null, null, null, 11.45, 12.05, 12.75, 12.95, 12.95, 12.95, 12.95, 13.05, 13.05, 13.05, 13.05, 12.95, 12.65, 12.55, 12.5, 12.3, 12.15, 12.15, 12.15, 12.0, 11.85, 11.95],
  kelt_basis: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 12.685, 12.695952, 12.667766, 12.60417, 12.508534, 12.393436, 12.327394, 12.315262, 12.34238, 12.395486, 12.462583],
  kelt_lower: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 9.665952, 9.639266, 9.577095, 9.482813, 9.369001, 9.304181, 9.293209, 9.321429, 9.375584, 9.443675],
  kelt_upper: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 15.725952, 15.696266, 15.631245, 15.534256, 15.417871, 15.350608, 15.337314, 15.36333, 15.415389, 15.48149],
  mdi14: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, 12.676056, 13.662303, 12.698298, 11.801534, 10.967427, 11.606309, 12.672287, 13.663457, 14.584981, 15.441677, 15.76507, 14.646068, 13.606026, 12.639436, 11.741166, 10.906435],
  mdi5: [null, null, null, null, null, 2.666667, 8.8, 7.04, 5.632, 4.5056, 3.60448, 5.550251, 12.276514, 17.531407, 21.657149, 22.633638, 18.19924, 14.619028, 11.733672, 13.369499, 16.006443, 18.12404, 19.823291, 21.186015, 20.949638, 16.771387, 13.424592, 10.744467, 8.598644, 6.880881],
  mfi14: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, 46.510533, 42.417432, 42.735311, 43.116107, 43.44761, 43.190496, 42.868049, 39.73208, 35.305687, 29.46392, 21.953346, 30.072069, 39.807752, 50.986976, 54.426698, 59.068884],
  obv: [0.0, 137.0, 311.0, 522.0, 770.0, 485.0, 163.0, 263.0, 400.0, 574.0, 785.0, 537.0, 252.0, -70.0, -170.0, -307.0, -133.0, 78.0, 326.0, 41.0, -281.0, -381.0, -518.0, -692.0, -903.0, -655.0, -370.0, -48.0, 52.0, 189.0],
  pdi14: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, 23.004695, 21.383014, 22.696618, 23.918597, 23.170453, 21.531584, 20.00757, 18.590508, 17.273018, 16.048212, 14.909663, 15.744173, 16.993209, 17.680424, 17.845273, 17.5245],
  pdi5: [null, null, null, null, null, 30.666667, 24.533333, 24.96, 30.634667, 33.841067, 36.406187, 29.124949, 22.993381, 18.203093, 14.442124, 11.626968, 17.185831, 21.673907, 20.027729, 16.064434, 12.878716, 10.320427, 8.267547, 6.621226, 5.301591, 9.562698, 14.30622, 16.773896, 17.418195, 16.602157],
  psar: [null, 9.3, 9.3, 9.462, 9.71304, 10.051736, 10.356562, 10.630906, 10.877816, 11.204478, 11.637851, 12.175795, 12.627668, 15.0, 14.942, 14.80432, 14.582061, 14.373137, 14.176749, 14.0, 14.0, 13.826, 13.66244, 13.449445, 13.1645, 12.82076, 10.3, 10.348, 10.45808, 10.634595],
  roc9: [null, null, null, null, null, null, null, null, null, 33.980583, 34.259259, 24.347826, 13.22314, 3.968254, 0.806452, 1.680672, 3.252033, 1.526718, -2.173913, -8.965517, -10.48951, -9.489051, -8.396947, -7.2, -6.61157, -7.874016, -8.270677, -6.666667, -2.272727, 2.34375],
  srsi5_d: [null, null, null, null, null, null, null, null, null, null, null, 81.439326, 48.067925, 11.533962, 0.0, 0.0, 11.702771, 48.405542, 86.702771, 92.720736, 60.441472, 17.720736, 0.0, 0.0, 0.0, 25.0, 75.0, 100.0, 100.0, 100.0],
  srsi5_k: [null, null, null, null, null, null, null, null, null, null, 89.810727, 73.067925, 23.067925, 0.0, 0.0, 0.0, 23.405542, 73.405542, 100.0, 85.441472, 35.441472, 0.0, 0.0, 0.0, 0.0, 50.0, 100.0, 100.0, 100.0, 100.0],
  srsi_d: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
  srsi_k: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 59.600524],
  st_down: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
  st_up: [null, null, null, null, null, null, null, null, null, null, 9.75, 9.75, 9.75, 9.75, 9.75, 9.75, 9.75, 9.75, 9.75, 9.75, 9.75, 9.75, 9.75, 9.75, 9.75, 9.75, 9.75, 9.75, 9.75, 9.75],
  trix5: [null, null, null, null, null, null, null, null, null, null, null, null, null, 1.953953, 1.158254, 0.380382, -0.032943, -0.062366, 0.088537, 0.164871, 0.079303, -0.148278, -0.467784, -0.831729, -1.176543, -1.274961, -1.081972, -0.68865, -0.217637, 0.223579],
  wma20: [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 13.044286, 13.055238, 13.01619, 12.931429, 12.80619, 12.654762, 12.547619, 12.491429, 12.471905, 12.479524, 12.507143],
  wma3: [null, null, 11.066667, 11.683333, 12.25, 12.416667, 12.183333, 12.183333, 12.633333, 13.316667, 14.033333, 14.283333, 14.033333, 13.5, 12.9, 12.4, 12.466667, 12.9, 13.3, 13.316667, 13.05, 12.666667, 12.266667, 11.866667, 11.516667, 11.55, 11.883333, 12.316667, 12.683333, 12.95],
  wr5: [null, null, null, null, -13.157895, -21.212121, -46.153846, -36.363636, -18.518519, -14.705882, -12.195122, -18.918919, -44.827586, -65.517241, -71.428571, -72.972973, -48.387097, -18.518519, -17.241379, -27.586207, -52.173913, -61.538462, -66.666667, -67.741935, -66.666667, -46.153846, -20.833333, -17.857143, -16.129032, -17.241379]
};

function expectEq(name: string, got: Point[], want: Point[], tol = 1e-6): void {
  assert.equal(got.length, want.length, `${name} length`);
  for (let i = 0; i < want.length; i++) {
    const a = got[i], b = want[i];
    if (b === null) assert.equal(a, null, `${name}[${i}] must be null during warm-up`);
    else assert.ok(a != null && Math.abs(a - b) <= tol, `${name}[${i}] got ${a} want ${b}`);
  }
}

test("P27 wma: linear weights + warm-up (golden)", () => {
  expectEq("wma3", wma(C, 3), GOLDEN.wma3);
  expectEq("wma20", wma(C, 20), GOLDEN.wma20);
});

test("P27 hma: WMA(2·WMA(n/2)−WMA(n),√n) (golden)", () => {
  expectEq("hma21", hma(C, 21), GOLDEN.hma21);
});

test("P27 supertrend: trailing band + uptrend line (golden)", () => {
  const r = supertrend(bars, 10, 3);
  expectEq("st_up", r.up, GOLDEN.st_up);
  expectEq("st_down", r.down, GOLDEN.st_down);
});

test("P27 supertrend flips on a falling series (property)", () => {
  const falling = Array.from({ length: 40 }, (_, i) => ({ time: i * 60, open: 100 - i, high: 101 - i, low: 99 - i, close: 100 - i, volume: 10 }));
  const r = supertrend(falling, 5, 2);
  const lastUp = [...r.up].lastIndexOf(r.up.find((x) => x != null) ?? null);
  assert.ok(r.down.some((x) => x != null), "a monotone fall must end in a downtrend");
  // from the flip onward the up line stays null
  const flip = r.down.findIndex((x) => x != null);
  for (let i = flip; i < 40; i++) assert.equal(r.up[i], null, `up[${i}] null after flip`);
  void lastUp;
});

test("P27 donchian: HH/LL/midpoint (golden, n=5 and n=20)", () => {
  const r5 = donchian(bars, 5);
  expectEq("don5_up", r5.upper, GOLDEN.don5_up);
  expectEq("don5_basis", r5.basis, GOLDEN.don5_basis);
  expectEq("don5_lower", r5.lower, GOLDEN.don5_lower);
  const r20 = donchian(bars, 20);
  expectEq("don20_up", r20.upper, GOLDEN.don20_up);
  expectEq("don20_basis", r20.basis, GOLDEN.don20_basis);
  expectEq("don20_lower", r20.lower, GOLDEN.don20_lower);
});

test("P27 keltner: EMA ± mult·ATR (golden)", () => {
  const r = keltner(bars, 20, 2);
  expectEq("kelt_basis", r.basis, GOLDEN.kelt_basis);
  expectEq("kelt_upper", r.upper, GOLDEN.kelt_upper);
  expectEq("kelt_lower", r.lower, GOLDEN.kelt_lower);
});

test("P27 psar: trailing dots below price in a pure rally (golden + property)", () => {
  expectEq("psar", psar(bars, 0.02, 0.2), GOLDEN.psar);
  const rising = Array.from({ length: 40 }, (_, i) => ({ time: i * 60, open: 10 + i, high: 11 + i, low: 9 + i, close: 10.5 + i, volume: 10 }));
  const r = psar(rising, 0.02, 0.2);
  for (let i = 1; i < rising.length; i++) {
    if (r[i] != null) assert.ok(r[i]! <= rising[i].low + 1e-9, `SAR(${i})=${r[i]} must trail below the lows in a pure uptrend`);
  }
});

test("P27 ichimoku: tenkan/kijun/spanA/spanB aligned, no forward shift (golden)", () => {
  const r26 = ichimoku(bars, 9, 26, 26);
  expectEq("ichi_t", r26.tenkan, GOLDEN.ichi_t);
  expectEq("ichi_k", r26.kijun, GOLDEN.ichi_k);
  expectEq("ichi_sa", r26.spanA, GOLDEN.ichi_sa);
  expectEq("ichi_sb", r26.spanB, GOLDEN.ichi_sb);
  const r52 = ichimoku(bars, 9, 26, 52);
  expectEq("ichi92652_sb", r52.spanB, GOLDEN.ichi92652_sb);
});

test("P27 adx/DMI: Wilder smoothing, DI first, ADX after 2×period (golden)", () => {
  const r14 = adx(bars, 14);
  expectEq("adx14", r14.adx, GOLDEN.adx14);
  expectEq("pdi14", r14.plusDI, GOLDEN.pdi14);
  expectEq("mdi14", r14.minusDI, GOLDEN.mdi14);
  const r5 = adx(bars, 5);
  expectEq("adx5", r5.adx, GOLDEN.adx5);
  expectEq("pdi5", r5.plusDI, GOLDEN.pdi5);
  expectEq("mdi5", r5.minusDI, GOLDEN.mdi5);
});

test("P27 williams %R: bounds [−100, 0] + golden", () => {
  const r = williamsR(bars, 5);
  expectEq("wr5", r, GOLDEN.wr5);
  for (const v of r) if (v != null) assert.ok(v <= 0 && v >= -100, `%R must be in [-100, 0], got ${v}`);
});

test("P27 cci: mean-deviation scaling (golden)", () => {
  expectEq("cci5", cci(bars, 5), GOLDEN.cci5);
});

test("P27 stochRsi: K/D smoothed, bounds [0, 100] (golden ×2)", () => {
  const r14 = stochRsi(C, 14, 14, 3, 3);
  expectEq("srsi_k", r14.k, GOLDEN.srsi_k);
  expectEq("srsi_d", r14.d, GOLDEN.srsi_d);
  const r5 = stochRsi(C, 5, 5, 2, 2);
  expectEq("srsi5_k", r5.k, GOLDEN.srsi5_k);
  expectEq("srsi5_d", r5.d, GOLDEN.srsi5_d);
  for (const v of [...r5.k, ...r5.d]) if (v != null) assert.ok(v >= -1e-9 && v <= 100 + 1e-9, `stochRSI must be in [0, 100], got ${v}`);
});

test("P27 mfi: volume-weighted, honest null without volume (golden)", () => {
  expectEq("mfi14", mfi(bars, 14), GOLDEN.mfi14);
  const noVol = bars.map((b) => ({ ...b, volume: 0 }));
  const r = mfi(noVol, 14);
  for (const v of r) assert.equal(v, null, "zero-volume bars must stay null (no fake 100)");
});

test("P27 obv: cumulative signed volume (golden)", () => {
  expectEq("obv", obv(bars), GOLDEN.obv);
});

test("P27 trix: % ROC of triple EMA (golden)", () => {
  expectEq("trix5", trix(C, 5), GOLDEN.trix5);
});

test("P27 ao: SMA(median,fast)−SMA(median,slow) (golden)", () => {
  expectEq("ao3_10", awesomeOscillator(bars, 3, 10), GOLDEN.ao3_10);
});

test("P27 roc: % change vs n bars ago (golden)", () => {
  expectEq("roc9", roc(C, 9), GOLDEN.roc9);
});

test("P27 alignment: every new series is input-length", () => {
  const checks: Point[][] = [
    wma(C, 3), hma(C, 21), supertrend(bars, 10, 3).up, supertrend(bars, 10, 3).down,
    donchian(bars, 5).upper, keltner(bars, 20, 2).lower, psar(bars, 0.02, 0.2),
    ichimoku(bars, 9, 26, 26).spanB, adx(bars, 5).adx, williamsR(bars, 5),
    cci(bars, 5), stochRsi(C, 5, 5, 2, 2).k, mfi(bars, 14), obv(bars),
    trix(C, 5), awesomeOscillator(bars, 3, 10), roc(C, 9),
  ];
  for (const s of checks) assert.equal(s.length, 30);
});
