#!/bin/bash
# Real-data runs and reports of the concurrent-settle study, round 2 (results/2026-11-20-concurrent-settle2.md).
#
#   concsettle2_real.sh run NAME RECORDING SEED flags...   one stream run; waits for a free light slot
#   concsettle2_real.sh all                                every arm x recording x seed of the study
#   concsettle2_real.sh report PREFIX "seeds" [minian dir] agreement, checkpoints and run lines of one recording
#
# Outputs only under $CALA_DATA/runs/concsettle2/real; the recordings are read-only. Light-job rule: fewer than 6
# qc_eval sim/real processes machine-wide and at least 5 GB free before a run starts.
source ~/Projects/cala-data/sims.env
BIN=${BIN:-$CALA_DATA/bin/qc_eval-cs2-b}
ROOT=$CALA_DATA/runs/concsettle2/real
ME="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
ARMS="V30 CS2 CS2-Q"
SENS="CS1 CS2-Q18"
WS=${WS:-$HOME/Projects/workshop-processing-and-analysis/data/sessions/prerecorded/raw}
SAMARA=${SAMARA:-"$HOME/Downloads/Samara Data"}

arm_flags() {
  case $1 in
    V30) echo "--csettle 0" ;;
    CS1) echo "--csettle 0.5 --csettle-mode stats" ;;
    CS2) echo "--csettle 0.667 --csettle-mode stats" ;;
    CS2-Q) echo "--csettle 0.667 --csettle-mode stats --csettle-quiet 600" ;;
    CS2-Q18) echo "--csettle 0.667 --csettle-mode stats --csettle-quiet 1800" ;;
  esac
}

case $1 in
run)
  OUT=$ROOT/$2; REC=$3; SEED=$4; shift 4
  [ -f $OUT.done ] && exit 0
  mkdir -p $ROOT
  # One starter at a time looks at the slot count and launches (so waiters cannot overshoot the cap together).
  LOCK=$ROOT/.start.lock
  while true; do
    if mkdir $LOCK 2> /dev/null; then
      n=$(ps -axo command | grep -E "qc_eval[^ ]* (sim|real) " | grep -v "time -l" | grep -v grep | wc -l)
      free=$(vm_stat | awk '/Pages free|Pages inactive|Pages speculative/ {s+=$NF} END {print int(s*16384/1e9)}')
      if [ $n -lt ${MAXN:-6} ] && [ $free -ge 5 ]; then break; fi
      rmdir $LOCK
    fi
    sleep $((15 + RANDOM % 20))
  done
  mkdir -p $OUT
  /usr/bin/time -l $BIN real "$REC" $OUT --motion --batch 8 --budget 30000000 --slow-seed $SEED \
    --passes 1 --joint-update all --joint-sign all --lookback 2 --merge-guard-sep 0.6 \
    --offered-fps 30 --visit-workers 4 --pool 4 --lb-ms 5 --lib-at 0.125,0.25,0.375,0.5,0.625,0.75,0.875 \
    --settle-frames 18000 --settle-batch 16 --settle-libs --settle-check 1800 "$@" > $OUT.log 2> $OUT.time &
  PID=$!
  sleep 5
  rmdir $LOCK
  wait $PID
  echo "rc $?" > $OUT.done
  ;;
all)
  # Full arms first (they decide), then the two sensitivity arms (workshop, seeds 1-2).
  for arm in $ARMS; do
    F=$(arm_flags $arm)
    for s in 1 2 3; do $ME run ws_${arm}_s$s "$WS" $s --frames 18000 $F & done
    for ses in 10_43_21 14_57_02; do for s in 1 2; do
      $ME run ${ses}_${arm}_s$s "$SAMARA/$ses/img" $s --fps 30 $F &
    done; done
  done
  sleep 60
  for arm in $SENS; do
    F=$(arm_flags $arm)
    for s in 1 2; do $ME run ws_${arm}_s$s "$WS" $s --frames 18000 $F & done
  done
  wait
  echo ALLDONE > $ROOT/all.done
  ;;
report)
  P=$2; SEEDS=($3); M=$4
  cd "$(dirname "$ME")/../.."
  A=(); PR=(); k=0
  for n in $ARMS $SENS; do
    K=$(echo ABCDE | cut -c$((k + 1))); k=$((k + 1))
    [ -f $ROOT/${P}_${n}_s${SEEDS[0]}.done ] || continue
    for s in "${SEEDS[@]}"; do [ -f $ROOT/${P}_${n}_s$s.done ] && A+=(--run $K$s=$ROOT/${P}_${n}_s$s); done
    for t in settle0 settle1 settle2 settle3 settle5 settle7 final; do
      for ((i = 0; i < ${#SEEDS[@]}; i++)); do for ((j = i + 1; j < ${#SEEDS[@]}; j++)); do
        [ -f $ROOT/${P}_${n}_s${SEEDS[j]}.done ] && PR+=(--pair $K${SEEDS[i]}:$t,$K${SEEDS[j]}:$t)
      done; done
    done
    for t in settle0 final; do
      [ -n "$M" ] && for s in "${SEEDS[@]}"; do [ -f $ROOT/${P}_${n}_s$s.done ] && PR+=(--pair Minian,$K$s:$t); done
    done
    [ $K != A ] && for s in "${SEEDS[@]}"; do [ -f $ROOT/${P}_${n}_s$s.done ] && PR+=(--pair $K$s:settle0,A$s:final); done
  done
  for s in "${SEEDS[@]}"; do PR+=(--pair A$s:settle0,A$s:final); done
  /usr/bin/time -l $MINISIM_PY tools/cala-eval/lookback_settled.py real "${A[@]}" \
    --tags settle0,settle1,settle2,settle3,settle5,settle7,final "${PR[@]}" ${M:+--minian "$M"} \
    --md $ROOT/${P}_agreement.md > /dev/null 2> $ROOT/${P}_agreement.time
  grep "maximum resident" $ROOT/${P}_agreement.time
  R=()
  for n in $ARMS; do
    L=""
    for s in "${SEEDS[@]}"; do L="$L,$ROOT/${P}_${n}_s$s"; done
    R+=(--runs $n=${L#,})
  done
  $MINISIM_PY tools/cala-eval/concsettle_checkpoints.py "${R[@]}" --md $ROOT/${P}_checkpoints.md > /dev/null
  for n in $ARMS $SENS; do for s in "${SEEDS[@]}"; do
    [ -f $ROOT/${P}_${n}_s$s.log ] || continue
    echo "$n s$s: $(grep -h '^timed' $ROOT/${P}_${n}_s$s.log | tr '\n' ' ') | $(cat $ROOT/${P}_${n}_s$s/csettle.txt) | $(grep -h 'pass 1 done' $ROOT/${P}_${n}_s$s.log | cut -c1-80)"
  done; done > $ROOT/${P}_runs.txt
  cat $ROOT/${P}_runs.txt
  ;;
esac
