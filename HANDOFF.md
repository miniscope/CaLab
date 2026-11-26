# HANDOFF: Auto Discover visit rate (branch `feat/cala-visit-rate-auto`)

Delete this file before the PR is opened/merged. Written 25 Nov 2026 ~20:15 at the context limit.

## State of the code (committed, pushed; no PR yet)

- Engine (one source of truth): `crates/cala/src/discover/visitrate.rs` — `VisitSchedule` (`auto()` default,
  `fixed()`), fed per completed ordinary visit with that visit's **new** adds (churn class `New`) from
  `SlowLoop::step` (mod.rs) and `apply_job` (shard.rs, non-settle); a `VisitRunner` never feeds it.
  Rule: target = 0.15 × min(1, yield/0.2) rounded up to a rung of 0.15·2^(-k/2), k=0..4 (floor 0.0375);
  down when the slow EW yield (half-life 64 visits) asks for the rung below, up when max(slow, fast EW
  half-life 24) asks for at least the rung above; warm-up 2 visits/tile; windows start full (prior at
  full_yield). Cap = target × cap_ratio (app 4/3, qc_eval 1); hold floor = 2/3 target.
  Stats/JS: `visitRateStats()` now 16 numbers, `visitSchedule()`, `setVisitSchedule(auto)`.
- Tests: 5 pure schedule tests in visitrate.rs; `visit_schedule_same_in_place_and_as_jobs` in tests.rs
  (step == step_via, fixed schedule == bare cap bitwise). All `cargo test --lib visit` pass, clippy clean.
- qc_eval: `--visit-rate auto|fixed|R`, `--visit-cap-ratio X` (default 1); global.tsv gains
  `visit_target visit_cap visit_yield_slow visit_yield_fast visit_fed_new`; end-of-run `visit schedule:` line.
- App: `lib/visit-rate.ts` governor reads target/holdFloor/cap/earned from the status (fallback constants),
  window stays open until ≥8 visits expected (`minWindowVisits`), capBound uses earned credit,
  visitMaxFps stored as visits/s ÷ current target; summary adds schedule, schedule_params, target_now/min,
  target_frames, target_changes (≤200), yields. `?debug&visitrate=off|fixed` (default auto) in App.tsx;
  `SlowInit.visitSchedule` plumbed through frame-types/frame-worker/trace-worker/fast-loop/slow-runner.
  Speed block: always-on `speed-visit-rate` line + hold line with the target in force; live line follows cap.
  Run log entry `visit_target` on each target change. No analytics fields.
- Docs: stages.md, run-record.md, USER_GUIDE.md, CHANGELOG (Unreleased) updated. USER_GUIDE says "much
  faster" on long recordings — **verify against measurements or soften**.
- vitest: 1229 pass; 38 failures all in App/donation tests (stale `@calab/community`/`@calab/io` package
  builds in this worktree: `isDonationAuthReturn is not a function` etc.), unrelated. Needs WASM pkg built
  (`PATH=$HOME/.cargo/bin:$PATH wasm-pack build --target web --release` in crates/cala; done once).

## Measurements running (background, write only under ~/Projects/cala-data)

Raw: `~/Projects/cala-data/runs/visit-rate-auto/` (scripts in `scripts/`: run.sh, chain2.sh, summary.py,
summary_real.py, yield_curve.py, chrome_arm.sh). Binaries: main `bin/qc_eval-main-c380b6b3`, new
`bin/qc_eval-visit-auto-v1`.

1. `main/` — 8 sim runs DONE (v3_motion_s5/s6, v3_static_s6/s7 × seeds 1,2, `--visit-rate 0.15`);
   demix was rerun by hand (first runs lacked demix_clusters.py; dumps deleted, so tr_r is NaN —
   ignore tr_r). `real/main` (Samara 10_43_21 seeds 1,2) RUNNING.
2. `chain2.sh` (pid 32700) waits for the main queue, then: PAR=1 queue `fixed v3_motion_s5 s1`
   (reproduction check: must equal main's visits/cells exactly), then `auto` on all 8 sims + `real auto 1,2`;
   beside it generates two 30k-frame sims in `~/Projects/cala-data/sims-long/` (make_trace_sim.py,
   committed `ca1_workshop_v3.spec.json`, `--dur 1500 --seed 5`, second with `--p-q2a 0.0001` = sparse late
   onsets), then long runs auto vs main on both (`queue-long.out`). Expect several hours total.
3. Summaries: `source ~/Projects/cala-data/sims.env; $MINISIM_PY scripts/summary.py` (sims, paired
   Auto − main / − fixed) and `$MINISIM_PY scripts/summary_real.py`. Curves: `python3 scripts/yield_curve.py RUN_DIR`
   and the `visit_target` column of each run's global.tsv.

## Left to do

- DONE: fixed == main on motion_s5 s1, exactly: 1432 visits over 9550 frames, 743 cells, adds 748 merges 39
  splits 34, settle 5064 visits / 7999 refines / 89 publishes, work 2.515e11 (only wall time differs, 469 vs
  499 s, from load). So "main" is a valid fixed arm.
- Read Auto results; if real-data cells/QC-pass drop noticeably, consider full_yield 0.1 (rerun auto arms).
  The calibration table (new cells per visit at 0.15) is in the visitrate.rs doc comment.
- Long sims: show visits/frame falling and recall holding (sparse sim = discovery continues late).
- Chrome (headed, real GPU, port 5277, cdp 9377; ONLY when no qc_eval/cargo is running):
  `scripts/chrome_arm.sh auto-ws1 ~/Projects/workshop-processing-and-analysis/data/sessions/prerecorded/raw`
  and `scripts/chrome_arm.sh fixed-ws1 <same> --query '&visitrate=fixed'` (workshop = 23,711 frames, READ-ONLY;
  prior fixed run: Discover ~111 s, 213 fps, 775 cells, peak RSS ~4.2 GB). Also the 30k long sim's
  `daq/Miniscope` folder for a long-recording speed number. Summarise like
  `~/Projects/cala-data/runs/visit-rate-015/summ.py`. "Main" in Chrome = this branch with `visitrate=fixed`
  (say so in the results).
- Write `tools/cala-eval/results/2026-11-26-visit-rate-auto.md`, commit, delete HANDOFF.md, open ONE PR
  (ready for review, do not merge), body ending with the Claude Code attribution lines.
