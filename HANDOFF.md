# Stage 3 handoff (19 Nov 2026)

State: branch `feat/cala-replay-stage3`, rebased on main (after #424). Code behind flags, results in
`tools/cala-eval/results/2026-11-19-replay-stage3.md`. No PR opened (does not clearly beat Stage 2).

Binaries: `$CALA_DATA/bin/qc_eval-st3-b` (all flags). Runs: `demix-suite/st3-smoke-refine`, `st3-smoke-eq`,
`st3-quick-discover`.

Not done:
1. Full-tier Refine run (14 sims) of `--joint-update refine --joint-sign all --joint-leftover 1 --joint-rebase`
   (± `--joint-no-provisional`), compared with `demix_report.py --base full-stage2/stage2` and `full-signall/off`.
   Recompute metrics on CoW copies of those trees (`cp -c -R`) to get the new 2+ GT split rows.
2. Full-tier Discover-only (needs fresh main `--passes 1` runs; only quick-tier baselines exist).
3. demix_stages.py Refine recovery and solo cost runs (suite timing hints observe +40 % over Stage 2 with m = 1).
4. Root cause of the Discover matched-cell loss: compare adds / removals / merges per arm (`adds.tsv`,
   `removals.tsv`) between main-pass1 and stage2-pass1 on static s5; the restarts hypothesis is ruled out.
