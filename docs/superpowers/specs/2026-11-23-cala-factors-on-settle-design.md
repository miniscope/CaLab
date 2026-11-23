# cala: the Final settle and Extract on the stored factors (design, 23 Nov 2026)

Replaces, for the app, the plan of `docs/superpowers/specs/2026-11-17-cala-factor-pipeline-design.md` (on the
branches of PRs #437, #440, #442), whose app parts were built on the Refine stage that `main` no longer has.

## Goal

The owner's direction (23 Nov): factors in the app before the beta, and the Final settle and Extract working on the
stored history (the factors) instead of re-reading the file. The main use case is a live stream from the wireless
miniscope, which on `main` gets no settle and no Extract at all.

## What `main` does today (f092d622)

Facts with file references; "inferred" marks what was not read directly.

### Stages

- Two stages: Discover and Extract (`apps/cala/src/lib/run-stages.ts:20`). Refine was removed by PR #479.
- Discover of a recording runs with look-back by default and ends with the Final settle (`apps/cala/docs/stages.md`,
  "Order"). Extract starts by itself when Discover's final library is out ("Extract after Discover", on by default:
  `run-stages.ts:66`; the effect that starts it: `components/RunPanel.tsx:259-269`).
- A live stream gets Discover only. Extract is blocked with `LIVE_NOTE` ("there is no file to replay",
  `run-stages.ts:57-58`, applied in `stageAvailability`, `run-stages.ts:89-110`). Look-back is blocked with "Look-back
  needs a recording on disk (not a live stream)." (`App.tsx:191`), so a stream has no Final settle either.

### Look-back during Discover

- The slow worker's scheduler (`crates/cala/src/discover/lookback.rs`) asks for past 64-frame blocks that new cells
  never saw (at most 3,000 frames before a cell's birth, 2 look-back frames per Discover frame:
  `slow-runner.ts:209-219`).
- The look-back worker re-reads those frames from the file and preprocesses them as Extract's replay does: recorded
  flicker, newest flat-field map, recorded rigid shift, a copy of the live back half per block, then a solve with the
  newest library (`lib/lookback-reader.ts:1-58`).
- The frames go to the footprint statistics and cluster stores only (`SlowLoop::observe_lookback`,
  `discover/mod.rs:2319`). The fast loop never waits.
- Background settle (below Max speed): the same worker also re-reads frames spread over the history at a governed rate
  (`observe_settle`, `discover/mod.rs:2177`).

### The Final settle

- Starts at Discover's last frame (`SlowRunner.end`, `slow-runner.ts:1565-1576`), only when the run has look-back
  (`this.lbOn && this.run === 1`).
- Freezes the cell set: edit scope `refine` (`slow-runner.ts:1369`; `EditScope::Refine` skips adds, splits, merges,
  keep tests and deletions, `discover/mod.rs:466-480`).
- Frames: one pass over the recording up to 18,000 frames, a longer one sampled in 64-frame blocks spread evenly
  (`settlePlan`, `lib/settle.ts:51-68`; `SETTLE`, `settle.ts:13-39`). The level cuts the plan short: Thorough 1,
  Standard 0.87, Quick 0.6 (`FINAL_SETTLE_LEVELS`, `settle.ts:765-782`; `truncatePlan`).
- Each 16-frame request goes to look-back worker 0, which re-reads and preprocesses as above. Every answered frame
  goes through the slow loop's ordinary `observe` with its stream index (`observeSettle`, `slow-runner.ts:1513-1556`).
  So the reservoir and the held-out test frames are renewed, the frame keeps the held-out side it had in Discover,
  and the cluster stores are fed.
- Visits refine after every answer (with visit workers: the due tiles are handed out). A checkpoint every 1,200 frames
  publishes the library and counts cells still moving (more than 2x their split-half noise). A last round of visits
  ends it. Stop keeps what was refined.
- The slow loop of a look-back run is built with the cluster history replay on (`jointUpdate: 'all'`, joint sign
  `all`, merge guard 0.6 D: `LOOKBACK`, `slow-runner.ts:209-219`; `buildSlowLoop`, `slow-runner.ts:251-270`).
- Settle-size (`tools/cala-eval/results/2026-11-22-settle-size.md`): the replay is what makes look-back + settle
  footprints larger and closer to the truth on the sims. On 14 sims: light left out 14.8 % → 11.0 %, bitten footprints
  49 % → 17 %, crosstalk halved, fewer false cells, the same true cells.
- Cost: the settle is 5-20 % longer than the old Refine (beta gate). Worker 0 spends about 4.3 ms per frame, of which
  about 3.6 ms is read, front half, warp and back half; the slow worker's `observe` takes 2.0-2.3 ms per 600x600 frame
  (PR #491's description). With #491's readers the slow worker becomes the limit.

### Extract

- A replay of the file from frame 0 through the three workers with the final library, the recorded motion and
  flicker, and Discover's newest flat-field map (`lib/pass2-store.ts`; README "Run stages and export").

### Compression on `main`

- Still experimental and behind `?compress` (`App.tsx:152-154`).
- The fast worker cuts its input frames (preprocessed, motion-corrected: what the fast loop solves) into 600-frame
  windows. The compress worker writes them to OPFS and compresses each window per 64 px tile, side by side, in factor
  format v1 (`README.md:346-376`).
- Two things read the factors today:
  - the back-fill: once the final library is out and every window is compressed, the traces of the whole recording
    are solved again from rebuilt frames, 16 at a time (`App.tsx:392-398`, `CompressRunner.backfill`);
  - the history review (`?compress&review`), which reads plain tiles only.
- Nothing else uses the factors; the settle and Extract re-read the file.
- `main` has none of the format v2 work: no compression change since the branch point of #437 (bbe6e287).

### Open PRs of the maintainer that touch the same code

- #491 (settle readers on idle workers): `lookback-worker.ts`, `lookback-reader.ts`, `settle.ts`, `slow-runner.ts`.
- #470 (settle delta, off by default): `slow-runner.ts`, `lookback-worker.ts`, `discover/mod.rs`, `fpstats.rs`,
  `cluster.rs`, `js.rs`.
- #485: eval only.

## What the three PRs hold, against `main`

`git merge-tree` against `origin/main`:

- #437 conflicts in 4 files: `App.tsx`, `refine-store.test.ts` (deleted on main), `qc_eval.rs`, `lookback.rs`.
- The whole stack (#442) conflicts in 21 files.
- A trial cherry-pick of #437's ten format-v2 commits (`d5c554de` … `6cbb937b`) onto `origin/main` applied cleanly
  except `crates/cala/examples/qc_eval.rs` (4 of the 10 commits conflict there). Not built.

| piece (branch)                                                                                                                            | applies to main                                                                  | verdict                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Factor format v2, offset grids and blending, discarded variance, valid share, non-finite pixels as missing, 2 SVD power iterations (#437) | cleanly in the crate and the app; `qc_eval.rs` conflicts                         | **Reuse first.** Main has only v1 and plain tiles. Phase 1: the offset grids remove the tile-line jump of plain tiles. The history review still reads plain tiles only (`6cbb937b`).                                                                                     |
| App compressor writes v2, tiling chosen per run, plain by default (#437 `6f0484db`, `6e5871e6`)                                           | cleanly                                                                          | **Reuse** with the format.                                                                                                                                                                                                                                               |
| `WindowProjector`, `FactorExtractor`, `min_valid` (#437 `project.rs`, solver changes)                                                     | cleanly in `compress/`; `trace/solver.rs` was not checked against main's changes | **Later.** Extract on factors can run on rebuilt frames (main's back-fill path) first. The extractor is 22-137x faster for Extract alone (phase 2) and matches rebuilt frames to about 1e-4 on sims, not on the WL24 recordings (1.5 % of a trace's sd). Port for speed. |
| `factor_refine.rs`: `refine_on_factors`, `refine_until_settled` (#437)                                                                    | new file, cleanly                                                                | **Not as the Final settle** (see decision 2).                                                                                                                                                                                                                            |
| `refineOnFactors` binding, JS `FactorReader` (#442)                                                                                       | conflicts (`js.rs`, slow worker)                                                 | **Dropped** with `refine_on_factors`.                                                                                                                                                                                                                                    |
| `LookBack::set_available` and `choose_block` (#437 `lookback.rs`)                                                                         | conflicts                                                                        | **Later**: look-back on factors during a stream (decision 3).                                                                                                                                                                                                            |
| Harness: `--lookback-source factors` and `FactorFrames`; `--refine-engine`, `--extract-engine`, `--factors-pass`, `--tiling` (#437)       | conflicts; main's `qc_eval` lacks the phase-0 harness flags                      | **Port `FactorFrames` only** and add `--settle-source factors`. The rest compared against the removed Refine.                                                                                                                                                            |
| Compress worker `extract` job, `factor-extract.ts`, factor Extract in `pass2-store.ts` (#440)                                             | `pass2-store.ts` merges; the job is built on v2 and the extractor                | **Ideas reused, code rewritten** in slice 3 on the frame route.                                                                                                                                                                                                          |
| `compress-store.ts` `factorState` and the replay mark (#440)                                                                              | the replay mark belongs to the removed Refine replay                             | **Port `factorState`** (none, compressing, ready, unusable) without the replay source.                                                                                                                                                                                   |
| Web Lock per OPFS run folder, sweep that skips locked folders, `pinned` (#440 `window-store.ts`)                                          | cleanly                                                                          | **Reuse** once the factors are relied on (slice 2). Today's sweep deletes other runs' folders at page load (README).                                                                                                                                                     |
| Export format 7 with each stage's source and `extract_min_valid` (#440)                                                                   | conflicts; main is at format 6                                                   | **Rewrite** with the stage source only; `min_valid` comes with the extractor.                                                                                                                                                                                            |
| Live gate on the back-fill, slow worker's factor run, live Extract (#442)                                                                 | conflicts                                                                        | **Ideas reused** (a live run's factors are ready once the stream ended and every frame is compressed); code rewritten.                                                                                                                                                   |
| e2e `cala-factors.spec.ts`, `cala-helpers.ts` (#440, #442)                                                                                | the file test drives Refine                                                      | **Helpers reused**; specs rewritten.                                                                                                                                                                                                                                     |
| Tools `factor_arms.py`, `factor_closeness.py`, reports phase 0-4a                                                                         | no conflict                                                                      | **Not landed.** Gate A1 measures closeness to the removed pipeline. The reports stay readable on the branch.                                                                                                                                                             |

### Results of the factor phases that still hold

- Compression cost:
  - In Chrome, offset grids: 2.82 ms per frame on `wl24_01` and 24.25 ms on `v4` (the 600 px workshop recording),
    one worker. The 600 px replay ran ahead of the compressor: its last window was compressed 708 s after it ended
    (phase 1).
  - Native: offset grids cost about twice plain tiles (2.05 against 1.04 ms per frame on `wl24_01`, 17.16 against
    8.49 on `v4`).
  - Factor bytes: 9.2 MB per 1,000 frames on `wl24_01` and 54.9 MB on `v4`, offset grids.
- Rank cut: the trace loss comes from the rank cut, falls steadily with the rank, and has no knee. Two power
  iterations remove 26-30 % of it for about 10 % more bytes (phase 0).
- Discover's own factors differ from frames preprocessed with the final calibration. On the two real WL24 recordings
  the trace loss was 0.155 and 0.203 for Discover's factors against 0.044 and 0.049 for recalibrated ones (phases 1,
  4a). The causes are inferred, not isolated: no flat-field map before about frame 3,000, and the background and noise
  map still settling early on.
- Look-back on Discover's factors (`lb_fac`) ran with main's joint flags on and stayed close to look-back on raw
  frames on three sims. Footprint loss 0.0011-0.0183; about as many cells lost as gained.

### Results that lost their reference

- Every gate A1 verdict was measured against Discover + Refine on raw frames, which is no longer the reference. That
  covers phase 1's pass, phase 3a's fail of rule 2 on both WL24 recordings, and phase 4a's live fails.
- They still measure how far an arm moves from frames preprocessed with the final calibration. They do not say
  better or worse.

## Design

### 1. Where a recording's factors come from: Discover's own windows, offset grids

- The compress worker compresses the frames Discover forwards, as on `main` today, into factor format v2 on the two
  offset grids (64 px tiles, 600-frame windows, 2 SVD power iterations).
- The same source serves a file and a stream. A stream has no other.
- Why not the alternatives:
  - A compression replay after Discover (the old plan for files) is one more full pass over the file before the
    settle could start. It was justified by Refine's replay, which no longer exists.
  - Factors written during the settle cannot cover the recording: the settle samples blocks above 18,000 frames, and
    the Standard and Quick levels stop early.
- What it means now that the old pipeline is no reference:
  - The settle on Discover's factors will not reproduce the settle on re-read frames, at least on the WL24 setup.
  - Whether it is worse must be measured with main's own measures (acceptance, below).
  - A file whose device has a cached flat-field map gets that map from frame 0 (`pipeline-store.ts:1038-1050`).
    That removes the main suspected cause for repeat recordings of a known device (inferred). A stream never uses the
    cache.
- What would change it: if the settle on Discover's factors loses on main's measures for files, files keep the raw
  settle and only streams settle on factors. A narrower fix would rewrite only the first windows (before the first
  flat-field map) from the file. It is not designed here.
- Pace: at 600 px a file is read faster than one compress worker compresses offset grids (about 40 frames per
  second). Settling or extracting a file on factors would wait for the compressor. Sharing tiles across compress
  workers (the old spec's §3, never built) is a precondition for files by default, not for streams. At 20 fps,
  24.25 ms of compute per frame fits a 50 ms frame interval on one worker.

### 2. The Final settle on factors: main's settle, fed with frames rebuilt from the factors

- The settle stays as it is: edit scope `refine`, the plan and levels, 16-frame requests, ordinary `observe` with the
  stream index, visits after each answer, checkpoints, the last round, Stop.
- Only where worker 0 gets a frame changes. Instead of re-reading the file and preprocessing, it rebuilds the frame
  from its factor window (`WindowFactors::reconstruct`). Pixels never valid in that window are missing, as in a live
  frame. It then solves with the newest library, as now.
- Why not `refine_on_factors` (#437):
  - It refuses the cluster replay: `joint_update` must be off (`frozen_refusal`, `factor_refine.rs:1088-1101` on
    #442). Main's look-back slow loop runs with it on, and settle-size found the replay is what improves main's
    footprints. Porting the replay to factors ("phase 3b") was never built.
  - Its statistics differ:
    - no forgetting (weight 1 on every frame);
    - a fixed library and noise map per iteration;
    - its own held-out patches, picked per tile;
    - its own stop rule (cosine 0.99 for 98 % of cells, at most 20 iterations) instead of main's fixed in-order
      plan with Thorough, Standard and Quick.
  - It does not use the visit workers.
  - Phase 3a: against a raw Refine, with the replay off, it plateaued above the footprint rule on both WL24
    recordings.
  - Its advantage is speed: no per-frame `observe`. It is the candidate for later, once it has the replay and is
    measured.
- Expected cost (inferred):
  - Worker 0 drops the read and preprocessing, about 3.6 of 4.3 ms per frame, and adds a rebuild. The back-fill
    measured 0.11-2.57 ms per frame for rebuild and solve together.
  - The slow worker's `observe` (2.0-2.3 ms per 600x600 frame) stays the limit. So a settle on factors is not
    expected to be much faster than #491's.
  - Its value is a source that a stream has, not speed.
- The new risk is that the frames are low-rank. The noise the rank cut drops is also missing from:
  - the reservoir's held-out frames, which the refine gate tests on;
  - the split-half noise behind "cells still moving".
  - The gate could pass more or less than on raw frames. Settle-size's `ST-frozen` arm shows fresh held-out frames
    matter: +34 px of footprint size, -1.5 points of light left out. Measured in slice 1.
  - Fallbacks if it misbehaves, not designed here:
    - feed factor frames to the statistics only (`observe_lookback` style, reservoir not offered) and keep held-out
      frames from Discover;
    - put the dropped noise back into the held-out frames from each pixel's discarded variance, which format v2
      stores per tile (`TileFactors::discarded`).

### 3. Look-back during Discover: unchanged in the first slices

- A file's look-back keeps re-reading the file. On factors it would wait for windows not yet compressed (the
  scheduler's `set_available`, #437), and `lb_fac` served 2-16 % fewer look-back frames than raw.
- A stream has no look-back on `main`. Look-back on its factors during the stream is the natural later slice (port
  `set_available` and `choose_block`). It changes Discover's live library and needs its own measurement. Not in the
  first slices.

### 4. Extract on factors: rebuilt frames, started as main starts Extract

- Extract on factors rebuilds 16 frames at a time and solves them with the final library: the back-fill on `main`,
  promoted to the Extract stage. It is the same rebuild path as the settle's. `FactorExtractor` replaces it later for
  speed.
- It starts as main's Extract does, when Discover's final library is out and "Extract after Discover" is on.
- Factor states (ported from #440 without the replay source):
  - `ready`: every window compressed and the windows cover every frame Discover read;
  - `compressing`: windows remain;
  - `unusable`: a compression error, or windows that do not cover the frames.
- When the factors are not ready:
  - Stream: Extract waits for `ready`, shows "waiting for the last windows to be compressed", and can be cancelled.
    `unusable`: Extract is blocked with the reason. A stream has no other source.
  - File (slice 3): Extract replays the file as today and says why ("the factors are still being compressed" or
    "could not be read"). A file never waits.
- What the traces are: solved on low-rank frames, so most of the per-frame noise is gone. Phase 4a's `lb_live` had a
  higher truth correlation (+0.007 to +0.106 median) and a large trace loss against the file. The export must say the
  traces come from factors, because a downstream deconvolution that models the noise sees less of it (inferred risk).

### 5. A live stream (the main use case)

When the stream ends, and only with `?factors` until measured:

1. Discover's last window is closed and compressed. A one-frame tail window is dropped, as on #442: fewer than 2
   frames cannot be compressed.
2. The Final settle runs on the stream's own factors, at the level chosen in the Run panel, with the same readout and
   Stop.
3. Extract on the factors follows when "Extract after Discover" is on.

What it needs that a stream lacks today:

- A slow loop that can run the cluster replay in the settle. Main's engine has two ways:
  - `jointUpdate: 'refine'` keeps the store and the replay to refine-scope visits (`discover/mod.rs:360-371`), so a
    stream's Discover stays as it is today (replay off). This is settle-size's `REF+S` arm: every cell kept and the same
    footprint fill as the full path (settle-size, item 5). A test must show that Discover with `refine` publishes the
    same libraries as with `off`; that is read from the doc comment, not verified.
  - `jointUpdate: 'all'`, as a file's look-back run has it: the live library gets the replay too (fewer bitten
    footprints while streaming), at the cost of weak cells on dense data (settle-size, item 4). The PI's 19 Nov
    decision kept the replay in Discover because the live library matters for streaming.
  - Decided by the owner (23 Nov): `refine`, the replay in the settle only. A stream's live Discover stays as it is
    today.
- The held-out side of each stream frame, so a settle frame keeps its side as on a file. That is the look-back's
  `HeldOutRecord`, which needs `enableLookback` (inferred: with rate 0 it records sides and asks for nothing; to be
  verified).
- A settle path in `SlowRunner.end` that does not require look-back. The look-back worker is started at the stream's
  end with a factor source only.

What the export says:

- The Discover stage record gains `settle_source: 'factors'`, and the Extract record gains `source: 'factors'`, with
  the tiling, windows and mean rank.
- A note: "Settle and Extract read the factors Discover wrote during the stream; there was no file to re-read."
- Both sets of traces (owner, 23 Nov): the live traces Discover solved as the frames came in, and the traces Extract
  solved on the factors. Extract adds its traces; it never replaces the live ones.

Not claimed: that a stream's settle or Extract equals a recording's; any closeness gate.

### 6. Acceptance: main's measures, against main's own run-to-run spread

The old gate A1 compared with a pipeline that is gone. The new one uses what settle-size and the beta gate measure.
The lines are set in the evaluation plan before any run.

- **Arms** (`qc_eval`; the same Discover for each pair):
  - `SET-R`: look-back + replay, settle on re-read frames (main today);
  - `SET-F`: as `SET-R`, settle on Discover's factors (offset grids);
  - `STR-0`: Discover without look-back, `--joint-update refine`, no settle (a stream on main today);
  - `STR-F`: as `STR-0`, settle on its factors.
- **Recordings:**
  - the two v3 sims at the real cell size (settle-size's) and 3 of the 14 larger-cell sims;
  - real: `wl24_01` (the owner's wireless setup) and Samara `10_43_21`, first 6,000-12,000 frames;
  - 2 seeds per arm.
- **Measures:**
  - sims, against ground truth (settle-size's, `tools/cala-eval/settle_size.py`): light left out, light in excess
    (and on a neighbour's soma), core shape error, bitten share, close-pair trace crosstalk, true cells found, false
    cells;
  - real: held-out score on frames no run saw, residual structure, close-pair crosstalk excess;
  - both: repeatability (median single-pair cosine, same arm, two seeds);
  - speed (owner, 23 Nov: "test if this is all fast enough"): the settle's frames per second and wall time per arm
    (`qc_eval` stdout), and the compressor's ms per frame on the offset grids.
- **Pass lines** (proposed):
  - `SET-F` against `SET-R`: on each measure, the paired difference is within `SET-R`'s run-to-run spread or better;
    true cells found are equal; repeatability is at least `SET-R`'s.
  - `STR-F` against `STR-0`: light left out and bitten share are lower, false cells are no more than the spread
    allows, and the held-out score is no lower than the spread allows.
  - `STR-F` against `SET-R` (the ceiling for a stream): reported, not a line.
  - Speed, native (`qc_eval`): `SET-F`'s settle takes no longer than `SET-R`'s, beyond their run-to-run spread.
  - Speed, in Chrome (slice 2, a simulated 600 px stream at 20 fps with the usual workers running):
    - the compress worker keeps up: no window waits longer than one window (30 s) to be compressed, and nothing is
      queued at the end beyond the last window;
    - the frames dropped for the slow loop do not rise against the same stream without `?factors`;
    - after the stream ends, the settle and Extract on factors finish in a time the owner accepts (reported per
      minute of stream; the owner sets the line after the first run).
- **Cheap before the beta:**
  - 2 v3 sims + `wl24_01`, 4 arms, 2 seeds: 24 bounded `qc_eval` runs. Run time was not estimated by reading;
    settle-size ran comparable batches.
  - One headed-Chrome smoke run per slice, and in slice 2 the Chrome speed check above (3 runs with `?factors`,
    3 without, interleaved).
- **What would change the plan:**
  - `SET-F` fails while `STR-F` passes: files keep the raw settle; streams go ahead.
  - `STR-F` fails: a stream's settle on factors stays off. Only Extract on factors ships for streams, and decision 2's
    fallback is measured next.

### 7. How to land it: new branches from `main`, small PRs, each behind a switch

| PR  | branch                      | content                                                                                                                                                               | switch                                        |
| --- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1   | `feat/cala-factors-settle`  | Slice 1: factor format v2 + offset grids (cherry-picked from #437), `qc_eval` `--factors-tiling`, `FactorFrames`, `--settle-source factors`, settle without look-back | `?compress` writes v2, plain tiles by default |
| 1e  | `eval/cala-settle-factors`  | the evaluation of decision 6 (plan committed before runs), not for merge                                                                                              | none                                          |
| 2   | `feat/cala-factors-live`    | Slice 2: a stream's Final settle and Extract on its factors                                                                                                           | `?factors`                                    |
| 3   | `feat/cala-factors-file`    | Slice 3: a file's settle and Extract on factors, never waiting                                                                                                        | `?factors=file`                               |
| 4   | `feat/cala-factors-default` | defaults from the measurements, docs                                                                                                                                  | -                                             |

- Each PR is reviewable alone by the maintainer: PR 1 is crate and harness; PR 2 and 3 are app.
- PR 2 and 3 touch `slow-runner.ts` and `lookback-worker.ts`, as #491 and #470 do. Start PR 2 after #491 has landed or
  been declined, and ask the maintainer to review it.
- PRs #437, #440, #442: closed as superseded once PR 1 is open (owner, 23 Nov: "we don't need PRs anymore that are
  not relevant"), with a comment linking this spec; the branches stay for their reports and code. Closing them is
  done with the owner's yes at that time.

## Risks

- Low-rank frames in the held-out test (decision 2): could move the settle's acceptance either way. Measured in
  slice 1.
- Compression pace on 600 px files: factors would make a file's settle and Extract wait for the compressor. Slice 3
  never waits; defaults for files need parallel compression.
- OPFS sharing: the look-back worker reading windows that the compress worker still writes. On #442 the sequencing of
  synchronous access handles across workers needed care (its execution notes). The rule: a reader opens only
  compressed windows and never creates, lists or removes.
- Storage: offset-grid factors are about 55 MB per 1,000 frames at 600 px. An hour at 20 fps is about 4 GB in OPFS.
  No quota check exists yet.
- Denoised traces in the export (decision 4): the stage source must be visible to whoever deconvolves them.
- Conflicts with #491 and #470 in the settle code.

## Not in scope

- `refine_on_factors` as the Final settle, and the cluster replay on factors.
- Look-back on factors during a stream; any change to a file's look-back.
- `FactorExtractor` (speed), `min_valid` in the export.
- Parallel compression (tiles shared across workers), a storage quota or cap, factors saved to the results folder.
- A flat-field seed for streams from an earlier session.
- Joint multi-session runs on factors (on `main` since v2.21.0 they have look-back and a Final settle on re-read
  frames, each frame preprocessed as its own session's).
- The history review on offset grids (it keeps plain tiles).
- Changing any default before the measurements.

## Decided by the owner (23 Nov)

1. "Not frame-to-frame" means Discover does not work on factors. Discover keeps running its slow loop on the live
   frames, on a file and on a stream; one worker is set aside to compress what Discover forwards. The Final settle
   and Extract work on the stored factors. That is decisions 1, 2 and 4 as written.
2. PRs #437, #440, #442 are not needed any more: closed once PR 1 is open (section 7).
3. Speed is tested (decision 6, speed lines).
4. An export keeps both the live traces and the traces of Extract on factors (decision 5).
5. A stream's slow loop runs the cluster replay in the settle only (`jointUpdate: 'refine'`), not during the live
   Discover (decision 5).
6. The app has two versions, both in scope: people stream directly into the app (slice 2), or load videos they
   recorded (slice 3).

## Still open

1. Which app slice comes first? Recommendation, not objected to: streams.
2. The acceptance lines and the evaluation budget of decision 6: not commented on; slice 1's Task 6 writes them
   down before any run.
