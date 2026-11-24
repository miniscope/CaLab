#!/bin/bash
# Visit budget confirmation on real data (results/2026-11-24-visit-budget-sweep.md, "Confirmation"):
#
#   visit_budget_real.sh run SEED BUDGET STEPS [REC]   one untimed run on a Samara recording (default 10_43_21)
#   visit_budget_real.sh queue "SEED:BUDGET:STEPS ..." run the listed jobs one after the other
#
# The recording is READ-ONLY (never written); outputs only under $ROOT (default $CALA_DATA/runs/visit-sweep/real):
# <rec>_s<seed>_b<budget>_k<100 x steps>/ with .log/.time/.done. Same flags as visit_budget_sweep.sh (Discover with
# look-back, then the Thorough Final settle over all frames), `--fps 30 --motion` as the earlier Samara runs.
# One run: about 1.3 GB RAM.
source ~/Projects/cala-data/sims.env
ROOT=${ROOT:-$CALA_DATA/runs/visit-sweep/real}
BIN=${BIN:-$CALA_DATA/target-visit-sweep/release/examples/qc_eval}
SAMARA=${SAMARA:-"$HOME/Downloads/Samara Data"}
D="--batch 8 --passes 1 --joint-update all --joint-sign all --lookback 2 --merge-guard-sep 0.6"
F=${FRAMES:-17879}

run() {
  SEED=$1; B=$2; K=$3; REC=${4:-10_43_21}
  KK=$(awk "BEGIN {printf \"%d\", $K * 100 + 0.5}")
  OUT=$ROOT/${REC}_s${SEED}_b${B}_k$KK
  [ -f $OUT.done ] && return 0
  mkdir -p $OUT
  /usr/bin/time -l $BIN real "$SAMARA/$REC/img" $OUT --motion --fps 30 --budget $B $D --slow-seed $SEED \
    --lookback-drain 0 --settle-frames $F --settle-batch 16 --settle-steps $K --no-heldout \
    > $OUT.log 2> $OUT.time
  echo "rc $?" > $OUT.done
}

case $1 in
run) shift; run "$@" ;;
queue)
  for j in $2; do IFS=: read s b k <<< "$j"; run $s $b $k; done
  ;;
esac
