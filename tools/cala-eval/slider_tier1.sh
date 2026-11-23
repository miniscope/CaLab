#!/bin/bash
# Work-slider tier 1 (results/2026-11-22-slider-tier1-plan.md): one Discover per (recording or sim, seed, arm),
# branched after Discover into Final-settle budgets of 0, 1/4, 1/2, 3/4 and 1 pass.
#
#   slider_tier1.sh real ARM sa|sb SEED      one Samara run (sa = 10_43_21, sb = 14_57_02), full length
#   slider_tier1.sh sim ARM SIM_DIR SEED     one sim run (9600 frames)
#   slider_tier1.sh smoke                    static_s5, first 2400 frames, every arm's flags and branches
#
# ARM: REF (Max), P30, P60 (paced, no background settle), S30, S60 (paced, background settle cap 2, the app's
# one look-back worker taking turns). Model flags: #456 round 2 plus --visit-units-per-ms 2.3e6, --pool 4 (the
# recommendation of results/2026-11-22-visit-refit.md). Outputs only under $ROOT; the recordings are read-only.
# Light-job rule: fewer than $MAXN (6) qc_eval sim/real processes machine-wide and at least 5 GB free before a run.
source ~/Projects/cala-data/sims.env
ROOT=${ROOT:-$CALA_DATA/runs/work-slider-tier1}
BIN=${BIN:-$ROOT/bin/qc_eval-tier1-940db2b6}
SAMARA=${SAMARA:-"$HOME/Downloads/Samara Data"}
D="--batch 8 --budget 30000000 --passes 1 --joint-update all --joint-sign all --lookback 2 --merge-guard-sep 0.6"
CAL="--visit-workers 4 --pool 4 --lb-gate --lb-ms 1.6 --lb-ms-per-cell 0.0082 --units-per-ms 1.6e6 --job-ms 1"
CAL="$CAL --visit-units-per-ms 2.3e6"
LIBS="--lib-at 0.125,0.25,0.5,0.75"

# arm_flags ARM MAXFPS
arm_flags() {
  case $1 in
    REF) echo "--offered-fps $2 --csettle 0" ;;
    P30) echo "--offered-fps 30 --csettle 0" ;;
    P60) echo "--offered-fps 60 --csettle 0" ;;
    S30) echo "--offered-fps 30 --csettle 0.667 --csettle-mode frames" ;;
    S60) echo "--offered-fps 60 --csettle 0.667 --csettle-mode frames" ;;
    *) echo "unknown arm $1" >&2; exit 1 ;;
  esac
}

# branches T: Final-settle budgets for a recording of T frames. Partial budgets are spread evenly over the
# recording (whole 64-frame blocks, every 4th or 2nd block), as the app's settlePlan spreads a budget below the
# recording's length; the full pass reads the recording in order (the app's plan for T <= 18000), with checkpoint
# libraries every 1200 frames (the app's checkEvery) for the stop test.
branches() {
  T=$1; q=$((T / 4)); h=$((T / 2))
  C="--settle-batch 16 --settle-check 1200"
  echo "B0:"
  echo "B25:--settle-frames $q --settle-round $q $C"
  echo "B50:--settle-frames $h --settle-round $h $C"
  echo "B75:--settle-frames $((3 * q)) --settle-round $q $C"
  echo "B100:--settle-frames $T $C --settle-libs"
}

slot_run() {
  OUT=$1; shift
  [ -f $OUT.done ] && return 0
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

mkdir -p $ROOT
case $1 in
real)
  ARM=$2; REC=$3; SEED=$4
  case $REC in
    sa) DIR=10_43_21; T=17879; MAX=343 ;;
    sb) DIR=14_57_02; T=17875; MAX=348 ;;
    *) echo "unknown recording $REC" >&2; exit 1 ;;
  esac
  OUT=$ROOT/real/${REC}_${ARM}_s$SEED
  mkdir -p $ROOT/real
  BR=()
  while IFS= read -r b; do BR+=(--branch "$b"); done < <(branches $T)
  slot_run $OUT $BIN real "$SAMARA/$DIR/img" $OUT --motion --fps 30 $D --slow-seed $SEED $CAL $LIBS \
    $(arm_flags $ARM $MAX) --branch-after discover "${BR[@]}"
  ;;
sim)
  # Sims: "Max" = 340 fps (Samara's Chrome Max; the sims are 600 x 600 px like Samara; no Chrome run on a sim).
  ARM=$2; SIM=$3; SEED=$4
  OUT=$ROOT/sims/$(basename $SIM)_${ARM}_s$SEED
  mkdir -p $ROOT/sims
  BR=()
  while IFS= read -r b; do BR+=(--branch "$b"); done < <(branches 9600)
  slot_run $OUT $BIN sim "$SIM" $OUT $D --slow-seed $SEED $CAL $LIBS \
    $(arm_flags $ARM 340) --branch-after discover "${BR[@]}"
  ;;
smoke)
  for ARM in REF S30; do
    OUT=$ROOT/smoke/static_s5_$ARM
    mkdir -p $ROOT/smoke
    BR=()
    while IFS= read -r b; do BR+=(--branch "$b"); done < <(branches 2400)
    slot_run $OUT $BIN sim "$SIM_STATIC_S5" $OUT --frames 2400 $D --slow-seed 1 --dump --no-signed $CAL $LIBS \
      $(arm_flags $ARM 340) --branch-after discover "${BR[@]}" &
  done
  wait
  ;;
esac
