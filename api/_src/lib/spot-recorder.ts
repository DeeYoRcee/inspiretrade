/**
 * PHASE 67 — server-managed spot recorder.
 *
 * The Phase-16 recorder only ran while a BROWSER chart observed gold-api
 * ticks: close the browser and no client recorded candles (the overnight /
 * quiet-hour gaps in spotTicks). This module makes the recording
 * SERVER-authoritative by joining the trading-cron's self-continuing chain
 * (api/_src/trading/cron.ts — the Phase 64 24/7 model: no Vercel sub-daily
 * cron, no permanent process, just bounded self-re-invoking serverless hops
 * re-seeded by kicks and the daily alerts-cron floor).
 *
 * Each step samples gold-api ONCE per code (throttled via an RTDB
 * transaction claim so concurrent hops can never double-sample) and folds
 * the price into the SHARED spotTicks store with the exact client-recorder
 * semantics (shared/spot-recorder-core.ts foldSample):
 *   · PROVIDER timestamps decide the minute bucket (MAX_STAMP_SKEW guard —
 *     a frozen weekend stamp or a skewed clock falls back to the local
 *     clock, which the session gate then rejects anyway);
 *   · a candle is only written inside an OPEN FX/metals session — a closed
 *     market keeps its last candle (nothing fabricated);
 *   · a sample more than 2% from the freshest stored close within 30 min is
 *     a glitch (the Phase 20 stuck-price incident) — rejected;
 *   · a late sample for a minute that is already finished is dropped, never
 *     rewritten (out-of-order protection);
 *   · writes are idempotent RTDB transactions — replaying a sample cannot
 *     duplicate or corrupt the candle.
 *
 * Honest gaps stay gaps: when the provider is unreachable, nothing is
 * written and the failure is counted in the RTDB diagnostics document
 * (diag/spotRecorder/{code}) that the feed-status action and the chart
 * badge surface.
 */
import { rtdb } from "./firebase";
import { marketHours } from "../../../shared/market-hours";
import { SPOT_PRICE_BANDS } from "../../../shared/terminal";
import { foldSample, providerMinuteBucket, type SpotCandle } from "../../../shared/spot-recorder-core";

/** Provider codes the server recorder maintains (mirrors the client recorder). */
const RECORDER_CODES = ["XAU", "XAG"] as const;
const SYMBOL_OF: Record<string, string> = { XAU: "XAUUSD", XAG: "XAGUSD" };

/** Minimum wall-clock gap between two server samples of the same code. The
 *  cron chain hops continuously (~every sweep ≈ tens of seconds); the claim
 *  transaction below collapses them to at most one provider request per gap. */
const SAMPLE_GAP_MS = 15_000;

/** A glitch guard anchor older than this never blocks fresh truth (the same
 *  bound the client recorder uses — a stale anchor must not reject a real
 *  market move forever). */
const GLITCH_ANCHOR_MAX_AGE_MS = 30 * 60_000;

/** gold-api request timeout — the recorder must never stall a chain hop. */
const FETCH_TIMEOUT_MS = 6000;

export interface RecorderCodeDiag {
  folded: boolean;
  reason?: string; // "throttled" | "closed" | "glitch" | "late" | "bad-price" | "fetch-failed" | "out-of-band"
  price?: number;
  minute?: number;
  providerDelaySec?: number | null;
  fails?: number;
}

export interface RecorderDiag {
  ok: boolean;
  codes: Record<string, RecorderCodeDiag>;
  ranMs: number;
  at: number;
}

/** Fetch one gold-api spot sample (price + the provider's own updatedAt). */
async function fetchSpotSample(code: string): Promise<{ price: number; providerAtSec: number | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.gold-api.com/price/${code}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`gold-api ${res.status}`);
    const data: any = await res.json();
    const price = Number(data?.price);
    if (!Number.isFinite(price) || price <= 0) throw new Error("BAD_SPOT");
    const providerAt = Date.parse(String(data?.updatedAt || "")) || 0;
    return { price, providerAtSec: providerAt ? Math.floor(providerAt / 1000) : null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One recorder step: at most one gold-api sample per code, folded into the
 * shared store. Best-effort by contract — a failure is DIAGNOSED, never
 * thrown into the caller (the trading chain must keep running).
 */
export async function recorderStep(codes: readonly string[] = RECORDER_CODES): Promise<RecorderDiag> {
  const started = Date.now();
  const out: Record<string, RecorderCodeDiag> = {};
  for (const code of codes) {
    const diagRef = rtdb().ref(`diag/spotRecorder/${code}`);
    try {
      // ---- claim the sample slot (idempotent under concurrent chain hops) --
      const nowMs = Date.now();
      const claimed = await diagRef.child("lastSampleAt").transaction((cur: any) => {
        const at = Number(cur || 0);
        if (nowMs - at < SAMPLE_GAP_MS) return; // abort — another hop sampled within the gap
        return nowMs;
      });
      if (!claimed.committed) {
        out[code] = { folded: false, reason: "throttled" };
        continue;
      }

      const sym = SYMBOL_OF[code] ?? code;
      const band = (SPOT_PRICE_BANDS as Record<string, [number, number]>)[code] ?? [0, 1e9];

      // ---- closed session: no candle, no invented weekend price ------------
      if (!marketHours(sym).open) {
        out[code] = { folded: false, reason: "closed" };
        continue;
      }

      // ---- sample the provider ---------------------------------------------
      let price: number, providerAtSec: number | null;
      let fails = 0;
      try {
        ({ price, providerAtSec } = await fetchSpotSample(code));
      } catch (e) {
        const snap = (await diagRef.once("value")).val() || {};
        fails = Number(snap.fails || 0) + 1;
        await diagRef.update({ fails, lastError: String((e as Error)?.message || e).slice(0, 80), lastFailAt: Date.now() });
        out[code] = { folded: false, reason: "fetch-failed", fails };
        continue;
      }

      // ---- identity band ----------------------------------------------------
      if (price < band[0] || price > band[1]) {
        out[code] = { folded: false, reason: "out-of-band", price };
        continue;
      }

      // ---- freshest stored minute: glitch anchor + out-of-order guard -------
      const tailSnap = await rtdb().ref(`spotTicks/${code}`)
        .orderByKey().limitToLast(1).once("value");
      const tailObj = tailSnap.val() || {};
      const tailKeys = Object.keys(tailObj);
      const last: SpotCandle | null = tailKeys.length
        ? { t: Number(tailKeys[0]), o: Number(tailObj[tailKeys[0]]?.o), h: Number(tailObj[tailKeys[0]]?.h), l: Number(tailObj[tailKeys[0]]?.l), c: Number(tailObj[tailKeys[0]]?.c), s: Number(tailObj[tailKeys[0]]?.s || 1) }
        : null;

      const nowSec = Math.floor(Date.now() / 1000);
      if (last && last.c > 0 && nowSec * 1000 - last.t * 1000 < GLITCH_ANCHOR_MAX_AGE_MS
        && Math.abs(price / last.c - 1) > 0.02) {
        out[code] = { folded: false, reason: "glitch", price };
        await diagRef.update({ lastError: `glitch: ${price} vs ${last.c}`, lastGlitchAt: Date.now() });
        continue;
      }

      const bucket = providerMinuteBucket(last, nowSec, providerAtSec);
      if (bucket == null) {
        out[code] = { folded: false, reason: "late" };
        continue;
      }

      // ---- idempotent fold into the shared store ----------------------------
      const foldRef = rtdb().ref(`spotTicks/${code}/${bucket}`);
      const tx = await foldRef.transaction((cur: any): any => {
        const candle: SpotCandle | null = cur && Number.isFinite(Number(cur?.o))
          ? { t: bucket, o: Number(cur.o), h: Number(cur.h), l: Number(cur.l), c: Number(cur.c), s: Number(cur.s || 0) }
          : null;
        return foldSample(candle, price, bucket);
      });
      const folded = !!tx.committed;
      const providerDelaySec = providerAtSec ? Math.max(0, nowSec - providerAtSec) : null;
      await diagRef.update({
        lastOkAt: Date.now(), price, providerAt: providerAtSec, providerDelaySec,
        minute: bucket, folded, fails: 0, lastError: null,
      });
      out[code] = { folded, price, minute: bucket, providerDelaySec };
    } catch (e) {
      // never break the caller (chain hop / route) on a recorder hiccup
      out[code] = { folded: false, reason: `error: ${String((e as Error)?.message || e).slice(0, 60)}` };
    }
  }
  return { ok: Object.values(out).some((d) => d.folded), codes: out, ranMs: Date.now() - started, at: Date.now() };
}

/** Recorder freshness snapshot for the feed-status action / monitoring. */
export async function recorderDiag(codes: readonly string[] = RECORDER_CODES): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  for (const code of codes) {
    try {
      out[code] = (await rtdb().ref(`diag/spotRecorder/${code}`).once("value")).val() || null;
    } catch { out[code] = null; }
  }
  return out;
}
