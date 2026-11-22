#!/bin/zsh
# PR H: fixed-library scoring of one Chrome final library (plan: quality proxies). No slow loop: qc_eval re-runs
# the app's preprocessing and motion on the recording, solves the traces with the fixed library, and writes the
# held-out score, the QC metrics and the traces (`--dump`). Sims (m5, t6) run `qc_eval sim`: also matched against
# the ground truth (`final.tsv` matched / best_r, `global.tsv` gt_precision / gt_recall / gt_median_true_r).
#   floor_eval_score.sh TAG [SCOREDIR]     (SCOREDIR defaults to TAG; it must hold footprints.bin)
OUT=${OUT:-$HOME/Projects/cala-data/runs/floor-eval}
BIN=${BIN:-$HOME/Projects/cala-data/bin/qc_eval-floor-eval-8a39a648}
tag=$1; sd=${2:-$1}; rec=${tag%%-*}
case $rec in
  sa) data="/Users/daharoni/Downloads/Samara Data/10_43_21/img"; fps=30;;
  sb) data="/Users/daharoni/Downloads/Samara Data/14_57_02/img"; fps=30;;
  ws) data=$HOME/Projects/workshop-processing-and-analysis/data/sessions/prerecorded/raw; fps=20;;
  m5) data=$HOME/Projects/cala-data/sims-v3/v3_motion_s5; fps=20; mode=sim;;
  t6) data=$HOME/Projects/cala-data/sims-v3/v3_static_s6; fps=20; mode=sim; motion="--motion --gt-offset none";;  # static: no shifts.npy; registration is near identity
esac
mode=${mode:-real}; motion=${motion---motion}
S=$OUT/score/$sd
[ -f $S/done ] && exit 0
/usr/bin/time -l nice $BIN $mode "$data" $S ${=motion} --batch 8 --fps $fps --slow-seed ${SEED:-1} \
  --library $S/footprints.bin --dump --no-signed ${=EXTRA} > $S/log 2> $S/time
echo "rc $?" > $S/done
