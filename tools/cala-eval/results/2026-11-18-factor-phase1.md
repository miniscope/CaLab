# Factor pipeline, phase 1: the chosen factors against gate A1

Spec: `docs/superpowers/specs/2026-11-17-cala-factor-pipeline-design.md` (Amendment 1, sections A1 and A7).
Plan: `docs/superpowers/plans/2026-11-18-cala-factor-phase1.md`.
Commit: `qc_eval` built at 6e5871e6 on `feat/cala-factor-format-v2`; the browser build includes the file-handle fix
e683600e (see "How it was measured" and "What went wrong in the browser runs").
Machine: Apple M1 Max, 10 cores, 32 GB. Runs of 18 Nov 2026. Data: the run folder `factor_phase1_20261118`.

Phase 1 made the compressed factors ready as pipeline input: factor files in format v2, the two offset tile grids,
two power iterations of the SVD, and recalibrated factors (written during a replay, after the calibration has
settled). `chosen` is that combination. Gate A1 compares a run on the factors with a run on the raw frames, over the
cells that pass QC (QC-pass cells). A loss is 1 minus the median of a measure over the QC-pass cells, as in phase 0.

Summary:

- **Gate A1 (native runs): `chosen` passes on all six recordings.** No rule failed. The closest margins are on the two
  real wireless recordings (tile-line jump up by 0.065 and 0.050 of an allowed 0.10; trace loss 0.044 and 0.049 of
  0.08).
- **Browser: both stages compress to the end on both recordings,** after a fix for a file-handle stall in Chrome. The
  compress worker needs 1.45 to 24.25 ms per frame, against a frame interval of 50 ms.
- Open points:
  - The factors of `chosen` are about twice the bytes of plain tiles (the two v2 per-pixel arrays are 11 to 23 percent
    of them).
  - The three real recordings have fixed pixels that are non-finite in every frame; the cause is not known.
  - The native compression times were measured under load: they are upper bounds.
  - Each browser configuration ran once: there is no spread.

## Gate A1

| recording | QC-pass cells (lost) | 1 truth: median, 5th pct                  | 2 footprint loss | 3 trace loss           | 4 jump, arm against raw | gate |
| --------- | -------------------- | ----------------------------------------- | ---------------- | ---------------------- | ----------------------- | ---- |
| wl200     | 63 (0)               | +0.0132, -0.0272 (22 cells): pass         | 0.0052: pass     | 0.1039: does not apply | 0.968 / 0.976: pass     | pass |
| wl24_01   | 58 (0)               | no truth: does not apply                  | 0.0086: pass     | 0.0441: pass           | 1.060 / 0.995: pass     | pass |
| wl24_04   | 40 (0)               | no truth: does not apply                  | 0.0072: pass     | 0.0487: pass           | 1.099 / 1.049: pass     | pass |
| plain     | 142 (0)              | +0.0016, -0.0050 (135 cells): pass        | 0.0000: pass     | 0.0015: does not apply | 0.965 / 0.962: pass     | pass |
| v4        | 202 (0)              | no truth: does not apply                  | 0.0000: pass     | 0.0010: pass           | 0.931 / 0.929: pass     | pass |
| motion    | 178 (0)              | not usable (median 0.403): does not apply | 0.0006: pass     | 0.0009: pass           | 0.890 / 0.897: pass     | pass |

The arm `chosen` against `raw`, per recording, as the A1 table at the end of each recording's `report.md` gives it.
The limits are: rule 1 median at least -0.01 and 5th percentile at least -0.05; rule 2 at most 0.02; rule 3 at most
0.08; rule 4 at most 0.10 above raw. `chosen` passes gate A1 on all six recordings. No rule failed.

The closest margins:

- **Tile lines on the wireless recordings.** The jump rises by 0.065 on `wl24_01` and by 0.050 on `wl24_04`, against
  an allowed 0.10: 65 and 50 percent of the limit. On the other four recordings it rises by at most 0.003 or falls.
- **Trace loss on the wireless recordings.** 0.0441 on `wl24_01` and 0.0487 on `wl24_04`, against 0.08: 55 and 61
  percent of the limit.
- **Truth on `wl200`.** The 5th percentile is -0.0272 against -0.05, over 22 cells, so it rests on one or two cells.
  The trace loss there is 0.1039, above the 0.08 of rule 3; rule 3 does not apply on `wl200` because its truth is
  usable.
- The footprint loss uses at most 43 percent of its limit (0.0086 on `wl24_01`).

Two points of the gate as built, for the user:

- **Lost cells.** The gate counts a QC-pass cell that the factor run loses, or whose value is not finite, as the worst
  case in every rule (loss 1; truth correlation 0 in the factor run). Amendment 1 does not say this; it is a ruling
  made while building the gate and is not yet decided by the user. In these runs no QC-pass cell was lost on any
  recording (the "lost" column), so the ruling did not change any result.
- **Usable truth** is decided on the raw run alone: at least 20 QC-pass cells with a truth correlation, and their
  median at least 0.8. `motion` has truth, but it is not usable (92 cells, median 0.403), so rule 3 applies there
  instead of rule 1. `wl24_01`, `wl24_04` and `v4` have no truth.

**Decision: open, for the user.**

## How it was measured

`tools/cala-eval/factor_arms.py` ran `qc_eval` once per arm and recording, from the script `run_all.sh` in the run
folder, with the log `run_all.log`. All 27 arms ended with return code 0.

- **Build.** The release `qc_eval` was built at commit 6e5871e6. `run_all.log` prints the checkout's HEAD at the start
  of the runs (a99ee8c6); the Rust sources did not change between the two. The later commits, up to this report's,
  change neither what the compressor computes nor what the gate computes; the review of the whole branch checked this.
  The reports were rebuilt with the final gate code (c57a831c) from the same runs.
- **Scale, as in phase 0.** 200 px recordings (`wl200`, `wl24_01`, `wl24_04`): first 12000 frames, 5 refine replays, 3
  runs at once. 600 px recordings (`plain`, `v4`, `motion`): first 6000 frames, 2 refine replays, 2 runs at once.
- **Budget.** 3,000,000 slow-loop work units per frame on every arm, a tenth of `qc_eval`'s default. `null_lo` and
  `null_hi` used half and twice that in the replays.
- **Arms.** `raw`, `null_lo`, `null_hi` (200 px only), `plain_recal` and `chosen`. No arm of phase 0 was reused: the
  compressor's defaults changed (two power iterations, format v2).
- **`plain_recal`**: plain 64 px tiles; the factors are written during the first refine replay.
- **`chosen`**: the two offset grids (`--tiling offset`, a second grid shifted 32 px); the factors are written during
  the first refine replay (`--factors-pass 2`). In both factor arms the first refine replay still solves on the raw
  frames and writes the recalibrated factors. The later replays and Extract solve on frames rebuilt from those
  factors: at 600 px one of the two refine replays and Extract, at 200 px four of the five and Extract.
- **Tile lines.** For `chosen` the tile-line measures (distance to a tile line, footprint jump) use lines every 32 px,
  where the lines of both grids lie. For `plain_recal` they use 64 px. So the raw run's own jump differs between the
  two arms' rows (for example 0.995 against 1.150 on `wl24_01`).
- **Truth and lag-1 trace correlation** as in phase 0. The truth rule is evaluated on QC-pass cells (A7).
- **Browser.** `apps/cala/scripts/batch-session.mjs` drove the app in Chrome on `wl24_01` and `v4`: whole recordings,
  Discover then Extract, no Refine, once with default settings and once with `?compress`. One run at a time, from
  20:51 to 21:30 on 18 Nov, with no `qc_eval` or `discover_eval` process running at the start of each run. Motion
  correction ran on WebGPU in all four runs. The build (`npm run build:e2e`, 20:46) was made from the working tree with
  the file-handle fix that was committed as e683600e a few minutes later (the run log prints the commit before it,
  b63b97d4); the built compress worker contains the fix. The export writer's fix (aeaabf85) came after the runs.

Every number in this report was computed by short scripts over the run folder's `report.md`, `run.json`,
`factors.tsv`, factor window files and, for the browser, the driver's `status.json` and the app's exports; not copied
by hand.

## Against plain recalibrated factors

| recording | arm           | trace loss (lag 1) | footprint loss | jump raw / arm | mean rank | MB per 1000 frames | compression ms per frame | gate A1 |
| --------- | ------------- | ------------------ | -------------- | -------------- | --------- | ------------------ | ------------------------ | ------- |
| wl200     | `plain_recal` | 0.11646            | 0.00628        | 0.979 / 1.738  | 5.8       | 2.6                | 1.17                     | fail    |
| wl200     | `chosen`      | 0.10390            | 0.00519        | 0.976 / 0.968  | 5.0       | 4.9                | 2.20                     | pass    |
| wl24_01   | `plain_recal` | 0.04440            | 0.00969        | 1.150 / 1.325  | 11.4      | 4.9                | 1.04                     | fail    |
| wl24_01   | `chosen`      | 0.04411            | 0.00857        | 0.995 / 1.060  | 11.4      | 9.6                | 2.05                     | pass    |
| wl24_04   | `plain_recal` | 0.05555            | 0.00838        | 1.071 / 1.507  | 9.3       | 4.0                | 1.10                     | fail    |
| wl24_04   | `chosen`      | 0.04866            | 0.00722        | 1.049 / 1.099  | 9.4       | 8.1                | 2.16                     | pass    |
| plain     | `plain_recal` | 0.00177            | 0.00006        | 0.933 / 0.960  | 4.5       | 20.5               | 8.55                     | pass    |
| plain     | `chosen`      | 0.00147            | 0.00003        | 0.962 / 0.965  | 4.6       | 41.4               | 17.06                    | pass    |
| v4        | `plain_recal` | 0.00136            | 0.00000        | 0.895 / 0.925  | 7.9       | 29.7               | 8.49                     | pass    |
| v4        | `chosen`      | 0.00101            | 0.00000        | 0.929 / 0.931  | 8.0       | 60.4               | 17.16                    | pass    |
| motion    | `plain_recal` | 0.00111            | 0.00081        | 0.929 / 0.958  | 6.1       | 25.0               | 8.73                     | pass    |
| motion    | `chosen`      | 0.00091            | 0.00063        | 0.897 / 0.890  | 6.1       | 49.8               | 17.25                    | pass    |

Losses of the QC-pass cells, footprint jump at tile lines, and the cost of the factors, for the two factor arms.
`chosen` has a lower trace loss and a lower footprint loss than `plain_recal` on all six recordings; on `wl24_01` the
trace loss is nearly the same (0.04411 against 0.04440). `plain_recal` fails rule 4 on the three 200 px recordings
(jump up by 0.759, 0.175 and 0.436) and passes it at 600 px. `chosen` costs about twice the bytes and twice the
compression time of `plain_recal`. Its mean rank is the same, except on `wl200` (5.0 against 5.8).

`plain_recal` now has the settings of phase 0's `recal_iter2` (two power iterations, plain tiles, factors of the first
replay). On the 200 px recordings it gives the same trace and footprint losses to five decimals (0.11646, 0.04440,
0.05555 and 0.00628, 0.00969, 0.00838) and the same jumps (1.738, 1.325, 1.507). So format v2 and the other changes of
this phase did not change these results there.

### What format v2 costs in bytes

Format v2 stores two more per-pixel arrays per tile and window: the discarded variance and the valid share. That is 8
bytes per pixel and window on plain tiles, and twice that on the two offset grids, where every pixel is in two tiles.

| recording | arm           | MB per 1000 frames | of which v2 arrays | share | without them | phase 0, comparable arm           |
| --------- | ------------- | ------------------ | ------------------ | ----- | ------------ | --------------------------------- |
| wl200     | `plain_recal` | 2.62               | 0.53               | 0.204 | 2.08         | 2.1 (`recal_iter2`)               |
| wl200     | `chosen`      | 4.89               | 1.07               | 0.218 | 3.82         | 3.5 (`offset`, see below)         |
| wl24_01   | `plain_recal` | 4.87               | 0.53               | 0.110 | 4.33         | 4.3 (`recal_iter2`)               |
| wl24_01   | `chosen`      | 9.57               | 1.07               | 0.111 | 8.50         | 7.2 (`offset`)                    |
| wl24_04   | `plain_recal` | 4.04               | 0.53               | 0.132 | 3.50         | 3.5 (`recal_iter2`)               |
| wl24_04   | `chosen`      | 8.05               | 1.07               | 0.132 | 6.99         | 6.2 (`offset`)                    |
| plain     | `plain_recal` | 20.51              | 4.80               | 0.234 | 15.71        | 14.5 (`plain_recal`, 1 iteration) |
| plain     | `chosen`      | 41.38              | 9.60               | 0.232 | 31.78        | 30.2 (`offset`)                   |
| v4        | `plain_recal` | 29.70              | 4.80               | 0.162 | 24.90        | 22.6 (`plain_recal`, 1 iteration) |
| v4        | `chosen`      | 60.38              | 9.60               | 0.159 | 50.78        | 75.3 (`offset`)                   |
| motion    | `plain_recal` | 25.05              | 4.80               | 0.192 | 20.25        | 18.4 (`plain_recal`, 1 iteration) |
| motion    | `chosen`      | 49.83              | 9.60               | 0.193 | 40.23        | 37.5 (`offset`)                   |

The size of the factors in phase 1, the part of it that the two v2 arrays take (counted from the tiles of every factor
file), and phase 0's size for the closest arm. The v2 arrays are 11 to 23 percent of the bytes, in both arms: a fixed
0.53 MB per 1000 frames per grid at 200 px and 4.8 MB at 600 px, so the share is largest where the rank is low
(`wl200`, `plain`). Without them, `plain_recal` at 200 px is the size of phase 0's `recal_iter2` (2.08 against 2.1).
Phase 0 has no arm with the same factors as `chosen`: its `offset` arm used the factors of Discover with one power
iteration, which have a higher rank on `v4` (12.2 against 8.0) and are larger there.

## Compression time against the frame budget

### Native

| recording | frame budget, ms | `plain_recal` ms per frame: mean, slowest window | `chosen` ms per frame: mean, slowest window | `chosen`, slowest window, share of budget |
| --------- | ---------------- | ------------------------------------------------ | ------------------------------------------- | ----------------------------------------- |
| wl200     | 50.0             | 1.17, 1.38                                       | 2.20, 2.83                                  | 0.06                                      |
| wl24_01   | 50.0             | 1.04, 1.26                                       | 2.05, 2.46                                  | 0.05                                      |
| wl24_04   | 50.0             | 1.10, 1.71                                       | 2.16, 3.87                                  | 0.08                                      |
| plain     | 50.0             | 8.55, 8.91                                       | 17.06, 17.81                                | 0.36                                      |
| v4        | 50.0             | 8.49, 9.31                                       | 17.16, 18.09                                | 0.36                                      |
| motion    | 50.0             | 8.73, 9.31                                       | 17.25, 18.26                                | 0.37                                      |

Compression milliseconds per frame from `factors.tsv` (compute time summed over the tiles, so the cost on one thread),
mean over the windows and the slowest window, beside the frame budget of 1000 divided by the frame rate. All six
recordings are 20 fps (from each dataset's `meta.json`, for `v4` from its README). `chosen` needs at most 37 percent of
the budget on one thread at 600 px and at most 8 percent at 200 px.

These times were measured under load: the runs shared the machine with the test suites of the code reviews and with
`qc_eval` processes of another project, beside 2 or 3 runs of this phase at once. They are upper bounds.

### Browser

With `?compress`, every window of both stages was compressed on both recordings, and the compress worker needs at most
24.25 ms per frame, half the 50 ms frame interval. Compression runs in a worker of its own, in WebAssembly on the CPU;
it does not slow the stages themselves by more than 4 percent.

Stage seconds, from the app's own stage records in each export:

| recording | stage    | outcome     | frames | seconds, default | seconds, ?compress | ratio | cells, default / ?compress |
| --------- | -------- | ----------- | ------ | ---------------- | ------------------ | ----- | -------------------------- |
| wl24_01   | Discover | done / done | 40234  | 33.6             | 33.8               | 1.01  | 89 / 84                    |
| wl24_01   | Extract  | done / done | 40234  | 30.7             | 29.2               | 0.95  | 89 / 84                    |
| v4        | Discover | done / done | 23711  | 160.0            | 166.3              | 1.04  | 822 / 808                  |
| v4        | Extract  | done / done | 23711  | 192.9            | 196.2              | 1.02  | 822 / 808                  |

The compress status at the end of each stage (the driver's `status.json`), and when the stage's factors were complete:

| recording | stage    | tiles / source   | windows | final | ms per frame | of 50 ms | factor MB | MB per 1000 frames | last window, s after the stage's end | stage start to last window, ms per frame |
| --------- | -------- | ---------------- | ------- | ----- | ------------ | -------- | --------- | ------------------ | ------------------------------------ | ---------------------------------------- |
| wl24_01   | Discover | plain / Discover | 68      | yes   | 1.45         | 0.03     | 185.5     | 4.6                | 33                                   | 1.67                                     |
| wl24_01   | Extract  | offset / replay  | 68      | yes   | 2.82         | 0.06     | 371.0     | 9.2                | 103                                  | 3.30                                     |
| v4        | Discover | plain / Discover | 40      | yes   | 12.54        | 0.25     | 738.5     | 31.1               | 262                                  | 18.08                                    |
| v4        | Extract  | offset / replay  | 40      | yes   | 24.25        | 0.49     | 1301.6    | 54.9               | 708                                  | 38.14                                    |

"ms per frame" is the compress worker's compute time, the mean over the session's windows. "Windows" is the frame
count divided by 600, rounded up, in all four rows. MB is 10^6 bytes (the status bar shows 704 and 1241 for `v4`, in
units of 2^20 bytes). The last two columns are measured from the app's stage end to the driver's next step, which
waits for the last window (polling every 0.5 s): an upper bound, close to the true time when the wait is long. In the
default runs the same step took at most 0.1 s.

- The stages run faster than real time (about 1200 frames per second at 200 px, 120 to 150 at 600 px), and compression
  falls behind them on file recordings: on `v4` the last window of Extract's replay was compressed 708 s after Extract
  ended. Against the camera's 20 fps it keeps up: from the start of a stage to its last window the worker took at most
  38.14 ms per frame, three quarters of the frame interval, and its compute time is at most half of it.
- Extract's replay replaces Discover's factors in the store. The compress worker clears the store when a new
  compression session starts, so the 371.0 and 1301.6 MB of the replay are the only factors on disk after the run; the
  two sizes do not add up.
- The cell counts differ between default and `?compress` runs (89 against 84, 822 against 808), as in phase 0, so the
  stage times are not a like-for-like comparison. The stage ratios are close to 1 either way.
- Each configuration ran once; there is no spread.

### The phase's gate sentence

"Compression time of that combination within the live frame budget": natively, on one thread, `chosen` is within the
budget on `wl24_01` (2.05 ms per frame against 50) and on `v4` (17.16 against 50), and on the other four recordings. In
the browser the offset-grid replay needs 2.82 and 24.25 ms per frame of compute, within the budget on both recordings.
Only the compression is compared with the budget; whether it fits beside the rest of the pipeline on a machine with
fewer cores was not measured.

## Valid share

| recording | windows read | frame pixels with a valid share below 1 | share of the frame | values below 1 | same pixels in every window |
| --------- | ------------ | --------------------------------------- | ------------------ | -------------- | --------------------------- |
| motion    | 10           | 0                                       | 0                  | none           | yes                         |
| v4        | 10           | 30                                      | 0.0001             | all 0          | yes                         |

The valid share is the share of a window's frames in which a pixel was not missing. The table reads it from every
`chosen` factor file of the two recordings (both grids; a pixel counts when a tile that covers it has a value below 1).

- On `motion` no pixel is ever missing. The motion of this synthetic set leaves no missing samples in the factors, so
  this run does not exercise the valid share at the frame border.
- On `v4` 30 scattered pixels are missing in every frame of every window (valid share 0); all others are 1. No pixel
  has a value between 0 and 1.
- The other recordings, read the same way: `wl24_01` 105 pixels and `wl24_04` 66 pixels (0.26 and 0.17 percent of the
  frame) with valid share 0 in every window, and none on `wl200` and `plain`. So the fixed missing pixels occur on the
  three real recordings only.

Where these pixels come from was not investigated. The stored flat field maps of the three real recordings are finite
(range 0.80 to 1.25), so they are not the cause. Nothing reads the valid share in this phase.

## What went wrong in the browser runs

Two earlier browser series are void. Their outputs are kept in the run folder as `browser_wrong_build_v2.19.1` and
`browser_stale_build_a99ee8c6`.

1. **Wrong build.** The first series used the driver's default port 4181. A static server of another checkout had held
   that port since 16 Nov, 22:23, serving a v2.19.1 build. The driver's own server could not start, and the old server
   answered. Fix b63b97d4: the driver refuses a port that already answers.
2. **Stale build.** The second series (18:09 and 19:12) served a build made at 16:32 from a99ee8c6, before the last
   fixes of the phase. Fixes a109d534 and ddb1fcdd: the driver refuses a build older than the sources (`--stale-build`
   overrides) and records the build time in `status.json` (`built`).
3. **Compression stopped partway, without an error.** In both void series and in probes of the then-current build, the
   compress status stopped growing during a stage and never turned final: `wl24_01` at 52, 23 and 21 of 68 windows,
   `v4` at 10 of 40, Extract's replay once at 16 of 68. The cause: Chrome (version 158) never settles a pending
   `createSyncAccessHandle()` when its file handle is garbage-collected during the call, and the compress file store
   called it on a temporary handle. A lost open stops the compress worker's queue. In an isolated test with forced
   collections, 19 of 20 opens on a temporary handle were lost, and none of 20 with the handle kept; `createWritable`
   and `getFileHandle` lost none. The v2.19.1 build stalled the same way (43 windows, then a page crash), so the fault
   predates this branch. Fix e683600e: the store keeps every handle referenced until its call settles. aeaabf85 does
   the same in the export writer, where no failure was seen. With the fix, one probe and the two `?compress`
   runs above compressed every window. Probe builds with extra logging never stalled, so they are not evidence for the fix.

For phase 0 this means: its browser runs (18 Nov, 11:42 to 12:13) used port 4181 too, so their stage times were very
probably measured on the v2.19.1 build, not on the phase 0 branch (inferred from the port and the server's start time;
not re-measured). Its `?compress` runs were also exposed to the stall. The phase 0 report has a correction note. Its
native results, which carried its gate decision, are not affected.

## What was not measured

- `lowsnr` and `dense` were not run.
- Only the first 12000 (200 px) or 6000 (600 px) frames were used, with 5 or 2 refine replays. Full-length recordings
  were not run.
- The slow-loop budget was a tenth of the default. Nothing was measured at the default budget.
- Live streams were not measured. A live run has no replay, so its factors are the factors of Discover; A4 leaves
  rules 1 to 4 for that case to a simulated stream before phase 4.
- Three or more power iterations were not measured.
- Extract and Refine on factors (phases 2 and 3) do not exist yet. The factor arms rebuild full frames and run the
  existing engine, so they measure the loss, not a speed-up.
- The 600 px recordings have no `null_hi`; their null is `null_lo` alone. The null spread stays in each `report.md`
  but is not part of gate A1.
- Peak memory is in each `report.md` per arm and was not analysed here.
- The native compression times are upper bounds (see above). Each browser configuration ran once, on two recordings,
  with no Refine.
- The history review (`?compress&review`) was not run in the browser.
- The motion band (under 16 px from the border) is reported in each `report.md`, not gated.

### Left for later

- With `?compress` in the app, Extract's replay replaces Discover's plain factors: same session, same file names. After
  a full run only the recalibrated set on the offset grids exists, and an Extract that is cancelled leaves no factors.
  Nothing reads the factors after Discover's history review in this phase, so this is harmless now. Phase 3 (Refine on
  factors) needs the factors before Refine, and adds a separate compression replay for them.
- The history review still reads Discover's factors on plain tiles; reading the offset grids belongs to phase 4.
- Nothing reads the discarded variance or the valid share yet. Extract on factors (phase 2) and Refine on factors
  (phase 3) do.

## Notes on the data

- The browser's "mean rank" in the compress status is that of the last window only, which is short (34 frames on
  `wl24_01`, 311 on `v4`) and keeps few components: it reads 1.00 on `wl24_01` and 3.74 and 3.91 on `v4`. It is left
  out of the browser table. The status bar shows the same value.
- `run_all.log` lists the lines of `raw`, `plain_recal` and `chosen` twice for `plain`. Each `run.json` holds one run
  per arm, with return code 0.
- `motion`'s truth match is as in phase 0: frame offset (+15.5, +0.7) px, 145 of 262 cells matched, raw median truth
  correlation 0.4602 over all matched cells. It is not usable for rule 1.
- The flat field of the three synthetic sets got no map in any run (every update skipped: too little motion), as in
  phase 0; the three real recordings got one at frame 2999.
