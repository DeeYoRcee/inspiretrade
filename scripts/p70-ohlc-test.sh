#!/bin/bash
# PHASE 70 — decisive gold-api /ohlc test (≤10 requests, fail-closed).
#
# Usage:  GOLD_API_KEY=... p70-ohlc-test.sh [candles.jsonl]
#   candles file: one JSON per line {t,o,h,l,c,s} — defaults to the fresh
#   sandbox-recorded session; production spot-history JSON export or the
#   Phase 67 harness candles.jsonl also work (same row shape).
#
# SAFETY:
#   * NO KEY → ZERO requests, clear setup instructions, exit 1 (fail-closed).
#   * WITH KEY → exactly ≤10 GET /ohlc requests, 7s apart, x-api-key header.
#   * Any 401/403/429/5xx → STOP immediately (never burn the 10/h quota).
#   * The key is never printed, logged, or committed.
set -u
KEY="${GOLD_API_KEY:-}"
OUT=/home/z/my-project/download/p70_ohlc
CANDLES="${1:-$OUT/recorded-session.jsonl}"
PROV="$OUT/provider"

if [ -z "$KEY" ]; then
  echo "BLOCKED: GOLD_API_KEY is not set — ZERO requests made (fail-closed)."
  echo
  echo "Secure setup (do NOT paste the key in chat, do NOT commit it):"
  echo "  1. Create a free account at https://gold-api.com (no card needed)."
  echo "  2. Dashboard → API Keys → generate a key."
  echo "  3. Vercel → your project → Settings → Environment Variables:"
  echo "       Name  = GOLD_API_KEY"
  echo "       Value = <the key>"
  echo "       Environments = Production + Preview (NOT exposed to the client bundle)"
  echo "  4. Redeploy so the env var takes effect. Frontend never sees it"
  echo "     (official rule: never put the key in frontend code)."
  echo "  5. Locally: export GOLD_API_KEY=... then re-run this script."
  exit 1
fi

if [ ! -f "$CANDLES" ]; then
  echo "ERROR: candles file not found: $CANDLES"
  echo "Run scripts/p70-sample.py first (or pass a candles.jsonl / spot-history export)."
  exit 1
fi

mkdir -p "$PROV"
: > "$OUT/provider-http.log"

# Select the last 10 COMPLETED minutes (t + 60 <= now, s >= 3), oldest→newest.
NOW=$(date +%s)
SELECTED=$(python3 -I - "$CANDLES" "$NOW" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
now = int(sys.argv[2])
done = sorted([r for r in rows
               if r.get("s", 0) >= 3 and isinstance(r.get("t"), int)
               and r["t"] % 60 == 0 and r["t"] + 60 <= now], key=lambda r: r["t"])
for r in done[-10:]:
    print(r["t"])
PY
)
COUNT=$(echo "$SELECTED" | grep -c . || true)
if [ "$COUNT" -lt 10 ]; then
  echo "ERROR: only $COUNT completed minutes available (need 10). Record more first."
  exit 1
fi
echo "Selected $COUNT minutes (UTC):"
for t in $SELECTED; do echo "  $(date -u -d @$t +%H:%M:%SZ)"; done

# Fire ≤10 requests, 7s apart, aborting on any error status.
i=0
for t in $SELECTED; do
  i=$((i+1))
  URL="https://api.gold-api.com/ohlc/XAU?startTimestamp=${t}&endTimestamp=$((t+60))"
  CODE=$(curl -s --max-time 20 -H "x-api-key: $KEY" \
        -o "$PROV/$t.json" -w "%{http_code}" "$URL")
  echo "req $i/10  t=$t  http=$CODE  bytes=$(wc -c < "$PROV/$t.json")" | tee -a "$OUT/provider-http.log"
  case "$CODE" in
    200) ;;
    429) echo "STOP: 429 — free-plan hourly quota reached. Wait a full hour."; exit 2 ;;
    401|403) echo "STOP: auth rejected ($CODE) — check the key / plan."; exit 3 ;;
    *) echo "STOP: unexpected status $CODE at minute $t."; exit 4 ;;
  esac
  sleep 7
done

echo "All $i responses saved to $PROV/ — building comparison:"
python3 -I /home/z/my-project/scripts/p70-compare.py "$CANDLES" "$PROV"