# HANDOFF: cluster replay Stage 2 (branch feat/cala-replay-stage2, stacked on feat/cala-cluster-replay)

## State (18 Nov 2026, second agent)
- Go/no-go file updated BEFORE runs with PI rows #11-#14 (commit 355e982).
- Code (commit caec968): `ClusterStore::move_to` re-expresses a store when a member's statistics disk moves
  (no restart; new pixels start at the current model; linear, behind `ClusterHistory::reexpress`); store pixels
  = the members' statistics disks (second margin dropped). Knobs: `JointAdmit` (Cluster default = Stage 1,
  Member = per-member excess from joint SEs), `joint_carry` (default off). qc_eval `--joint-admit`, `--joint-carry`.
  Toy tests: `a_member_at_the_truth_is_not_proposed`, `a_moved_store_keeps_its_history_and_starts_new_pixels_at_the_model`.
- clippy (jsbindings, pybindings, jsbindings+diagnostics) clean; cala tests pass; tools/cala-eval unittest 59 OK.
- Binaries in ~/Projects/cala-data/bin: qc_eval-st2-base (Stage 1 code at 7786c44, release), qc_eval-st2-c (Stage 2 HEAD).

## Probe result (probe2_s1, static s5, 1 alternation)
- Store age does not drive rejection (0.74 at 200-500 frames vs 0.67 > 2000). Restarts are a Discover issue, not Refine.
- Rejected cluster proposals: 66 % have EVERY proposed member losing alone (solo held-out gain <= 0); joint gain ~ sum of
  solo gains (median joint - sum solo 0.00, p90 +11.9): no rotation effect in the gate. Accepted: 998/1725 "mixed".
- Solo gain by class: bitten i median -6.5 (28 % > 0), its neighbour j -2.0, members of all-healthy clusters -0.6 (38 % > 0).
- Healthy clusters: new_col == cur_col at c_j yet most pass the excess test: the replay's split halves share one basis
  (estimated from all frames), so ha - hb misses the basis noise and the excess test is overconfident (toy confirms).
- Sign rule is not the main driver: Off / Own arms reject ~60 % too (All 69 %).

## Arms on static s5 + pairs s5 (runs/replay2/st2a, st2b; vs Stage 1 = demix-suite/full-signall/signall)
| arm | bite 0.75-1 | corr excess | fp r close | over-fill <1 D (replay_extra) |
| Stage 1 | 0.335 | +0.102 | 0.9901 | 0.066 |
| Member admission | 0.456 | +0.122 | 0.9877 | 0.057 |
| Member + carry | 0.424 | +0.103 | 0.9885 | - |
| Cluster + move (= Stage 2 default) | 0.233 | +0.078 | 0.9927 | 0.075 |
| Cluster + move + carry | 0.168 | +0.055 | 0.9937 | 0.112 (rejected: over-fill) |
Honest admission stops the small accepted steps by which bites heal -> worse; kept as knob only.

## Running / next
1. Full tier stage2 arm: ~/Projects/cala-data/demix-suite/full-stage2/stage2 (runner: ~/Projects/cala-data/runs/replay2/arms.py, log
   demix-suite/full-stage2.log). Report: demix_report.py --base full-signall/{off,signall} --new full-stage2/stage2;
   over-fill via `$MINISIM_PY -I demix-bench/replay_extra.py <arm dirs>`.
2. Flag-off identity: qc_eval-st2-c with no flags on static_s5 + motion_s5, cmp footprints.bin, footprints_pass1.bin,
   final.tsv against demix-suite/full-signall/off/<sim>.
3. Solo cost runs (nothing else running): st2-c flag-off (main), st2-base --joint-update refine --joint-sign all
   (Stage 1), st2-c --joint-update refine --joint-sign all (Stage 2), static_s5 + motion_s5 (--motion); slow_cost.tsv.
4. Discover-only: quick tier `--passes 1 --joint-update all --joint-sign all` vs demix-suite/quick-pass1-discover/
   {main-pass1, discover-pass1} (recompute their metrics for demix_cells.tsv).
5. Refine recovery: demix_stages.py run (3 arms main/stage1/stage2, static_s5,pairs_s5) + report.
6. Results into tools/cala-eval/results/2026-11-18-replay-stage2.md and a "Stage 2 results" section in
   ~/Projects/cala-data/demix-bench/design_joint_update.md; PR (base feat/cala-cluster-replay) if it beats Stage 1.
Note: two arms.py runners started together can race past 4 light runs; start one at a time.
