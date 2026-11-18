# HANDOFF: cluster replay Stage 2 (branch feat/cala-replay-stage2, stacked on feat/cala-cluster-replay)

## State
- Measurement added (committed): qc_eval writes `slow_cost.tsv` (per pass: observe/step wall ms/frame, work units/frame);
  demix_metrics `slow_cost()` + per-cell accuracy `demix_cells.tsv` (footprint r, trace r with GT, nearest-GT distance);
  demix_report rows: slow-loop ms/frame, work/frame, store MB, RSS, footprint/trace r for all / isolated (>=1.5 D) / close (<1 D)
  matched cells (PI request). Test added in test_demix.py. Go/no-go pre-registered in tools/cala-eval/results/2026-11-18-replay-stage2.md.
- Diagnostics probe (diagnostics builds, `CALA_REPLAY_STAGES=path`): cluster.rs `dump_stages`, `StageDiag`, finish_basin samples,
  solo-member gate counterfactual. Analyzer: tools/cala-eval/replay_stages.py BASE_RUN RUN STAGES_TSV.
- NO behaviour change yet; flag-off identical by construction (only cfg(diagnostics) code + qc_eval timing). Not yet re-verified by cmp.
- clippy/fmt/tests not yet run on this branch.

## Localization result (static s5, 168 bitten / 112 healthy GT pairs at 0.5-1 D from main)
Runs: ~/Projects/cala-data/runs/replay2/{probe_s1, probe_it10} + stages_*.tsv.
- The finish path (smoothing, significance, single-peak basin, inversion, from_canvas) does NOT lose the fix: < 2-5 % of bitten
  pairs lose light there; median value at c_j grows through it (raw 0.04 -> inverted 0.12; it10 raw 0.12 -> 0.20).
  So the Stage 1 lead ("support step is the lock") is wrong; Stage 2 support rule (§2.4) alone would not help.
- 1 alternation/visit (default): the replay's raw estimate itself stays low on bitten pairs (median 0.038 vs healthy 0.135;
  flat over the Refine pass, 0.013 -> 0.033) -> first loss "raw <= 0.05" 51 %, gate rejected 25 %, kept 22 %.
- 10 alternations: raw heals (0.116 vs healthy 0.179) and survives finish, but the GATE rejects: first loss gate 52 %.
- Replay exits (share of replays): none 13-16 % (young store after restarts / singular), lowsnr 12-15 %, conv 13-16 %,
  rejected 40-48 %, accepted 10-18 %. Rejections are large and real (median gain -79 s1 / -132 it10, z ~ -2), not noise.
- Running now/next: probe2_s1 (qc_eval-st2-probe2) adds store age and solo-member gate gains per member, to find which
  member's new column makes the cluster proposal worse on held-out frames (hypotheses: young stores after restarts;
  filtered-space sign clip of the moat; owner ring level; over-filled healthy members).

## Next steps
1. Analyse probe2 (cols 30-32: frames, solo gain i, solo gain j) -> which member/age drives rejection.
2. Fix candidates: avoid store restarts (re-express instead), warm-start the store's own estimate across visits,
   sign constraint in unfiltered space; then cost (drop second pixel margin in new_store, f32 basis).
3. Quick tier, then full tier vs reused baselines demix-suite/full-signall/{off,signall}; demix_stages Discover vs +1/2/3 Refine.
Note: wall timings in suite runs are very noisy (main pass-2 observe 4.40 vs Stage 1 3.83 ms/frame); gate cost on solo runs.
Note: pgrep -f patterns in wait loops match their own shell; use "[q]c_eval".
