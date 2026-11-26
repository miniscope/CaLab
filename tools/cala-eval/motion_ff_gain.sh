#!/bin/bash
# Registration gain with qc_eval's / the app's input path, with and without the online flat field.
#
#   tools/cala-eval/motion_ff_gain.sh <motion_eval binary> <out dir>
#
# Arms on v3_motion_s5..s9 (motion_eval minisim, MOTION_SAVE per run):
#   front  MOTION_FRONT=1   preprocessor front half + FOV mask, flat field off
#   ff     MOTION_FRONT=ff  the same plus the online sensor flat field (qc_eval's default)
# `<out dir>/gt/<sim>` holds the exported ground truth (shifts.npy, nonrigid_*.npy).
# One job at a time (~2-4 min, < 1 GB each). Score with motion_bias.py.
set -euo pipefail
bin=$1
out=$2
sims=${CALA_SIMS_V3:-$HOME/Projects/cala-data/sims-v3}
for seed in 5 6 7 8 9; do
  sim=v3_motion_s$seed
  for arm in front ff; do
    d=$out/$arm/$sim
    [ -f "$d/true_patch.npy" ] && continue
    mkdir -p "$d"
    mode=1
    [ "$arm" = ff ] && mode=ff
    MOTION_FRONT=$mode MOTION_SAVE="$d" "$bin" minisim "$sims/$sim/daq" "$out/gt/$sim" > "$d/log.txt" 2>&1
  done
done
echo done
