#!/bin/bash
# Visit budget sweep (results/2026-11-24-visit-budget-sweep.md): does quality depend on the slow loop's visits per frame?
#
#   visit_budget_sweep.sh run SIM SEED BUDGET [STEPS]
#                    one run: the first $FRAMES (3000) frames of a v3 sim, Discover with look-back, then the Thorough
#                    Final settle over the same frames (requests of 16). Discover frames earn BUDGET work units each,
#                    Final-settle frames STEPS x BUDGET (`--settle-steps`, default 1.2)
#   visit_budget_sweep.sh all     the main sweep: SIMS x SEEDS x BUDGETS at STEPS 1.2
#   visit_budget_sweep.sh stage   the stage split: Discover at 0.5x / 2x with the Final settle at 1x, and the reverse
#   visit_budget_sweep.sh high    Discover 4x / 8x with the Final settle near 1x
#   visit_budget_sweep.sh long    full-length (9600 frames) runs of v3_static_s6 at 0.5x, 1x, 2x
#
# The lock-step (untimed) slow loop is deterministic for a given --slow-seed: visits per frame scale with the work
# budget. 1x = 1.3e7 units per frame, which gives the app's visits per observed frame in Discover at Max (Chrome,
# v3_motion_s5 first 3000 frames: 0.216), and STEPS 1.2 its visits per Final-settle frame (about 0.9).
# Outputs only under $ROOT (default $CALA_DATA/runs/visit-sweep): <sim>_s<seed>_b<budget>_k<100 x steps>[_f<frames>]/
# with .log/.time/.done, and demix_metrics.py's files in the run directory. RAM about 1.5 GB per run.
source ~/Projects/cala-data/sims.env
ROOT=${ROOT:-$CALA_DATA/runs/visit-sweep}
BIN=${BIN:-$CALA_DATA/target-visit-sweep/release/examples/qc_eval}
HERE="$(cd "$(dirname "$0")" && pwd)"
D="--batch 8 --passes 1 --joint-update all --joint-sign all --lookback 2 --merge-guard-sep 0.6"
SIMS=${SIMS:-"v3_motion_s5 v3_static_s6 v3_static_s7"}
SEEDS=${SEEDS:-"1 2"}
BUDGETS=${BUDGETS:-"6500000 9200000 13000000 18400000 26000000"}

run() {
  SIM=$1; SEED=$2; B=$3; K=${4:-1.2}; F=${FRAMES:-3000}
  KK=$(awk "BEGIN {printf \"%d\", $K * 100 + 0.5}")
  OUT=$ROOT/${SIM}_s${SEED}_b${B}_k$KK
  [ "$F" != 3000 ] && OUT=${OUT}_f$F
  [ -f $OUT.done ] && return 0
  M=""
  case $SIM in *motion*) M="--motion" ;; esac
  mkdir -p $OUT
  /usr/bin/time -l $BIN sim $CALA_SIMS_V3/$SIM $OUT --budget $B $D --frames $F $M --slow-seed $SEED \
    --lookback-drain 0 --settle-frames $F --settle-batch 16 --settle-steps $K --dump --no-signed --no-heldout \
    > $OUT.log 2> $OUT.time
  rc=$?
  $MINISIM_PY "$HERE/demix_metrics.py" $CALA_SIMS_V3/$SIM $OUT > $OUT.demix.log 2>&1
  echo "rc $rc demix $?" > $OUT.done
}

# Wait until fewer than $PAR (2) of ours run, fewer than $MAXN (4) qc_eval sim/real processes run machine-wide, and
# at least 5 GB are free; then start the run in the background.
slot() {
  while true; do
    n=$(ps -axo command | grep -E "qc_eval[^ ]* (sim|real) " | grep -v "time -l" | grep -v grep | wc -l)
    free=$(vm_stat | awk '/Pages free|Pages inactive|Pages speculative/ {s+=$NF} END {print int(s*16384/1e9)}')
    [ $(jobs -r | wc -l) -lt ${PAR:-2} ] && [ $n -lt ${MAXN:-4} ] && [ $free -ge 5 ] && break
    sleep 10
  done
  run "$@" &
  sleep 2
}

case $1 in
run) shift; run "$@" ;;
all)
  for SEED in $SEEDS; do for B in $BUDGETS; do for SIM in $SIMS; do slot $SIM $SEED $B 1.2; done; done; done
  wait
  ;;
stage)
  # Discover 0.5x / 2x, Final settle 1x (steps 2.4 / 0.6); Discover 1x, Final settle 0.5x / 2x (steps 0.6 / 2.4).
  for SEED in $SEEDS; do
    for SIM in $SIMS; do
      slot $SIM $SEED 6500000 2.4
      slot $SIM $SEED 26000000 0.6
      slot $SIM $SEED 13000000 0.6
      slot $SIM $SEED 13000000 2.4
    done
  done
  wait
  ;;
high)
  # Added after the first read: Discover 4x / 8x with the Final settle held near 1x (steps 0.3 / 0.15).
  for SEED in $SEEDS; do for SIM in $SIMS; do slot $SIM $SEED 52000000 0.3; slot $SIM $SEED 104000000 0.15; done; done
  wait
  ;;
long)
  export FRAMES=9600
  for SEED in $SEEDS; do for B in 6500000 13000000 26000000; do slot v3_static_s6 $SEED $B 1.2; done; done
  wait
  ;;
esac
