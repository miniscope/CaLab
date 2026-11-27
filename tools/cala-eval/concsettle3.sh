#!/bin/bash
# Runs of the concurrent-settle study, round 3 (results/2026-11-21-concurrent-settle3.md): why Discover makes fewer
# of its own visits with the settle on, and a fix.
#
#   concsettle3.sh t0                                    byte checks against main (static_s5, first 4800 frames)
#   concsettle3.sh run NAME RECORDING SEED flags...      one stream run; waits for a free light slot
#   concsettle3.sh diag                                  the diagnosis runs (phase A)
#   concsettle3.sh arm ARM ws|10_43_21|14_57_02 SEED     one run of an arm
#   concsettle3.sh smoke                                 the yield path on static_s5
#   concsettle3.sh fix                                   phase B
#
# Outputs only under $CALA_DATA/runs/concsettle3; the recordings are read-only. Light-job rule: fewer than 6
# qc_eval sim/real processes machine-wide and at least 5 GB free before a run starts.
source ~/Projects/cala-data/sims.env
BIN=${BIN:-$CALA_DATA/bin/qc_eval-cs3-a}
MAIN=${MAIN:-$CALA_DATA/bin/qc_eval-main-9ed6e4bb}
ROOT=$CALA_DATA/runs/concsettle3
ME="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
WS=${WS:-$HOME/Projects/workshop-processing-and-analysis/data/sessions/prerecorded/raw}
SAMARA=${SAMARA:-"$HOME/Downloads/Samara Data"}
D="--batch 8 --budget 30000000 --passes 1 --joint-update all --joint-sign all --lookback 2 --merge-guard-sep 0.6"
V="--offered-fps 30 --visit-workers ${VW:-4} --pool 4 --lb-ms 5"

arm_flags() {
  case $1 in
    V30) echo "--csettle 0" ;;
    CS2F) echo "--csettle 0.667 --csettle-mode frames" ;;
    # Diagnosis: the re-read frames at no cost to the slow worker; the slow worker's lost time without the frames.
    CS2F-free) echo "--csettle 0.667 --csettle-mode frames --cs-answer-scale 0" ;;
    V30-load) echo "--csettle 0 --owner-load $LOAD" ;;
    # The app design under test in phase B: the slow worker takes an answer one frame at a time.
    CS2F-Y1) echo "--csettle 0.667 --csettle-mode frames --csettle-yield 1" ;;
    # Capacity control: the baseline with three visit workers (run with VW=3).
    V30-W3) echo "--csettle 0" ;;
    *) echo "unknown arm $1" >&2; exit 1 ;;
  esac
}

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
  # Flags off = main, and --visit-diag changes no other output.
  T=$ROOT/t0
  S="sim $SIM_STATIC_S5"
  C="--frames 4800 $D --slow-seed 1 --dump --no-heldout --no-signed"
  for b in main new; do
    X=$BIN; [ $b = main ] && X=$MAIN
    slot_run $T/${b}_settle $X $S $T/${b}_settle $C --settle-frames 2400 --settle-batch 16 &
    slot_run $T/${b}_vw $X $S $T/${b}_vw $C $V --csettle 0 &
    slot_run $T/${b}_cs2f $X $S $T/${b}_cs2f $C $V --csettle 0.667 --csettle-mode frames &
    sleep 2
  done
  slot_run $T/diag_vw $BIN $S $T/diag_vw $C $V --csettle 0 --visit-diag &
  slot_run $T/diag_cs2f $BIN $S $T/diag_cs2f $C $V --csettle 0.667 --csettle-mode frames --visit-diag &
  wait
  cd "$(dirname "$ME")/../.."
  for k in settle vw cs2f; do
    echo "main_$k vs new_$k: $($MINISIM_PY tools/cala-eval/cmp_runs.py $T/main_$k $T/new_$k | tail -3 | tr '\n' ' ')"
  done > $T/report.txt
  for k in vw cs2f; do
    echo "new_$k vs diag_$k: $($MINISIM_PY tools/cala-eval/cmp_runs.py $T/new_$k $T/diag_$k | tail -3 | tr '\n' ' ')"
  done >> $T/report.txt
  cat $T/report.txt
  ;;
run)
  NAME=$2; REC=$3; SEED=$4; shift 4
  slot_run $ROOT/real/$NAME $BIN real "$REC" $ROOT/real/$NAME --motion $D --slow-seed $SEED $V \
    --lib-at 0.125,0.25,0.375,0.5,0.625,0.75,0.875 \
    --settle-frames 18000 --settle-batch 16 --settle-libs --settle-check 1800 --visit-diag "$@"
  ;;
diag)
  # Phase A: one seed, the instrument on; the two knob arms on the workshop recording.
  for spec in "V30 ws 1" "CS2F ws 1" "CS2F-free ws 1" "V30-load ws 1" "V30 10_43_21 1" "CS2F 10_43_21 1"; do
    LOAD=61:267 $ME arm $spec &
    sleep 1
  done
  wait
  echo ALLDONE > $ROOT/diag.done
  ;;
smoke)
  # The yield path on static_s5 (4800 frames): a whole chunk per piece equals no yield; one frame per piece runs.
  T=$ROOT/t0
  S="sim $SIM_STATIC_S5"
  C="--frames 4800 $D --slow-seed 1 --dump --no-heldout --no-signed"
  slot_run $T/y16_cs2f $BIN $S $T/y16_cs2f $C $V --csettle 0.667 --csettle-mode frames --csettle-yield 16 &
  slot_run $T/y1_cs2f $BIN $S $T/y1_cs2f $C $V --csettle 0.667 --csettle-mode frames --csettle-yield 1 --visit-diag &
  wait
  cd "$(dirname "$ME")/../.."
  echo "new_cs2f vs y16_cs2f: $($MINISIM_PY tools/cala-eval/cmp_runs.py $T/new_cs2f $T/y16_cs2f | tail -3 | tr '\n' ' ')" > $T/report_yield.txt
  cat $T/y1_cs2f/timed.txt >> $T/report_yield.txt
  cat $T/report_yield.txt
  ;;
fix)
  # Phase B: the yield arm on every recording-seed; the scheduling ceiling and the capacity control on the
  # workshop recording.
  for s in 1 2 3; do $ME arm CS2F-Y1 ws $s & sleep 1; done
  for ses in 10_43_21 14_57_02; do for s in 1 2; do $ME arm CS2F-Y1 $ses $s & sleep 1; done; done
  for s in 2 3; do $ME arm CS2F-free ws $s & sleep 1; done
  for s in 1 2 3; do VW=3 $ME arm V30-W3 ws $s & sleep 1; done
  wait
  echo ALLDONE > $ROOT/fix.done
  ;;
arm)
  # concsettle3.sh arm ARM RECORDING(ws|10_43_21|14_57_02) SEED
  F=$(arm_flags $2) || exit 1
  if [ $3 = ws ]; then
    $ME run ws_$2_s$4 "$WS" $4 --frames 18000 $F
  else
    $ME run $3_$2_s$4 "$SAMARA/$3/img" $4 --fps 30 $F
  fi
  ;;
esac
