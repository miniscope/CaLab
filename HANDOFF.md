# HANDOFF: settle delta (`feat/cala-settle-delta`)

Worktree `~/Projects/CaLab-wt-csdelta`, branch `feat/cala-settle-delta` (off main 3cb66a82). Not merged; PR open.

## Done

- Engine (`crates/cala/src/discover/settle_delta.rs`, plus `fpstats.rs` `FpDelta` / `FpStats::add_delta`, and
  `cluster.rs` `ClusterSnap` / `ClusterDelta` / `ClusterStore::add_delta` / `epoch`):
  - `SlowLoop::settle_context()`: each cell's statistics disk (id, centre, radius), each cluster store's ids, epoch,
    pix, owner, is and ut, the forgetting factor and the parity block. It is refused when `core_test` collects.
  - `SettleDeltaBuilder`: sums the fitting frames of one chunk (one library) at weights relative to the weight
    before the chunk, `gamma^-(j+1)`.
  - `SlowLoop::apply_settle_delta(d, held)`:
    - refuses the whole delta if any frame key is held out;
    - matches cells by id and disk, and stores by member ids and epoch; anything gone or changed is dropped and
      counted;
    - advances the forgetting clock frame by frame, with renormalisation;
    - counts everything in `SettleDeltaStats`.
  - The hidden knob `set_settle_delta_charge_equiv` charges the apply what `observe_settle` would have cost.
- Tests (`discover/tests.rs`, `settle_delta_*` and `js_settle_delta_*`): all pass, and the rest of the lib passes too
  (266 tests). They check:
  - equality with `observe_settle` at 1e-5, cells and clusters, with and without NaN pixels, the halves included;
  - the forgetting clock and renormalisation, at half-life 3;
  - drops for a cell gone, a disk moved and a store epoch changed;
  - refusal of a delta with a held-out frame;
  - the JS surface.
- qc_eval:
  - `--csdelta`: visit workers plus `--csettle` are required, and `--csettle-yield` is refused.
  - `--csdelta-charge-equiv`.
  - `csdelta.txt`: the stats, plus MB and wall ms per chunk (that part from binary `qc_eval-csdelta-b`).
- WASM, on `SlowLoop`: `settleContext`, `applySettleDelta` and `settleDeltaStats`. Plus a `SettleDeltaBuilder` class:
  `new(w, h, fov)`, `begin(ctx)`, `push(frame, lib, traces, bg, stream)`, `finish()`.
- App, behind `?debug&csdelta` (`SlowInit.csettleDelta`):
  - Each settle request carries the context, plus the FOV once per worker.
  - The look-back worker (`LookbackReader.settleDelta`) answers `{type:'delta'}` and keeps the frames.
  - `SlowRunner.csettleDeltaAnswer` applies the delta.
  - The status reports `csettle.delta`.
  - `memory-measure.mjs --csdelta`.
  - vitest passes (745 tests); tsc, eslint and prettier are clean.
- T0, flag off = main: `~/Projects/cala-data/runs/csdelta/t0/report.txt` shows vw and cs2f identical apart from
  wall-time fields.
  - Caveat: the binary was built at 9272d64e. Later commits touched only the flag-on path in qc_eval and the
    builder's background check. Re-run `tools/cala-eval/csdelta.sh t0` with a fresh binary before merge if you want
    it airtight; delete `t0/new_*` first, and copy the new build to `$ROOT/bin/qc_eval-csdelta`.

## Exact or approximate (the answer for the PR)

**Same library version, nothing changed between request and answer: the same sums up to f32/f64 rounding.** The test
tolerance is 1e-5 relative. The one exception is the split-half sums: a cell's whole chunk goes to the 256-frame block
of its first frame. A chunk straddles a block boundary with probability about 15/256 per cell, and then only its later
frames land in the other block.

**Library changed (adds, merges, removals):** cells are matched by id and disk, and stores by members and basis
epoch. What changed gets nothing from the chunk, and it is counted in `cells_gone`, `cells_moved`, `cells_absent`,
`clusters_gone`, `clusters_stale`, `clusters_absent` and `stale_version`.

Today's `observe_settle` with an old library instead does three things:
- it pushes onto that library's cells, creating statistics for deleted cells;
- it moves disks to the old supports;
- it rebuilds the cluster sets for the old cell set.

The delta path does none of this. So the two paths differ only in that case. The magnitude has to come from the
counters in Chrome runs (qc_eval always solves with the current library, so `stale_version` is 0 there).

## Paused qc_eval driver

- Script: `tools/cala-eval/csdelta.sh` (`t0`, and `eq REC SEED`, which runs 3 arms: off, eqv, on).
- Outputs: `~/Projects/cala-data/runs/csdelta/eq/<rec>_s<seed>_<arm>{,.log,.time,.done}`.
- Done or running: `sim` seed 1 (all 3 arms), and `bytes/ws_on`, a workshop run of 6000 frames with `--csdelta`
  that measures context and delta MB and wall ms per chunk, in `bytes/ws_on/csdelta.txt`.
- Remaining: `sim` seeds 2 and 3, then `10_43_21` seeds 1, 2 and 3.
- Resume ONLY after the coordinator says the gate is done:
  `nohup /private/tmp/claude-503/-Users-daharoni-Projects-CaLab/afa6e515-3c3e-4cc7-af38-91dc1bbfaf4b/scratchpad/drive2.sh > ~/Projects/cala-data/runs/csdelta/drive2.log 2>&1 &`
  - It loops over `csdelta.sh eq sim 1..3`, then `eq 10_43_21 1..3`, and skips runs that have a `.done` file.
  - If scratch has been wiped, recreate that loop.
- Each group is 3 processes of about 0.9–1.3 GB, roughly 30–45 min per sim group, and longer for Samara. RAM must stay
  at or below 6 GB, so run one group at a time.

## Reading the equivalence results

Command: `python3 tools/cala-eval/csdelta_eq.py ~/Projects/cala-data/runs/csdelta/eq sim 1,2,3` (and the same with
`10_43_21`).

It prints, per arm: cells, GT precision, recall and TP median r (sims only), dropped frames, the owner's share on
settle answers, and visits. It then prints Jaccard and median cosine for:
- off vs eqv and off vs on, same seed;
- the noise pairs: the same arm across seeds.

**Pass criteria:**
- **eqv** (same schedule, only the numbers differ): off-vs-eqv Jaccard and median cosine within the range of the off
  seed-to-seed pairs, or closer.
  - Cells, precision and recall within the seed spread.
- **on** (true charge): same criteria. Any difference also includes the schedule change, so less slow-worker time on
  answers means more live frames observed.
  - Report the owner's "% on settle answers" for off vs on as the modelled gain.

## Chrome (wait for the coordinator's "go"; machine quiet, my qc_eval done)

- Start the dev server of this worktree on port 5197. `scripts/dev.mjs` or vite: check how other agents run 5197.
- Run `tools/cala-eval/csdelta_chrome.sh TAG ws|10_43_21 60|120 off|on`, 8 runs, one at a time. It runs headed with
  `--governor --lbpool 1`, and outputs to `~/Projects/cala-data/runs/csdelta/chrome`.
- Summarise with `python3 tools/cala-eval/csdelta_summary.py OUT TAG...`. It gives:
  - slow-worker ms per settle frame, as `csettle` duty ms over delivered settle frames, from the #459 work readout;
  - context and delta MB, plus context and build ms, per request;
  - drops.
- Baseline from the earlier governor runs: Samara at 60 fps with pool 1 measured 1.70 ms per settle frame.
- Do not edit files or lint during a Chrome run.

## Open questions

- **Context size on dense recordings:** cluster `ut`, `pix`, `is` and `owner` are about 21 B per cluster pixel. If
  making and sending the context eats the gain, send only stores whose epoch changed since the last request to that
  worker (the builder would cache snapshots by epoch).
- The look-back worker's own build cost: it adds to its busy time and reduces re-read supply. Measure it with
  `deltaMs`.
- Write the results doc `tools/cala-eval/results/2026-11-22-settle-delta.md` once the qc_eval and Chrome numbers are in.
- Live frames could take the same path later (item 2 of #456's list).

## First measurement: workshop recording, 6000 frames, 770 cells (`bytes/ws_on`, native qc_eval, binary `-b`)

Per chunk (about 10.6 fitting frames):

| what | size or time |
| ---- | ------------ |
| context | 6.3 MB, 2.1 ms to make and encode |
| delta | 10.0 MB |
| summing on the builder | 57 ms |
| apply on the slow loop | **1.4 ms** |

- The apply's work units are 26x below what `observe_settle` would have spent on the same frames (1.25e9 against
  3.2e10).
- `stale_version` 11 of 507.
- Risk: 16 MB of messages per chunk. Check the cost of structured clone and transfer in Chrome. The context is
  cloned, apart from its transferred buffer; the delta is transferred. If that cost bites, cache cluster snapshots by
  epoch in the builder.

## sim seed 1 (static_s5, full length, 30 fps offered; timed model)

| arm | final cells | owner share on settle answers | visits | longest batch wait |
| --- | ----------- | ----------------------------- | ------ | ------------------ |
| off | 555 | 14.3 % | 32,908 | 18 ms |
| eqv | 551 | 13.8 % | 32,513 | 16 ms |
| on | 544 | **0.5 %** | 36,716 | 2.5 ms |

- No drops: `cells_gone`, `cells_moved` and `clusters_stale` were all 0.
- Footprint agreement against the seed-to-seed noise still needs the `csdelta_eq.py` run.
