#!/bin/bash
# One headed-Chrome run of the settle delta (results/2026-11-22-settle-delta.md): Discover with the background settle
# (governor, one settle pool worker), then the final settle.
#
#   csdelta_chrome.sh TAG ws|10_43_21 FPS off|on
#
# Needs the dev server of this worktree on port 5197. Refuses to start while any other memory-measure run is going
# (Chrome timings need a quiet machine). The recordings are read only: `--single` makes no export and the app's
# directory picker is removed. Outputs only under $OUT (default ~/Projects/cala-data/runs/csdelta/chrome).
set -u
TAG=$1; REC=$2; FPS=$3; DELTA=$4
OUT=${OUT:-$HOME/Projects/cala-data/runs/csdelta/chrome}
WS=${WS:-$HOME/Projects/workshop-processing-and-analysis/data/sessions/prerecorded/raw}
SAMARA=${SAMARA:-"$HOME/Downloads/Samara Data"}
cd "$(dirname "$0")/../.."
mkdir -p "$OUT"
[ -f "$OUT/$TAG-probe.json" ] && { echo "$TAG done already"; exit 0; }
if pgrep -f "^node .*memory-measure.mjs" > /dev/null; then echo "another memory-measure run is going" >&2; exit 2; fi
if [ "$REC" = ws ]; then data=$WS; else data="$SAMARA/$REC"; fi
flags="--single --lookback --csettle --headed --every 5 --governor --lbpool 1 --pacefps $FPS"
[ "$DELTA" = on ] && flags="$flags --csdelta"
echo "$(date +%T) $TAG start load=$(sysctl -n vm.loadavg) head=$(git rev-parse --short HEAD)" >> "$OUT/load.txt"
node apps/cala/scripts/memory-measure.mjs --url http://localhost:5197/ --data "$data" --out "$OUT" --tag "$TAG" \
  $flags > "$OUT/$TAG.out" 2>&1
rc=$?
echo "$(date +%T) $TAG exit=$rc load=$(sysctl -n vm.loadavg)" >> "$OUT/load.txt"
exit $rc
