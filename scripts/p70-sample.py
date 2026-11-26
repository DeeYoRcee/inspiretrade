#!/usr/bin/env python3
"""P70 — record FRESH XAUUSD spot M1 candles from gold-api /price/XAU using the
EXACT Phase 67 fold semantics (shared/spot-recorder-core.ts foldSample +
providerMinuteBucket, mirrored 1:1). 1s poll (same as the production client,
P67-measured 0-fail cadence), ~13.5 minutes → ≥12 completed minutes for the
decisive /ohlc comparison once a GOLD_API_KEY is provisioned.

Writes: download/p70_ohlc/recorded-session.jsonl (one row per completed minute)
        download/p70_ohlc/recorded-session-samples.jsonl (raw 1s samples)
Prints a summary + per-minute stats at the end.

Honesty rules: only actually-observed prices fold in; a sample whose provider
stamp buckets BEFORE the candle being built is dropped (late); ±2% glitch
guard vs the freshest close (30-min anchor); no volume — s = sample count."""
import json, time, urllib.request
from datetime import datetime, timezone

OUT_DIR = "/home/z/my-project/download/p70_ohlc"
SAMPLES_PATH = f"{OUT_DIR}/recorded-session-samples.jsonl"
CANDLES_PATH = f"{OUT_DIR}/recorded-session.jsonl"
RUN_SEC = 13 * 60 + 30
MAX_STAMP_SKEW = 120
GLITCH_PCT = 0.02
ANCHOR_MAX_AGE = 30 * 60

def fetch_spot():
    t0 = time.time()
    with urllib.request.urlopen("https://api.gold-api.com/price/XAU", timeout=8) as r:
        cc = r.headers.get("cache-control", "")
        d = json.loads(r.read().decode())
    price = d.get("price")
    stamp = d.get("updatedAt")  # ISO 8601 UTC Z
    stamp_sec = datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp() if stamp else None
    return {"at": round(t0, 2), "rttMs": round((time.time() - t0) * 1000),
            "price": price, "stamp": stamp, "stampSec": stamp_sec, "cc": cc}

def provider_bucket(cur_t, now_sec, stamp_sec):
    local = (now_sec // 60) * 60
    bucket = local
    if stamp_sec and stamp_sec > 0:
        skewed = abs(now_sec - stamp_sec) <= MAX_STAMP_SKEW
        bucket = int(min(stamp_sec, now_sec + 5)) // 60 * 60 if skewed else local
    if cur_t is not None and bucket < cur_t:
        return None  # late sample for a finished minute — drop
    return int(bucket)

def fold(cur, price, bucket):
    if cur is not None and cur["t"] == bucket:
        return {"t": bucket, "o": cur["o"], "c": price,
                "h": max(cur["h"], price), "l": min(cur["l"], price),
                "s": min(60, cur["s"] + 1)}
    return {"t": bucket, "o": price, "h": price, "l": price, "c": price, "s": 1}

cur = None
anchor = None  # {"c": close, "at": ts}
samples, candles, drops = [], [], {"late": 0, "glitch": 0, "bad": 0}
start = time.time()
while time.time() - start < RUN_SEC:
    loop_t = time.time()
    try:
        s = fetch_spot()
        s["ok"] = True
        with open(SAMPLES_PATH, "a") as f:
            f.write(json.dumps(s) + "\n")
        now_sec = int(time.time())
        p = s["price"]
        if not (isinstance(p, (int, float)) and p > 0):
            drops["bad"] += 1
        else:
            if anchor is not None and loop_t - anchor["at"] < ANCHOR_MAX_AGE and abs(p / anchor["c"] - 1) > GLITCH_PCT:
                drops["glitch"] += 1
            else:
                b = provider_bucket(cur["t"] if cur else None, now_sec, s["stampSec"])
                if b is None:
                    drops["late"] += 1
                else:
                    prev_candle = dict(cur) if cur is not None else None
                    prev_t = prev_candle["t"] if prev_candle else None
                    cur = fold(cur, p, b)
                    anchor = {"c": p, "at": loop_t}
                    if prev_candle is not None and b > prev_t:
                        # minute completed — persist the FINISHED candle, keep
                        # the new in-progress candle alive
                        with open(CANDLES_PATH, "a") as f:
                            f.write(json.dumps(prev_candle) + "\n")
    except Exception as e:
        err = {"at": round(loop_t, 2), "ok": False, "err": str(e)[:80]}
        with open(SAMPLES_PATH, "a") as f:
            f.write(json.dumps(err) + "\n")
        drops["bad"] += 1
    sleep_for = 1.0 - (time.time() - loop_t)
    if sleep_for > 0:
        time.sleep(sleep_for)

# summary — read samples back from the persisted file
samples = [json.loads(l) for l in open(SAMPLES_PATH) if l.strip()]
ok = [x for x in samples if x.get("ok")]
stamps = {x["stamp"] for x in ok if x.get("stamp")}
ranges, done = [], []
for line in open(CANDLES_PATH):
    c = json.loads(line); done.append(c)
    ranges.append(round(c["h"] - c["l"], 4))
summary = {
    "durationSec": round(time.time() - start, 1),
    "samples": len(ok), "errors": len(samples) - len(ok),
    "distinctProviderStamps": len(stamps),
    "candles": len(done),
    "candlesUtc": [datetime.fromtimestamp(c["t"], timezone.utc).strftime("%H:%M") for c in done],
    "meanHL": round(sum(ranges) / len(ranges), 4) if ranges else None,
    "drops": drops,
    "startedUtc": datetime.fromtimestamp(start, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "finishedUtc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
json.dump(summary, open(f"{OUT_DIR}/recorded-session-summary.json", "w"), indent=1)
print(json.dumps(summary, indent=1))
for c in done:
    print(f"  {datetime.fromtimestamp(c['t'], timezone.utc).strftime('%H:%M')}Z o={c['o']:.4f} h={c['h']:.4f} l={c['l']:.4f} c={c['c']:.4f} s={c['s']}")