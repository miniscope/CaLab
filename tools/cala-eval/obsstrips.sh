#!/bin/bash
# qc_eval runs of the strip helpers (`--observe-strips N`; the slow loop's footprint statistics summed by row strip).
#
#   obsstrips.sh t0 TAG BIN          the three byte-check arms of PR #470 with BIN (flag off): vw (static_s5, 4800
#                                    frames, visit workers), cs2f (the same with the Background settle), fs
#                                    (v3_motion_s5, 1000 frames plus a 1000-frame Final settle). Compare two tags
#                                    with `cmp_runs.py $ROOT/t0/<a>_<arm> $ROOT/t0/<b>_<arm>`.
#   obsstrips.sh eq FRAMES SEED N    v3_motion_s5, FRAMES frames plus a FRAMES-frame Final settle, arms off and
#                                    strips (--observe-strips N), untimed (deterministic); compare with
#                                    `obsstrips_eq.py`.
#
# Two runs at a time at most. Outputs only under $ROOT (default $CALA_DATA/runs/obsstrips).
source ~/Projects/cala-data/sims.env
ROOT=${ROOT:-$CALA_DATA/runs/obsstrips}
D="--batch 8 --budget 30000000 --passes 1 --joint-update all --joint-sign all --lookback 2 --merge-guard-sep 0.6"

run() {
  OUT=$1; shift
  [ -f $OUT.done ] && return 0
  mkdir -p $OUT
  /usr/bin/time -l "$@" > $OUT.log 2> $OUT.time
  echo "rc $?" > $OUT.done
}

case $1 in
t0)
  TAG=$2; BIN=$3; T=$ROOT/t0
  C="--frames 4800 $D --slow-seed 1 --dump --no-heldout --no-signed --offered-fps 30 --lb-ms 5 --visit-workers 4 --pool 4"
  run $T/${TAG}_vw $BIN sim $SIM_STATIC_S5 $T/${TAG}_vw $C --csettle 0 &
  run $T/${TAG}_cs2f $BIN sim $SIM_STATIC_S5 $T/${TAG}_cs2f $C --csettle 0.667 --csettle-mode frames &
  wait
  run $T/${TAG}_fs $BIN sim $SIMV3_V3_MOTION_S5 $T/${TAG}_fs $D --frames 1000 --motion --slow-seed 1 \
    --lookback-drain 0 --settle-frames 1000 --settle-batch 16
  ;;
eq)
  N=$2; SEED=$3; K=$4; BIN=${BIN:?set BIN to a qc_eval built from this branch}
  S="--frames $N --motion --slow-seed $SEED --lookback-drain 0 --settle-frames $N --settle-batch 16"
  run $ROOT/eq/${N}_s${SEED}_off $BIN sim $SIMV3_V3_MOTION_S5 $ROOT/eq/${N}_s${SEED}_off $D $S &
  run $ROOT/eq/${N}_s${SEED}_k$K $BIN sim $SIMV3_V3_MOTION_S5 $ROOT/eq/${N}_s${SEED}_k$K $D $S --observe-strips $K &
  wait
  ;;
esac
