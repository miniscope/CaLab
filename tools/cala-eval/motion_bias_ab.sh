#!/bin/bash
# A/B of the cross-correlation window envelope on the v3 motion sims (motion_eval minisim).
#
#   tools/cala-eval/motion_bias_ab.sh <motion_eval binary built with the XCORR_NO_ENV probe> <out dir>
#
# Arms: `env` (the shipped estimator), `noenv` (envelope division disabled), and both with
# the patch smoothing and shrinkage off (`MOTION_ALPHA=1 MOTION_NOSHRINK=1`, raw patch
# residuals). One job at a time (~110 s and ~0.5 GB each). Score with motion_bias.py.
set -euo pipefail
bin=$1
out=$2
gt=$out/gt
sims=${CALA_SIMS_V3:-$HOME/Projects/cala-data/sims-v3}
for seed in 5 6 7 8 9; do
  sim=v3_motion_s$seed
  for arm in env noenv env_raw noenv_raw; do
    d=$out/$arm/$sim
    [ -f "$d/cala_rigid.npy" ] && continue
    mkdir -p "$d"
    vars=(MOTION_SAVE="$d")
    case $arm in noenv*) vars+=(XCORR_NO_ENV=1) ;; esac
    case $arm in *_raw) vars+=(MOTION_ALPHA=1 MOTION_NOSHRINK=1) ;; esac
    env "${vars[@]}" "$bin" minisim "$sims/$sim/daq" "$gt/$sim" > "$d/log.txt" 2>&1
  done
done
echo done
