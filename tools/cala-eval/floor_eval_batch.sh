#!/bin/bash
# PR H: the whole Chrome batch, then the scoring, unattended. Phase A (Max) -> targets (R1) committed and pushed ->
# phase B (plan order) -> fixed-library scoring, 2 at a time. Progress: $OUT/batch.txt; per run: $OUT/load.txt.
set -u
OUT=${OUT:-$HOME/Projects/cala-data/runs/floor-eval}
WT=${WT:-$HOME/Projects/CaLab-wt-floor-eval}
T=$WT/tools/cala-eval
log() { echo "$(date +%T) $*" >> $OUT/batch.txt; }
log "phase A"
$T/floor_eval.sh ws-max-1 sa-max-1 sb-max-1 ws-max-2 sa-max-2 sb-max-2 ws-max-3 sa-max-3 sb-max-3 \
  m5-max-1 t6-max-1 m5-max-2 t6-max-2
python3 $T/floor_eval_summary.py targets $OUT > $OUT/targets.out 2>&1
cp $OUT/targets.txt $T/results/2026-11-22-floor-eval-targets.txt
git -C $WT add tools/cala-eval/results/2026-11-22-floor-eval-targets.txt
git -C $WT commit -q -m "eval(cala): PR H arm speeds from the Max runs (rule R1; before any paced run)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011LM6qJmoaWM8iBwEeTaHN5" && git -C $WT push -q
log "targets committed $(git -C $WT rev-parse --short HEAD): $(tr '\n' ';' < $OUT/targets.txt)"
log "phase B block 1"
$T/floor_eval.sh ws-f10-1 sa-f10-1 sa-f07-1 sa-see-1 sa-f14-1 sb-f10-1 sb-f07-1 sb-see-1 sb-f14-1
log "block 2"
$T/floor_eval.sh ws-f10-2 sa-f14-2 sa-see-2 sa-f07-2 sa-f10-2 sb-f14-2 sb-see-2 sb-f07-2 sb-f10-2
log "block S"
$T/floor_eval.sh m5-f10-1 t6-f10-1 m5-f10-2 t6-f10-2
log "block 3"
$T/floor_eval.sh ws-f07-1 ws-see-1 ws-f14-1 ws-f14-2 ws-see-2 ws-f07-2
log "chrome done; scoring"
for f in $OUT/*-final.json; do t=$(basename $f -final.json); python3 $T/floor_eval_summary.py fp $OUT $t > /dev/null; done
for r in sa sb ws; do python3 $T/floor_eval_summary.py fp $OUT $r-max-1 0 1 > /dev/null; done
ls $OUT/score | xargs -P 2 -I{} sh -c 't={}; '"OUT=$OUT"' '"$T"'/floor_eval_score.sh ${t%_shift01} $t'
log "V2 split"
for r in sa sb ws; do mkdir -p $OUT/score/$r-max-1_seed2; cp $OUT/score/$r-max-1/footprints.bin $OUT/score/$r-max-1_seed2/; done
printf '%s\n' sa sb ws | xargs -P 2 -I{} sh -c "SEED=2 OUT=$OUT $T/floor_eval_score.sh {}-max-1 {}-max-1_seed2"
log "ALL DONE"
