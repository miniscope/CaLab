# HANDOFF: look-back settle study (exp/cala-lookback-settle)

State at the time of writing (19 Nov 2026): screen done and written up; deciding runs in progress.
Deliverable: `~/Projects/cala-data/demix-bench/settle_design.md` (cells marked `PENDING-*` wait for the runs below).
Results file: `tools/cala-eval/results/2026-11-19-lookback-settle.md` (M4, M6, M7 and the addenda still to append).

## Running / queued (all under the shared 6-slot light cap; drivers wait for slots)

- `demix-suite/lbsettle-q6.log`: full-tier `SETTLE` (root `lbsettle-full`), then quick-tier `SETTLE-stop`, then
  `ST-quarter` on static s5-s7 (root `lbsettle-q`). Driver: `demix-suite/lbsettle-q.sh`.
- `runs/lbsettle/real/`: `SETTLE_s1..3` (COMBO + 18,000-frame settle, batch 16, then a Refine: wrap1 = settled
  library, final = after Refine), `HALF_s1..2` (9000 frames, every 2nd block), `ATTR_replay_s1`, `ATTR_lb_s1`,
  `ATTR_guard_s1` (which setting loses the cells). References: `DRR_s3`, `COMBOR_s3` here, seeds 1-2 in
  `runs/lbreview/real`. Launcher: `runs/lbsettle/real_run.sh NAME SEED flags`.

## Analysis commands

    source ~/Projects/cala-data/sims.env
    # M6 / M4 (clone the 5 quick ST-full runs into lbsettle-full first for like-for-like batch comparison)
    $MINISIM_PY tools/cala-eval/settle_ladder.py --root $CALA_DATA/demix-suite/lbsettle-full --ref COMBO+R --arms COMBO,SETTLE,DR-main
    $MINISIM_PY tools/cala-eval/settle_ladder.py --root $CALA_DATA/demix-suite/lbsettle-q --ref ST-full --arms SETTLE-stop,ST-quarter,ST-half
    # M7: seed pairs and Minian (tags wrap1 = settled, final = after Refine)
    $MINISIM_PY tools/cala-eval/lookback_settled.py real --run S1=.../SETTLE_s1 --run S2=... --run S3=... \
        --minian ~/Projects/workshop-processing-and-analysis/data/sessions/prerecorded/minian_out \
        --pair S1:wrap1,S2:wrap1 ... --pair S1:wrap1,Minian ...

## Before the PR is ready

`cargo fmt --check`, clippy and `cargo test` pass (from `crates/cala`); run `npx prettier --write` on the results
file; replace `PENDING-*` in `settle_design.md`; delete this file.
