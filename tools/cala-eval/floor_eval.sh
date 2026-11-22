#!/bin/bash
# PR H, floor and default eval (results/2026-11-22-floor-eval-plan.md): headed Chrome, one run at a time, port 5198.
#
#   floor_eval.sh <rec>-<arm>-<rep> ...
#
# rec: sa = Samara 10_43_21, sb = Samara 14_57_02, ws = workshop prerecorded.
# arm: max (no pacing) or one of see, f14, f10, f07, whose fps comes from $OUT/targets.txt
#      (lines "<rec> <arm> <fps>", written from the Max runs by floor_eval_summary.py targets).
# Every run: `memory-measure.mjs --single --headed --every 5 --lookback [--pacefps F]`, from this worktree's HEAD.
# The driver clears the stored speed (`cala.speed.v1`), so the URL's `pacefps` alone sets the target.
# Load average at start and end of each run goes to $OUT/load.txt.
OUT=${OUT:-$HOME/Projects/cala-data/runs/floor-eval}
WT=${WT:-$HOME/Projects/CaLab-wt-floor-eval}
DRV=$WT/apps/cala/scripts/memory-measure.mjs
WS=$HOME/Projects/workshop-processing-and-analysis/data/sessions/prerecorded/raw
SA="/Users/daharoni/Downloads/Samara Data/10_43_21"
SB="/Users/daharoni/Downloads/Samara Data/14_57_02"
vpid=""
stop_server() { [ -n "$vpid" ] && kill $vpid 2>/dev/null; wait $vpid 2>/dev/null; vpid=""; sleep 2; }
start_server() {
  (cd "$WT/apps/cala" && exec node "$WT/node_modules/.bin/vite" --port 5198 --strictPort) > $OUT/vite.log 2>&1 &
  vpid=$!
  for i in $(seq 1 60); do curl -s -o /dev/null http://localhost:5198/ && break; sleep 1; done
  curl -s -o /dev/null "http://localhost:5198/?debug"; sleep 3
}
trap stop_server EXIT
mkdir -p $OUT
for tag in "$@"; do
  rec=${tag%%-*}; rest=${tag#*-}; arm=${rest%%-*}
  case $rec in sa) data=$SA;; sb) data=$SB;; ws) data=$WS;; *) echo "bad rec $rec"; exit 2;; esac
  [ -f $OUT/$tag-final.json ] && continue
  flags="--single --headed --every 5 --lookback"
  if [ $arm != max ]; then
    fps=$(awk -v r=$rec -v a=$arm '$1==r && $2==a {print $3}' $OUT/targets.txt)
    [ -z "$fps" ] && { echo "$(date +%T) $tag NO TARGET" >> $OUT/load.txt; continue; }
    flags="$flags --pacefps $fps"
  fi
  while pgrep -f "^node .*memory-measure.mjs" >/dev/null; do sleep 20; done
  [ -z "$vpid" ] && start_server
  head=$(git -C $WT rev-parse --short HEAD)
  echo "$(date +%T) $tag start load=$(sysctl -n vm.loadavg) head=$head flags=[$flags]" >> $OUT/load.txt
  node $DRV --url http://localhost:5198/ --data "$data" --out $OUT --tag $tag --cdp 9341 $flags > $OUT/$tag.out 2>&1
  rc=$?
  rm -rf $OUT/udd-$tag
  echo "$(date +%T) $tag exit=$rc load=$(sysctl -n vm.loadavg)" >> $OUT/load.txt
done
echo "$(date +%T) ALLDONE $*" >> $OUT/load.txt
