#!/bin/bash
# Runs of the settle delta (`--csdelta`; results/2026-11-22-settle-delta.md).
#
#   csdelta.sh t0                       byte checks against main, flag off (static_s5, first 4800 frames)
#   csdelta.sh eq sim|10_43_21 SEED     one seed of the three arms on a full recording, background settle on (CS2F) at
#                                       30 fps offered: off (observe_settle), eqv (--csdelta charged what observe_settle
#                                       costs: same schedule, only the numbers differ), on (--csdelta at its own cost)
#
# Outputs only under $ROOT (default $CALA_DATA/runs/csdelta). The recordings are read-only. Light-job rule: fewer than
# $MAXN (default 6) qc_eval sim/real processes machine-wide and at least 5 GB free before a run starts.
source ~/Projects/cala-data/sims.env
ROOT=${ROOT:-$CALA_DATA/runs/csdelta}
BIN=${BIN:-$ROOT/bin/qc_eval-csdelta}
MAIN=${MAIN:-$ROOT/bin/qc_eval-main-3cb66a82}
ME="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
SAMARA=${SAMARA:-"$HOME/Downloads/Samara Data"}
D="--batch 8 --budget 30000000 --passes 1 --joint-update all --joint-sign all --lookback 2 --merge-guard-sep 0.6"
V="--visit-workers 4 --pool 4"
# The visit refit's model flags (results/2026-11-22-visit-refit.md, section 3, with the default four buffers).
CAL="--lb-gate --lb-ms 1.6 --lb-ms-per-cell 0.0082 --units-per-ms 1.6e6 --job-ms 1 --visit-units-per-ms 2.3e6"
CS2F="--csettle 0.667 --csettle-mode frames"

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
  T=$ROOT/t0
  S="sim $SIM_STATIC_S5"
  C="--frames 4800 $D --slow-seed 1 --dump --no-heldout --no-signed"
  O="--offered-fps 30 --lb-ms 5"
  for b in main new; do
    X=$BIN; [ $b = main ] && X=$MAIN
    slot_run $T/${b}_vw $X $S $T/${b}_vw $C $O $V --csettle 0 &
    slot_run $T/${b}_cs2f $X $S $T/${b}_cs2f $C $O $V $CS2F &
    sleep 2
  done
  wait
  cd "$(dirname "$ME")/../.."
  for k in vw cs2f; do
    echo "main_$k vs new_$k: $($MINISIM_PY tools/cala-eval/cmp_runs.py $T/main_$k $T/new_$k | tail -3 | tr '\n' ' ')"
  done > $T/report.txt
  cat $T/report.txt
  ;;
eq)
  REC=$2; SEED=$3
  if [ $REC = sim ]; then
    S="sim $SIM_STATIC_S5"; E="--dump"
  else
    S="real $SAMARA/$REC/img"; E="--motion --fps 30"
  fi
  for arm in off eqv on; do
    case $arm in
      off) F="" ;;
      eqv) F="--csdelta --csdelta-charge-equiv" ;;
      on) F="--csdelta" ;;
    esac
    OUT=$ROOT/eq/${REC}_s${SEED}_$arm
    if [ $REC = sim ]; then
      slot_run $OUT $BIN $S $OUT $D $E --slow-seed $SEED $V $CAL --offered-fps 30 $CS2F $F &
    else
      slot_run $OUT $BIN real "$SAMARA/$REC/img" $OUT $D $E --slow-seed $SEED $V $CAL --offered-fps 30 $CS2F $F &
    fi
    sleep 2
  done
  wait
  ;;
esac
