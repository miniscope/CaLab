#!/bin/bash
# Strip helpers in headed Chrome (real GPU): N = 0 (off) against N helpers, interleaved, one run at a time.
#
#   obsstrips_chrome.sh URL DATA OUT REPS ARMS SETS [CDP]
#
# DATA holds sim1k/ and sim3k/ (the first 1 and 3 AVIs of v3_motion_s5; `runs/settle-feed/data`). ARMS like
# "s0 s2 s4" (sN: `?debug&obsstrips=N`, s0 = off), SETS like "sim3k sim1k". Each run is Discover at Max then the
# Final settle. Tags: <set>-<arm>-<rep>. Summarise with obsstrips_chrome.py.
URL=$1; DATA=$2; OUT=$3; REPS=$4; ARMS=$5; SETS=$6; CDP=${7:-9363}
HERE="$(cd "$(dirname "$0")" && pwd)"
MM="$HERE/../../apps/cala/scripts/memory-measure.mjs"
mkdir -p "$OUT"
for rep in $(seq 1 "$REPS"); do
  for set in $SETS; do
    for arm in $ARMS; do
      tag=$set-$arm-$rep
      [ -f "$OUT/$tag-probe.json" ] && continue
      N=${arm#s}
      Q=""
      [ "$N" != 0 ] && Q="&obsstrips=$N"
      node "$MM" --url "$URL" --data "$DATA/$set" --single --out "$OUT" --tag "$tag" --lookback --headed \
        --every 5 --max-min 20 --cdp "$CDP" --query "$Q" > "$OUT/$tag.stdout" 2>&1
      echo "$tag rc $?"
      rm -rf "$OUT/udd-$tag"
    done
  done
done
