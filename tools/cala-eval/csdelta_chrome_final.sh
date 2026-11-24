#!/bin/bash
# Final settle in headed Chrome (real GPU), settle delta off against on, interleaved, one run at a time (PR #470).
#
#   csdelta_chrome_final.sh URL DATA OUT REPS ARMS SETS
#
# DATA holds sim1k/ and sim3k/ (one recording each: the first 1 and 3 AVIs of v3_motion_s5) and joint/ (A/ and B/:
# AVI 0 and AVI 5 of sims-sessions/motion_s5_shift15). ARMS like "off on", SETS like "sim1k sim3k joint". Tags:
# <set>-<arm>-<rep>. Summarise with csdelta_chrome_final.py; ground truth with settle_readers_summary.py.
URL=$1; DATA=$2; OUT=$3; REPS=$4; ARMS=$5; SETS=$6
HERE="$(cd "$(dirname "$0")" && pwd)"
MM="$HERE/../../apps/cala/scripts/memory-measure.mjs"
mkdir -p "$OUT"
for rep in $(seq 1 "$REPS"); do
  for set in $SETS; do
    for arm in $ARMS; do
      tag=$set-$arm-$rep
      [ -f "$OUT/$tag-probe.json" ] && continue
      F=""
      case $arm in on | on*) F="--csdelta" ;; esac
      # An arm ending in a number paces Discover at that many fps (e.g. on30): Background settle runs.
      P=$(echo "$arm" | sed -n 's/^[a-z]*\([0-9][0-9]*\)$/\1/p')
      [ -n "$P" ] && F="$F --pacefps $P"
      if [ "$set" = joint ]; then
        S="--data $DATA/joint --mode joint --stop-after-settle"
      else
        S="--data $DATA/$set --single"
      fi
      node "$MM" --url "$URL" $S --out "$OUT" --tag "$tag" --lookback --headed --every 5 --max-min 20 --cdp 9341 $F \
        > "$OUT/$tag.stdout" 2>&1
      echo "$tag rc $?"
      rm -rf "$OUT/udd-$tag"
    done
  done
done
