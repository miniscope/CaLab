# HANDOFF: concurrent Refine round 2 (precision demand)

State (18 Nov 2026, ~21:45):
- Commit ecbb5be2 + fmt: `--lookback-target E` precision demand in qc_eval `LookBack` (LbCell, eval_noise,
  next_block_target), held-out look-back frames preprocessed but not solved and not charged, `fp_noise.tsv`
  (`--noise-dump`), lookback.tsv extra rows (target, skipped, above_target, prio_left, per-twentieth frames, drain row).
  Binary: ~/Projects/cala-data/bin/qc_eval-lb8. fmt and clippy clean.
- Round-2 targets are in tools/cala-eval/results/2026-11-19-concurrent-refine.md (committed before runs).
- Running when handed off: quick tier `cr-quick` arms LBP-x2 (E 0.05, hl 6000) and LBP-x2-hl24k, log
  demix-suite/cr-quick5.log. Then: demix_suite --report-only per arm vs DR-main (as the earlier reports).
- Smoke (static_s5, cr-calib): LBP-x2 E 0.05 isolated 0.9898 vs DR 0.9927; pass-loop 356 s vs DR 349 s (not cheaper);
  cursor saturated all recording; 363/507 cells above E at end, pools exhausted (never-twice + forgetting).
- Round-1 LBD-x2 (K window + drain) quick: all +0.0014, isolated -0.0025 [-0.0047,-0.0001], close-pair +0.0044,
  r<0.9 within noise, crosstalk/bites better, wall 1449 vs 1721 s. hl24k identical (isolated -0.0027).
  => LBD-x2 meets the PI's relaxed near-match bar (all groups within 0.003).
- Not done: flag-off byte-identity vs main-7155c62 (cr-smoke/DR-main), motion_s5 smoke, full tier, PR.
