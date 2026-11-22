#!/bin/bash
# One headed-Chrome run of the visit refit (results/2026-11-22-visit-refit.md): Discover, then the final settle.
#
#   visit_refit_chrome.sh TAG ws|10_43_21|14_57_02 FPS|max on|off
#
# Needs the dev server of this worktree on port 5198 (never 5190/5195). Refuses to start while any other
# memory-measure run is going (Chrome timings need a quiet machine; the caller waits for it with a Monitor loop).
# The recordings are read only: `--single` makes no export and the app's directory picker is removed.
# Outputs only under $OUT (default ~/Projects/cala-data/runs/work-slider-refit/chrome).
set -u
TAG=$1; REC=$2; FPS=$3; CS=$4
OUT=${OUT:-$HOME/Projects/cala-data/runs/work-slider-refit/chrome}
WS=${WS:-$HOME/Projects/workshop-processing-and-analysis/data/sessions/prerecorded/raw}
SAMARA=${SAMARA:-"$HOME/Downloads/Samara Data"}
cd "$(dirname "$0")/../.."
mkdir -p "$OUT"
[ -f "$OUT/$TAG-probe.json" ] && { echo "$TAG done already"; exit 0; }
if pgrep -f "^node .*memory-measure.mjs" > /dev/null; then echo "another memory-measure run is going" >&2; exit 2; fi
if [ "$REC" = ws ]; then data=$WS; else data="$SAMARA/$REC"; fi
flags="--single --lookback --headed --every 5"
[ "$FPS" != max ] && flags="$flags --pacefps $FPS"
# Background settle is on by default below Max now; `off` must switch it off (`&csettle=0`).
[ "$CS" = off ] && flags="$flags --csettle-off"
echo "$(date +%T) $TAG start load=$(sysctl -n vm.loadavg) head=$(git rev-parse --short HEAD)" >> "$OUT/load.txt"
node apps/cala/scripts/memory-measure.mjs --url http://localhost:5198/ --data "$data" --out "$OUT" --tag "$TAG" \
  $flags > "$OUT/$TAG.out" 2>&1
rc=$?
echo "$(date +%T) $TAG exit=$rc load=$(sysctl -n vm.loadavg)" >> "$OUT/load.txt"
exit $rc
