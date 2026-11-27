#!/bin/bash
# Runs of the work-slider calibration (results/2026-11-21-work-slider-plan.md, results/2026-11-21-work-slider.md).
#
#   work_slider.sh t0                                  byte checks against main (static_s5, first 4800 frames)
#   work_slider.sh run NAME ws|10_43_21|14_57_02 SEED flags...
#                                                      one real run, full length, Discover only (no final settle);
#                                                      waits for a free light slot
#   work_slider.sh arm NAME ws|10_43_21|14_57_02 SEED FPS off|on [flags...]
#                                                      one calibration run: offered FPS, look-back on, background
#                                                      settle off (--csettle 0) or on (CS2F); the model's cost flags
#                                                      come from $CAL (split here, by bash)
#
# Outputs only under $ROOT (default $CALA_DATA/runs/work-slider; the visit refit sets runs/work-slider-refit); POOL
# sets --pool (default 4). The recordings are read-only. Light-job rule: fewer than $MAXN
# (default 6) qc_eval sim/real processes machine-wide and at least 5 GB free before a run starts.
source ~/Projects/cala-data/sims.env
BIN=${BIN:-$CALA_DATA/runs/work-slider/bin/qc_eval-cal-a}
MAIN=${MAIN:-$CALA_DATA/runs/work-slider/bin/qc_eval-main-d37da856}
ROOT=${ROOT:-$CALA_DATA/runs/work-slider}
ME="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
WS=${WS:-$HOME/Projects/workshop-processing-and-analysis/data/sessions/prerecorded/raw}
SAMARA=${SAMARA:-"$HOME/Downloads/Samara Data"}
D="--batch 8 --budget 30000000 --passes 1 --joint-update all --joint-sign all --lookback 2 --merge-guard-sep 0.6"
V="--visit-workers ${VW:-4} --pool ${POOL:-4}"

# Wait for a light slot, then run "$@" (a qc_eval command line) with its log, time and done files at $OUT.
slot_run() {
  OUT=$1; shift
  [ -f $OUT.done ] && return 0
  mkdir -p $ROOT
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
  /usr/bin/time -l "$@" > $OUT.log 2> $OUT.time &
  PID=$!
  sleep 5
  rmdir $LOCK
  wait $PID
  echo "rc $?" > $OUT.done
}

case $1 in
t0)
  # Flags off = main: lock-step with a final settle, the virtual clock with visit workers (V30, CS2F).
  T=$ROOT/t0
  S="sim $SIM_STATIC_S5"
  C="--frames 4800 $D --slow-seed 1 --dump --no-heldout --no-signed"
  O="--offered-fps 30 --lb-ms 5"
  for b in main new; do
    X=$BIN; [ $b = main ] && X=$MAIN
    slot_run $T/${b}_settle $X $S $T/${b}_settle $C --settle-frames 2400 --settle-batch 16 &
    slot_run $T/${b}_vw $X $S $T/${b}_vw $C $O $V --csettle 0 &
    slot_run $T/${b}_cs2f $X $S $T/${b}_cs2f $C $O $V --csettle 0.667 --csettle-mode frames &
    sleep 2
  done
  wait
  cd "$(dirname "$ME")/../.."
  for k in settle vw cs2f; do
    echo "main_$k vs new_$k: $($MINISIM_PY tools/cala-eval/cmp_runs.py $T/main_$k $T/new_$k | tail -3 | tr '\n' ' ')"
  done > $T/report.txt
  cat $T/report.txt
  ;;
run)
  NAME=$2; REC=$3; SEED=$4; shift 4
  if [ $REC = ws ]; then
    slot_run $ROOT/real/$NAME $BIN real "$WS" $ROOT/real/$NAME --motion $D --slow-seed $SEED $V "$@"
  else
    slot_run $ROOT/real/$NAME $BIN real "$SAMARA/$REC/img" $ROOT/real/$NAME --motion --fps 30 $D --slow-seed $SEED \
      $V "$@"
  fi
  ;;
arm)
  NAME=$2; REC=$3; SEED=$4; FPS=$5; ARM=$6; shift 6
  case $ARM in
    off) F="--csettle 0" ;;
    on) F="--csettle 0.667 --csettle-mode frames" ;;
    *) echo "unknown arm $ARM" >&2; exit 1 ;;
  esac
  $ME run $NAME $REC $SEED --offered-fps $FPS $F $CAL "$@"
  ;;
esac
