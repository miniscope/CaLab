# HANDOFF: PR H, floor and default eval (cala beta)

Branch `eval/cala-floor-default`, worktree `~/Projects/CaLab-wt-floor-eval`. This is an eval PR and is not merged.
The parent schedules the runs. **Do not start Chrome until the parent says "go".**

## State (22 Nov 2026)

- Plan and pass lines: `tools/cala-eval/results/2026-11-22-floor-eval-plan.md`.
  - Commit `43b87579`, amended with the sims in `d07905aa`. Both are pushed and both came before any run.
- Builds:
  - WASM is built in this worktree.
  - qc_eval is at `~/Projects/cala-data/bin/qc_eval-floor-eval-8a39a648`, built from main `8a39a648`.
- Nothing has run yet. The parent answered:
  - full batch;
  - scoring right after Chrome, 2 at a time;
  - sims added (`m5` = sims-v3 `v3_motion_s5`, `t6` = `v3_static_s6`; Max x2 and floor x2 each).

## Scripts (`tools/cala-eval/`)

- `floor_eval_batch.sh` runs everything unattended. Start it in the background after "go":

  ```
  nohup tools/cala-eval/floor_eval_batch.sh > ~/Projects/cala-data/runs/floor-eval/batch.out 2>&1 &
  ```

  It runs these steps in order:
  1. Phase A: the Max runs.
  2. `floor_eval_summary.py targets`, i.e. rule R1. It copies the result to `results/2026-11-22-floor-eval-targets.txt`, then commits and pushes it.
  3. Phase B: blocks 1, 2, S and 3.
  4. Conversion of the libraries to `footprints.bin`.
  5. The fixed-library scoring, 2 at a time. This includes the V1 shift (`<rec>-max-1_shift01`) and the V2 split (`<rec>-max-1_seed2`).

  Progress goes to `batch.txt`; load per run goes to `load.txt`.
- `floor_eval.sh TAG...` runs Chrome. It is headed, on port 5198, with the pgrep guard, and logs the load per run.
- `floor_eval_score.sh TAG [SCOREDIR]` runs `qc_eval real` on recordings and `qc_eval sim` on sims, with `--library` and `--dump`.
- `floor_eval_summary.py` has these subcommands:
  - `targets DIR`
  - `fp DIR TAG [dy dx]`
  - `runs DIR`: the per-run table (time, dose, need per birth, drop share, cap share, visit busy, floor estimates). Tested on old data.
  - `quality DIR`: Q1-Q5 and T1-T5. Written to `DIR/quality.json`. Not yet tested on real scores.
  - Still to write: the plan's readings (H1-H3, margins, Spearman trend, D1-D3) and `summary.md`.

## Outputs

- `~/Projects/cala-data/runs/floor-eval/`:
  - per-run `<tag>.log`, `-probe.json`, `-work.json`, `-final.json`, `-live.json`;
  - `load.txt`, `batch.txt`, `targets.txt`;
  - `score/<tag>/`, which holds the qc_eval outputs: `global.tsv`, `final.tsv`, `ho_cells.tsv`, `dump_trace.f32`.
- Results go in `tools/cala-eval/results/2026-11-22-floor-eval.md`. Put the plain-language PI summary first.

## Remaining

1. Wait for "go", then launch the batch: about 5 h of Chrome, then about 2.5 h of scoring.
2. Check that every run has `cap 2`, `settleWorkers 1` and a full settle (`settle_fed` equal to the total). Check whether the sims opened in the app; if not, drop the sims and say so.
3. Check V1 (the shifted library scores lower) and V2 (the seed difference) before reading Q1-Q4.
4. Write up H1-H3, quality, time, and the D1-D3 recommendation. Open the PR with the body ending in the Claude Code line.
5. Rules:
   - Never use "matches Max" as a criterion.
   - Read only the summaries, not the logs.
   - Kill only your own processes, by PID.
