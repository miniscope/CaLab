#!/bin/bash
# Final-settle runs of the settle delta in qc_eval (`--settle-delta`; PR #470).
#
#   csdelta_final.sh eq FRAMES SEED   one seed, arms off (observe) and on (--settle-delta), the first FRAMES frames of
#                                     v3_motion_s5 (motion corrected), the Final settle over the same FRAMES frames
#                                     in requests of 16; two runs at a time
#
# Outputs under $ROOT (default $CALA_DATA/runs/csdelta/final): <FRAMES>_s<SEED>_<arm>{,.log,.time,.done}. Compare
# with `csdelta_eq.py $ROOT sim<FRAMES> 1,2,3` after renaming, or `csdelta_final_eq.py`.
source ~/Projects/cala-data/sims.env
ROOT=${ROOT:-$CALA_DATA/runs/csdelta/final}
BIN=${BIN:?set BIN to a qc_eval built from this branch}
D="--batch 8 --budget 30000000 --passes 1 --joint-update all --joint-sign all --lookback 2 --merge-guard-sep 0.6"

case $1 in
eq)
  N=$2; SEED=$3
  S="--frames $N --motion --slow-seed $SEED --lookback-drain 0 --settle-frames $N --settle-batch 16"
  for arm in off on; do
    F=""; [ $arm = on ] && F="--settle-delta"
    OUT=$ROOT/${N}_s${SEED}_$arm
    [ -f $OUT.done ] && continue
    mkdir -p $OUT
    (/usr/bin/time -l $BIN sim $SIMV3_V3_MOTION_S5 $OUT $D $S $F > $OUT.log 2> $OUT.time; echo "rc $?" > $OUT.done) &
  done
  wait
  ;;
esac
