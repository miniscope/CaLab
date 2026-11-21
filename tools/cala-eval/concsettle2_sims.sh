#!/bin/bash
# Sim re-check of the concurrent-settle study, round 2 (target S1): the stream baseline with four visit workers and
# one settle arm, each with tails none / S4800 / S9600, branched after Discover.
#   concsettle2_sims.sh NAME TIER PARALLEL "LABEL=extra flags" ...
source ~/Projects/cala-data/sims.env
cd "$(dirname "$0")/../.."
BIN=${BIN:-$CALA_DATA/bin/qc_eval-cs2-b}
NAME=$1; TIER=$2; PAR=$3; shift 3
D="--passes 1 --joint-update all --joint-sign all --lookback 2 --merge-guard-sep 0.6 --offered-fps 30 --visit-workers 4 --pool 4 --lb-ms 5 --lib-at 0.125,0.25,0.375,0.5,0.625,0.75,0.875"
ARMS=()
for a in "$@"; do ARMS+=(--arm "${a%%=*}=$D ${a#*=}"); done
$MINISIM_PY tools/cala-eval/arm_tree.py --tier $TIER ${ONLY:+--only $ONLY} --bin $BIN --name $NAME --parallel $PAR \
  --branch-after discover "${ARMS[@]}" >> $CALA_DATA/demix-suite/$NAME.log 2>&1
echo "DONE $NAME rc $?" >> $CALA_DATA/demix-suite/cs2.done
