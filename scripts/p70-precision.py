#!/usr/bin/env python3
"""P70 — full-precision diff analysis: recorded M1 vs provider /ohlc.

Quantifies the sub-0.00005 differences behind verdict fields
providerHighAboveRecHigh / providerLowBelowRecLow (float32 noise vs real ticks).
"""
import json

d = json.load(open('/home/z/my-project/download/p70_ohlc/comparison.json'))
rows = d['rows']

print(f"rows: {len(rows)}")
max_diff = 0.0
above_h, below_l = [], []
for x in rows:
    r, p = x['rec'], x['raw']
    diffs = {k: abs(r[k[0]] - p[k]) for k in ('open', 'high', 'low', 'close')}
    md = max(diffs.values())
    max_diff = max(max_diff, md)
    if p['high'] > r['h'] + 1e-9:
        above_h.append((x['utc'], p['high'], r['h'], p['high'] - r['h']))
    if p['low'] < r['l'] - 1e-9:
        below_l.append((x['utc'], p['low'], r['l'], p['low'] - r['l']))
    echo = p.get('startTimestamp'), p.get('endTimestamp')
    ok = echo == (x['t'], x['t'] + 60)
    print(f"{x['utc']}  dO={diffs['open']:.9f} dH={diffs['high']:.9f} "
          f"dL={diffs['low']:.9f} dC={diffs['close']:.9f}  echo_ok={ok}")

print(f"\nmax full-precision abs diff over all O/H/L/C fields: {max_diff:.12f}")
print(f"provider high strictly above rec high: {len(above_h)}")
for utc, ph, rh, dd in above_h:
    print(f"  {utc}  prov={ph!r} rec={rh!r} diff={dd:+.12f}")
print(f"provider low strictly below rec low: {len(below_l)}")
for utc, pl, rl, dd in below_l:
    print(f"  {utc}  prov={pl!r} rec={rl!r} diff={dd:+.12f}")

# float32 explanation check: is every recorded value exactly a float32 of the provider value?
import struct
def f32(v):
    return struct.unpack('f', struct.pack('f', v))[0]
mismatch = []
for x in rows:
    r, p = x['rec'], x['raw']
    for k_rec, k_p in (('o', 'open'), ('h', 'high'), ('l', 'low'), ('c', 'close')):
        if r[k_rec] != f32(p[k_p]):
            mismatch.append((x['utc'], k_rec, r[k_rec], p[k_p]))
print(f"\nrec values that are NOT float32(provider value): {len(mismatch)}")
for m in mismatch[:10]:
    print(f"  {m[0]} {m[1]}: rec={m[2]!r} prov={m[3]!r}")
