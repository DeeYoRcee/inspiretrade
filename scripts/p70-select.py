#!/usr/bin/env python3
"""P70-4 — select 10 completed recorded M1 candles from the Phase 67 harness
artifacts (download/xauusd_m1_monitor/candles.jsonl) for the decisive
gold-api /ohlc comparison. Read-only; writes selection.json."""
import json, sys

SRC = sys.argv[1] if len(sys.argv) > 1 else "/home/z/my-project/download/p70_ohlc/recorded-session.jsonl"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/home/z/my-project/download/p70_ohlc/selection.json"

rows = []
for line in open(SRC):
    line = line.strip()
    if line:
        rows.append(json.loads(line))

# completed = minute bucket fully elapsed (session ended 16:09:01, last candle 16:08)
# selection = the 10 most recent completed candles, s>=3 (skip partial/dot minutes)
sel = [c for c in rows if c.get("s", 0) >= 3][-10:]

from datetime import datetime, timezone
items = []
for c in sel:
    t = c["t"]
    assert t % 60 == 0
    utc = datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    items.append({
        "t": t,
        "utc": utc,
        "recorded": {"o": c["o"], "h": c["h"], "l": c["l"], "c": c["c"], "s": c["s"]},
        "providerReq": f"/ohlc/XAU?startTimestamp={t}&endTimestamp={t + 60}",
    })

out = {
    "source": SRC,
    "session": "sandbox-recorded 2026-11-26 (p70-sample.py, EXACT Phase 67 foldSample + providerMinuteBucket semantics, 1s poll of the same gold-api /price/XAU stream the production client uses)",
    "instrumentBasis": "XAU/USD spot — recorded from gold-api /price/XAU 1s stream; provider /ohlc computed from the same provider's internal data → same instrument & price basis (no offset needed)",
    "count": len(items),
    "minutes": items,
}
json.dump(out, open(OUT, "w"), indent=1)
print(f"selected {len(items)} minutes: {items[0]['utc']} → {items[-1]['utc']}")
for it in items:
    r = it["recorded"]
    print(f"  {it['utc']}  o={r['o']:.4f} h={r['h']:.4f} l={r['l']:.4f} c={r['c']:.4f} s={r['s']}")