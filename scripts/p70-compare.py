#!/usr/bin/env python3
"""P70 — build the decisive comparison table: recorded M1 vs provider /ohlc.

Usage: p70-compare.py <candles.jsonl> <provider_dir>
  candles.jsonl : rows {t,o,h,l,c,s} (fresh session / harness / spot-history export)
  provider_dir  : one saved raw JSON per minute: <provider_dir>/<t>.json

Rules (phase-mandated): NO invented values, NO arbitrary offsets/normalization.
A provider row that is missing/invalid is reported as missing, never guessed.
"""
import json, os, sys, statistics
from datetime import datetime, timezone

candles_path, prov_dir = sys.argv[1], sys.argv[2]
out_dir = "/home/z/my-project/download/p70_ohlc"

rec = {r["t"]: r for r in (json.loads(l) for l in open(candles_path) if l.strip())}
rows = []
for t in sorted(os.listdir(prov_dir)):
    if not t.endswith(".json"):
        continue
    ts = int(t[:-5])
    if ts not in rec:
        continue  # not one of the selected minutes
    raw = open(os.path.join(prov_dir, t)).read()
    try:
        p = json.loads(raw)
    except Exception:
        rows.append({"t": ts, "providerParseError": raw[:120]})
        continue
    r = rec[ts]
    def num(x):
        return x if isinstance(x, (int, float)) else None
    po, ph, pl, pc = num(p.get("open")), num(p.get("high")), num(p.get("low")), num(p.get("close"))
    echo_start, echo_end = p.get("startTimestamp"), p.get("endTimestamp")
    invalid = []
    for name, v in (("open", po), ("high", ph), ("low", pl), ("close", pc)):
        if v is None:
            invalid.append(f"{name}=missing")
        elif v <= 0:
            invalid.append(f"{name}<=0")
        elif v > 1e6:
            invalid.append(f"{name}out-of-band")
    if ph is not None and pl is not None and ph < pl:
        invalid.append("high<low")
    d = lambda a, b: round(abs(a - b), 4) if (a is not None and b is not None) else None
    rows.append({
        "t": ts,
        "utc": datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "rec": {"o": r["o"], "h": r["h"], "l": r["l"], "c": r["c"], "s": r["s"]},
        "prov": {"o": po, "h": ph, "l": pl, "c": pc},
        "absDH": d(r["h"], ph), "absDL": d(r["l"], pl),
        "absDO": d(r["o"], po), "absDC": d(r["c"], pc),
        "echoInterval": [echo_start, echo_end],
        "echoMatchesRequest": echo_start == ts and echo_end == ts + 60,
        "invalid": invalid,
        "raw": p,
    })

# table print
hdr = f"{'minute UTC':<21}{'rec O':>10}{'rec H':>10}{'rec L':>10}{'rec C':>10} |{'p O':>10}{'p H':>10}{'p L':>10}{'p C':>10} |{'|ΔH|':>8}{'|ΔL|':>8}{'|ΔC|':>8}  flags"
print(hdr); print("-" * len(hdr))
for x in rows:
    if "providerParseError" in x:
        print(f"{x['utc']:<21} PARSE ERROR: {x['providerParseError']}")
        continue
    r, p = x["rec"], x["prov"]
    fmt = lambda v: f"{v:.4f}" if v is not None else "MISSING"
    flags = ",".join(x["invalid"]) if x["invalid"] else ("echo-ok" if x["echoMatchesRequest"] else "ECHO-MISMATCH")
    print(f"{x['utc']:<21}{fmt(r['o']):>10}{fmt(r['h']):>10}{fmt(r['l']):>10}{fmt(r['c']):>10} |"
          f"{fmt(p['o']):>10}{fmt(p['h']):>10}{fmt(p['l']):>10}{fmt(p['c']):>10} |"
          f"{fmt(x['absDH']):>8}{fmt(x['absDL']):>8}{fmt(x['absDC']):>8}  {flags}")

# verdict metrics (only over rows with full valid provider data)
good = [x for x in rows if "providerParseError" not in x and not x["invalid"]]
verdict = {"minutesCompared": len(good), "minutesTotal": len(rows)}
if good:
    for k in ("absDH", "absDL", "absDO", "absDC"):
        vals = [x[k] for x in good if x[k] is not None]
        verdict[k] = {"mean": round(statistics.mean(vals), 4), "max": round(max(vals), 4)} if vals else None
    verdict["providerHighAboveRecHigh"] = sum(1 for x in good if x["raw"]["high"] > x["rec"]["h"] + 1e-9)
    verdict["providerLowBelowRecLow"] = sum(1 for x in good if x["raw"]["low"] < x["rec"]["l"] - 1e-9)
    verdict["providerCloseEqualsRecClose(±0.01)"] = sum(1 for x in good if x["raw"]["close"] is not None and abs(x["raw"]["close"] - x["rec"]["c"]) <= 0.01)
json.dump({"verdict": verdict, "rows": rows}, open(f"{out_dir}/comparison.json", "w"), indent=1)
print("\nVERDICT:", json.dumps(verdict))
print(f"saved: {out_dir}/comparison.json")