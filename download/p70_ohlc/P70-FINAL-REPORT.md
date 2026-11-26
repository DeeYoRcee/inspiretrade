# PHASE 70 — gold-api /ohlc DECISIVE TEST — EXECUTED (keyed run)

**Date:** 2026-11-26 · **Window:** 2026-11-26T15:36–15:45 UTC (10 completed minutes from today's recorded session)
**Status:** COMPLETE — 10/10 requests, **10/10 HTTP 200**, 10/10 minutes compared, **0 missing, 0 invalid, 0 invented values**.
**Final recommendation: KEEP CURRENT RECORDER** (decisive negative result for integration).

---

## 1. Method (read-only, production untouched)

- **Recorded side:** fresh sandbox session recorded today with `p70-sample.py` — the EXACT Phase 67 `foldSample` + `providerMinuteBucket` semantics, 1:1 mirror of `shared/spot-recorder-core.ts`. 1 s polling of the same gold-api `/price/XAU` stream the production client uses → 806 samples, 13 candles, 0 errors. Last 10 completed minutes selected (`selection.json`, 15:36–15:45 UTC, s=60 each).
- **Provider side:** `GET https://api.gold-api.com/ohlc/XAU?startTimestamp={t}&endTimestamp={t+60}` with `x-api-key` header. Exactly 10 requests, 7 s apart. Key lives only in a single-process env (extracted from gitignored `upload/goldapi.env.txt`); never printed, logged, or committed (verified: `GOLD_API_KEY` appears in 0 artifacts; the only `x-api-key` string match is the provider's own 401 error text in `probe-ohlc-nokey.json`).
- **Same instrument, same basis:** both sides are XAU/USD spot from the same provider — no offset, no normalization, nothing invented.

## 2. HTTP evidence

| req | minute (UTC) | t | HTTP | bytes |
|----|----------------|------------|------|-------|
| 1 | 15:36 | 1795707360 | 200 | 209 |
| 2 | 15:37 | 1795707420 | 200 | 199 |
| 3 | 15:38 | 1795707480 | 200 | 205 |
| 4 | 15:39 | 1795707540 | 200 | 199 |
| 5 | 15:40 | 1795707600 | 200 | 205 |
| 6 | 15:41 | 1795707660 | 200 | 179 |
| 7 | 15:42 | 1795707720 | 200 | 206 |
| 8 | 15:43 | 1795707780 | 200 | 200 |
| 9 | 15:44 | 1795707840 | 200 | 207 |
| 10 | 15:45 | 1795707900 | 200 | 205 |

All 10 raw bodies saved to `provider/<t>.json`. Sample body (req 1):

```json
{"close":3573.1001,"endTimestamp":1795707420,"high":3573.3,"highLowChangePercent":0.0055945815791746374,"low":3573.1001,"open":3573.3,"openCloseChangePercent":-0.005594268603253871,"startTimestamp":1795707360}
```

All 10 responses echo `startTimestamp`/`endTimestamp` exactly as requested (`echo-ok` × 10) — the endpoint DOES support precise 1-minute ranges, including minutes completed ~33–42 min earlier (historical per-minute queries work). Free-plan hourly quota: 10/10 used for this hour (by design; resets next hour). No 401/429/5xx occurred; stop conditions never triggered.

## 3. Comparison table (provider vs recorded M1)

```
minute UTC                rec O     rec H     rec L     rec C |       p O       p H       p L       p C |    |ΔH|    |ΔL|    |ΔC|  flags
------------------------------------------------------------------------------------------------------------------------------------
2026-11-26T15:36:00Z  3573.3000 3573.3000 3573.1001 3573.1001 | 3573.3000 3573.3000 3573.1001 3573.1001 |  0.0000  0.0000  0.0000  echo-ok
2026-11-26T15:37:00Z  3571.2000 3573.3000 3571.2000 3573.3000 | 3571.2000 3573.3000 3571.2000 3573.3000 |  0.0000  0.0000  0.0000  echo-ok
2026-11-26T15:38:00Z  3571.1499 3573.3000 3571.1499 3573.3000 | 3571.1499 3573.3000 3571.1499 3573.3000 |  0.0000  0.0000  0.0000  echo-ok
2026-11-26T15:39:00Z  3570.5000 3572.8000 3570.5000 3572.8000 | 3570.5000 3572.8000 3570.5000 3572.8000 |  0.0000  0.0000  0.0000  echo-ok
2026-11-26T15:40:00Z  3571.5000 3572.3999 3571.5000 3572.3999 | 3571.5000 3572.3999 3571.5000 3572.3999 |  0.0000  0.0000  0.0000  echo-ok
2026-11-26T15:41:00Z  3572.3999 3572.3999 3572.3999 3572.3999 | 3572.3999 3572.3999 3572.3999 3572.3999 |  0.0000  0.0000  0.0000  echo-ok
2026-11-26T15:42:00Z  3571.1001 3571.1001 3569.8000 3569.8000 | 3571.1001 3571.1001 3569.8000 3569.8000 |  0.0000  0.0000  0.0000  echo-ok
2026-11-26T15:43:00Z  3572.7000 3572.7000 3571.0000 3571.0000 | 3572.7000 3572.7000 3571.0000 3571.0000 |  0.0000  0.0000  0.0000  echo-ok
2026-11-26T15:44:00Z  3571.0000 3572.6001 3571.0000 3572.6001 | 3571.0000 3572.6001 3571.0000 3572.6001 |  0.0000  0.0000  0.0000  echo-ok
2026-11-26T15:45:00Z  3570.7000 3573.1001 3570.7000 3573.1001 | 3570.7000 3573.1001 3570.7000 3573.1001 |  0.0000  0.0000  0.0000  echo-ok
```

Verdict metrics (`comparison.json`): minutesCompared 10/10; mean & max of |ΔO|/|ΔH|/|ΔL|/|ΔC| = **0.0** at 4-decimal tick reporting resolution.

## 4. Full-precision analysis (why verdict counters say 4-above / 3-below)

At full float64 precision the maximum absolute difference over ALL 40 O/H/L/C fields is **0.000049 USD** — pure float32 representation noise, 3–4 orders of magnitude below the 0.01-scale XAU tick:

- Every recorded value is EXACTLY `float32(providerValue)` (e.g. rec 3573.300049 = float32 of prov 3573.3; rec 3571.149902 = float32 of 3571.1499). The provider's live `/price` stream emits float32-rounded numbers; its `/ohlc` endpoint emits clean decimals — our candles inherit the live stream's representation, nothing more.
- `providerHighAboveRecHigh: 4` and `providerLowBelowRecLow: 3` are fully explained by that epsilon (diffs +0.000002…+0.000049): **zero extra price levels in either direction at real tick resolution — 0 of 10 minutes show finer provider H/L.**
- All 10 echo intervals match the request exactly.

## 5. Decision — the 5 questions

1. **Does provider OHLC contain more accurate intraminute High/Low?** — **NO.** Provider H/L == recorded H/L in 10/10 minutes (max diff 0.000049 = float32 epsilon, no real difference).
2. **Does it capture 1 s-recorder-missed price movement?** — **NO.** Not one extra tick in either direction. Structural reason (now proven, not assumed): `/ohlc` is aggregated from the same upstream stamps our 1 s poller consumes; the provider publishes every ~30 s (P69 measured twice), so its own OHLC cannot contain a price it never emitted.
3. **Is it consistent enough to improve historical M1 candles?** — **There is nothing to improve**: levels are identical. The only observable difference is decimal representation (float32 artifacts from the live stream), which is cosmetic and below any reporting resolution.
4. **Does the result justify future integration?** — **NO.** Zero accuracy gain, 10 req/hour shared quota, one-range-per-request with no series endpoint on any plan, plus an RTDB schema change it would require. Cost with no benefit.
5. **Does Premium add substantive benefit?** — **NO.** Publish cadence is ~30 s on all plans (P69, measured twice); P70 adds: even the keyed `/ohlc` carries no intraminute resolution beyond that cadence. Premium only lifts rate limits / adds aggregation endpoints — neither adds price information.

## 6. Recommendation

**KEEP CURRENT RECORDER.** The P69 auto-upgrade condition ("integrate only if the keyed test shows provider H/L consistently finer") did **NOT** trigger: 0/10 minutes finer. The Phase 67 self-recording pipeline already sits at the provider's publish-cadence bound. **No implementation follows without the user's explicit approval — and none is recommended.**

## 7. Limitations (stated honestly)

- Single 10-minute window on one day; market was moderately quiet (per-minute ranges ≈ 0.2–2.1 USD). However, the conclusion is structural, not sample-dependent: provider `/ohlc` cannot exceed the information content of the provider's own ~30 s stamp stream, which the recorder already samples at 1 s.
- Recorded side is the Phase 67-semantics harness session (1:1 mirror of `shared/spot-recorder-core.ts`), not a direct production RTDB pull — production spot-history is auth-gated (401 anonymous, verified P69). This approach was specified by the Phase 70 protocol.
- Free-plan quota for this hour is exhausted (10/10); a repeat run is possible next hour with the same one-command keyed run.
- Provider responses carry extra fields (`highLowChangePercent`, `openCloseChangePercent`) — informational only, unused.

## 8. Artifacts

- `selection.json` — the 10 selected minutes + recorded values + request URLs
- `recorded-session.jsonl` (13 candles) / `recorded-session-samples.jsonl` (806 samples) / `recorded-session-summary.json`
- `provider/<t>.json` × 10 — raw provider bodies; `provider-http.log` — request/status log (key-free)
- `comparison.json` — machine-readable comparison + verdict
- Scripts: `scripts/p70-ohlc-test.sh` (fail-closed harness), `scripts/p70-compare.py`, `scripts/p70-precision.py` (float32 proof), `scripts/p70-sample.py`, `scripts/p70-select.py`
- Key handling: value never printed/logged/committed; `upload/goldapi.env.txt` is gitignored; Vercel env var untouched; **no production file changed, no deploy** (git diff = artifacts + scripts only).
