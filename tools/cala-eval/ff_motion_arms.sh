#!/bin/bash
# Flat-field motion-gain arms (results/2026-11-27-ff-motion-gain.md), rigid registration only.
#
#   tools/cala-eval/ff_motion_arms.sh <arm> <seed...>
#
# Needs in $R (default ~/Projects/cala-data/runs/ff-motion-gain):
#   bin/motion_eval_main  motion_eval built from main (with the MOTION_FF_* knobs)
#   bin/motion_eval_fix   motion_eval built from this branch
#   front/v3_motion_s<seed>/cala_rigid.npy   the no-flat-field ("plain") shifts (MOTION_FRONT=1 run)
#   gt/<sim>/             motion ground truth (export_gt_nonrigid.py; --prnu for the fpn sims)
#   scaled105/<sim>.npy   the plain shifts x 1.05; fpn/truthshifts/<sim>.npy the true shifts
#                         (registering sign, offset matched to the front run)
# v3_motion arms (sims in $CALA_SIMS_V3):
#   ff          main, online flat field (maps saved)       fix         branch, the same
#   fixed       main's final map applied from frame 0       fixfixed    the fix's final map from frame 0
#   plainfed    main, estimator fed the plain shifts        fixplainfed branch, the same
#   mainfed105  main, fed the plain shifts x 1.05           fixfed105   branch, the same
#   fixrefed    branch, fed fixfed105's output shifts (one more step round the loop)
# fpn arms (sims in $FPN_SIMS, sensor PRNU + column FPN + hot pixels):
#   fpn-front   no flat field (MOTION_FRONT=1)   fpn-ff / fpn-fix   main / branch, online flat field
#   fpn-fftruth / fpn-fixtruth                   main / branch, estimator fed the true shifts
# One job at a time per call (~1-3 min, < 1 GB each); run at most two calls at once.
# Score: motion_ff_score.py (gain, error), motion_bias.py --blocks 1200, ff_map_score.py (fpn maps).
set -euo pipefail
R=${R:-$HOME/Projects/cala-data/runs/ff-motion-gain}
S=${CALA_SIMS_V3:-$HOME/Projects/cala-data/sims-v3}
F=${FPN_SIMS:-$HOME/Projects/cala-data/sims-fpn}
arm=$1
shift
for seed in "$@"; do
  case $arm in
    fpn-*) s=fpn_s$seed; d=$R/fpn/${arm#fpn-}/$s; daq=$F/$s/daq ;;
    *) s=v3_motion_s$seed; d=$R/$arm/$s; daq=$S/$s/daq ;;
  esac
  [ -f "$d/true_patch.npy" ] && continue
  mkdir -p "$d"
  env=(MOTION_FRONT=ff MOTION_RIGID_ONLY=1 MOTION_SAVE=$d)
  main=$R/bin/motion_eval_main
  fix=$R/bin/motion_eval_fix
  bin=$main
  case $arm in
    ff | fpn-ff) env+=(MOTION_FF_OUT=$d) ;;
    fix | fpn-fix) env+=(MOTION_FF_OUT=$d); bin=$fix ;;
    fixed) env+=(MOTION_FF_FIXED=$R/ff/$s) ;;
    fixfixed) env+=(MOTION_FF_FIXED=$R/fix/$s); bin=$fix ;;
    plainfed) env+=(MOTION_FF_OUT=$d MOTION_FF_SHIFTS=$R/front/$s/cala_rigid.npy) ;;
    fixplainfed) env+=(MOTION_FF_OUT=$d MOTION_FF_SHIFTS=$R/front/$s/cala_rigid.npy); bin=$fix ;;
    mainfed105) env+=(MOTION_FF_OUT=$d MOTION_FF_SHIFTS=$R/scaled105/$s.npy) ;;
    fixfed105) env+=(MOTION_FF_OUT=$d MOTION_FF_SHIFTS=$R/scaled105/$s.npy); bin=$fix ;;
    fixrefed) env+=(MOTION_FF_OUT=$d MOTION_FF_SHIFTS=$R/fixfed105/$s/cala_rigid.npy); bin=$fix ;;
    fpn-front) env=(MOTION_FRONT=1 MOTION_RIGID_ONLY=1 MOTION_SAVE=$d) ;;
    fpn-fftruth) env+=(MOTION_FF_OUT=$d MOTION_FF_SHIFTS=$R/fpn/truthshifts/$s.npy) ;;
    fpn-fixtruth) env+=(MOTION_FF_OUT=$d MOTION_FF_SHIFTS=$R/fpn/truthshifts/$s.npy); bin=$fix ;;
    *) echo "unknown arm $arm" >&2; exit 2 ;;
  esac
  env "${env[@]}" /usr/bin/time -l "$bin" minisim "$daq" "$R/gt/$s" > "$d/log.txt" 2> "$d/time.txt"
done
