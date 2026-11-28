# Discover visits on cell-free tiles: too little visit time to be worth a quiet-tile schedule

28 Nov 2026. Branch `eval/cala-tile-visit-share`, measured on main `277aa527` (before the mean-field footprint
statistics, #562; the branch is rebased after the runs and its logging is unchanged). Raw runs, logs and scripts:
`~/Projects/cala-data/runs/tile-visits/` (`scripts/runs.sh`, `scripts/build_all.sh`, `scripts/extra.sh`; tables `sims.md`, `ws.md`,
per-run rows `sims.tsv`, `ws.tsv`, per-tile rows `sims_per_tile.tsv`, `ws_per_tile.tsv`). This is the measurement in §6.5 of the 27 Nov speed and memory review
(`R-speed-memory.md`, S7). The rule was declared before any run: if under about 15 % of Discover visit time goes to
tiles that never host a cell (core and neighbouring ring empty), drop the quiet/probe idea.

## Verdict

**Drop the quiet-tile schedule.** On the workshop recording, tiles whose core never hosts a final cell take
**38–42 % of Discover visits but only 8–10 % of visit time**. Tiles whose 8 neighbours are also empty take **5–7 % of
visits and 1.0–1.5 % of visit time**. The quiet rule in §6.4 needs that empty ring for motion safety. Both shares
are under the 15 % line, the ring share by a factor of ten. Visits on empty tiles are cheap: about 10 ms against
65–94 ms on occupied tiles. They find nothing (2,500–2,900 add proposals per run, 0–1 adds), but they cost little.
On the v3 sims every tile is dense, so the empty share is about 1 % of time and the empty-ring share is 0 by
construction.

- **Crop: it helps 1 of the 12 local recordings it could read.** On the 10 Samara sessions and the workshop
  recording (600 × 600), the FOV mask covers 77–80 % of the sensor and its bounding box 93–97 %. A crop would save
  at most 3–7 % of per-pixel work there. The one GRINiscope recording (320 × 320) is lit on 50 % of the sensor, with
  a bounding box of 74 %, so a crop would save about 26 % of per-pixel work on it. A thirteenth recording (CSHL V4)
  is FFV1-compressed, which qc_eval cannot read.
- One open point for review: the app caps Discover by **visit count** (fixed rate), not by time. Under a count cap,
  the 40 % of visits on empty cores could in principle go to occupied tiles, but each such visit would cost about
  6–9 times more, and the motion-safe (empty-ring) rule frees only 5–7 % of visits. So it is probably not a
  quality lever at equal compute either. That is an inference, not a measurement: no reallocation was run. See
  [Caveats](#caveats).

## Setup

- `qc_eval` built from main `277aa527` and from this branch with `--features diagnostics`. The branch adds
  `--tile-visits` (diagnostics builds only), which writes:
  - `tile_visits.tsv`: one row per visit made by `SlowLoop::step`, with the frame, tile, Discover or settle, work
    units, wall ns, add proposals, proposals past the held-out pre-test, adds and absorbs;
  - `tiles.tsv`: tile cores and patches;
  - `fov.tsv`: the FOV mask's covered fraction and bounding box.
- **Identity**, on `v3_motion_s5` at the same flags, checked with `cmp_runs.py` against main:
  - Branch with default features (logging compiled out): all 22 files are identical after masking wall-time fields,
    `stdout.log` included. Only `run.json` (its wall time) and `time.txt` differ.
  - Branch with diagnostics and `--tile-visits` on: every qc_eval output file shared with main (19) is identical
    after masking wall-time fields. Three files differ:
    - `run.json`: the args;
    - `time.txt`: time and RSS;
    - `stdout.log`: timing, plus the diagnostics build's own timer line (`per_cell_ns` and `cluster_ns`, which read 0
      without diagnostics).

    So the measured runs are the standard runs.
- **Sims:** `run_arms.py --arms v3_static,v3_motion --seeds 5-9 -- --batch 8 --budget 30000000 --slow-seed 1`
  (the reproduce line of `2026-11-27-ff-motion-gain.md`; `--motion` on the motion arm). This schedule is
  bound by the work budget, not by a visit cap.
- **Workshop recording** (`prerecorded/raw`, 600 × 600, 23,711 frames, read-only), `qc_eval real --motion`:
  - `std`: the same flags, `--slow-seed` 1 and 2;
  - `fixed`: the fixed-rate arm (the app's Discover schedule without the concurrent settle,
    `--csettle 0.667 --csettle-mode frames`), `--budget 249600000 --visit-rate fixed --batch 8 --passes 1 --joint-update all
--joint-sign all --lookback 2 --merge-guard-sep 0.6 --lookback-drain 0`, seed 1. Here the visit count binds
    (0.15 visits/frame). It has no Final settle, because the settle does not change Discover's visits.
- **Hosts.** A tile hosts a cell when a cell centre lies in its 64 px core. On the sims:
  - `matched`: detectable GT units matched by a final cell (qc_eval's own matching, `final.tsv` `best_gt`);
  - `det`: every detectable GT unit;
  - `final`: final cell centres.

  On real data only `final` is available. **Empty+ring** means the core and all 8 grid neighbours host none.
  Neighbours that do not exist (outside the FOV) count as empty.

- Only Discover visits are counted (scope can add cells); the drain and settle visits are excluded. Time is each
  visit's wall time, with two runs at once on one machine, so the deterministic **work** share is given beside it.
  The two agree to within about 1 point.

## Workshop recording

| run      | cells | Discover visits | tiles | empty cores | empty+ring | visits % empty | time % empty | work % empty | visits % empty+ring | time % empty+ring | work % empty+ring |
| -------- | ----: | --------------: | ----: | ----------: | ---------: | -------------: | -----------: | -----------: | ------------------: | ----------------: | ----------------: |
| std s1   |   886 |           4,263 |    84 |          30 |          5 |           41.3 |          9.6 |          8.8 |                 6.7 |               1.5 |               1.4 |
| std s2   |   904 |           4,016 |    84 |          28 |          4 |           38.7 |          8.4 |          7.5 |                 5.3 |               1.1 |               1.0 |
| fixed s1 |   834 |           3,549 |    84 |          30 |          4 |           41.6 |          8.0 |          6.9 |                 5.2 |               1.0 |               0.9 |

What the visits on empty cores do:

| run      | visits on empty / occupied | ms per visit, empty / occupied | proposals on empty (past pre-test) | adds on empty / occupied |
| -------- | -------------------------- | ------------------------------ | ---------------------------------- | ------------------------ |
| std s1   | 1,762 / 2,501              | 9.8 / 65.5                     | 2,935 (2,862)                      | 0 / 993                  |
| std s2   | 1,552 / 2,464              | 9.7 / 66.2                     | 2,460 (2,412)                      | 0 / 1,025                |
| fixed s1 | 1,476 / 2,073              | 11.5 / 94.0                    | 2,882 (2,807)                      | 1 / 964                  |

Share of Discover visit time on empty cores / empty+ring, % per tenth of the recording:

| run             |   0–10 |  10–20 |  20–30 | 30–40 | 40–50 | 50–60 | 60–70 | 70–80 | 80–90 | 90–100 |
| --------------- | -----: | -----: | -----: | ----: | ----: | ----: | ----: | ----: | ----: | -----: |
| std (mean of 2) | 16 / 2 | 13 / 2 | 11 / 2 | 9 / 1 | 8 / 1 | 7 / 1 | 7 / 1 | 6 / 1 | 6 / 1 |  5 / 1 |
| fixed           | 26 / 4 | 16 / 2 | 12 / 1 | 9 / 1 | 8 / 1 | 7 / 1 | 6 / 1 | 6 / 1 | 6 / 1 |  5 / 1 |

- The empty share is largest in the first tenth (16–26 % of time on empty cores, 2–4 % with the ring). It falls as
  the occupied tiles fill with cells and their visits get dearer. So "late in the run, visits are wasted on empty
  tiles" does not hold in time. In count, the empty-core share of visits stays at 37–46 % in every tenth, because tiles
  come due on reservoir-slot turnover, whatever they hold.
- Almost every proposal on an empty core passes the pre-test (97–98 %), and the add test then rejects all of them.
  The pre-test does not discriminate there. That is cheap today, about 10 ms per visit in all. If proposals ever get
  dearer, they are the place to look, not the schedule.

## v3 sims (seeds 5–9, mean and 95 % t interval)

| arm       | hosts   | tiles | empty cores | empty+ring | visits % empty |   time % empty | visits % empty+ring | time % empty+ring |
| --------- | ------- | ----: | ----------: | ---------: | -------------: | -------------: | ------------------: | ----------------: |
| v3_static | matched |    98 |         3.0 |          0 | 3.6 [0.7, 6.5] | 0.9 [0.1, 1.7] |                   0 |                 0 |
| v3_motion | matched |    97 |         2.6 |          0 | 3.3 [0.8, 5.9] | 0.9 [0.0, 1.8] |                   0 |                 0 |

- `det` and `final` give the same numbers to 0.1 point. The sims place about 760 detectable cells evenly over
  the FOV, so the only cell-free tiles are partial tiles at the FOV edge, and no tile has an empty ring. The sims
  cannot test this idea. They only confirm that the logging agrees with the definitions. The workshop recording
  decides.
- Over all 10 runs there are 10 adds on `matched`-empty tiles: false cells, or cells whose GT centre sits just over
  a core boundary.

## FOV coverage of the local real recordings (secondary)

`qc_eval real <rec> --motion --fps 30 --frames 300 --tile-visits` (warm-up only matters; inputs read-only):

| recording              | FOV covered | bounding box rows × cols | box % of sensor |
| ---------------------- | ----------: | ------------------------ | --------------: |
| Samara 10_30_46        |      78.8 % | 20–599 × 0–599           |            96.7 |
| Samara 10_31_33        |      78.8 % | 21–599 × 0–599           |            96.5 |
| Samara 10_43_21        |      78.6 % | 21–599 × 0–599           |            96.5 |
| Samara 10_55_21        |      78.2 % | 22–599 × 0–599           |            96.3 |
| Samara 11_07_13        |      79.0 % | 20–599 × 0–599           |            96.7 |
| Samara 11_11_39        |      78.2 % | 28–599 × 0–599           |            95.3 |
| Samara 14_17_59        |      77.9 % | 20–595 × 0–599           |            96.0 |
| Samara 14_30_33        |      79.8 % | 18–599 × 0–599           |            97.0 |
| Samara 14_44_22        |      77.3 % | 22–593 × 0–599           |            95.3 |
| Samara 14_57_02        |      78.1 % | 20–594 × 0–599           |            95.8 |
| workshop               |      78.8 % | 13–599 × 30–599          |            92.9 |
| GRINiscope (320 × 320) |      49.7 % | 0–312 × 0–241            |            74.0 |

These are all the uncompressed recordings on this machine (`~/Downloads/Samara Data`, the workshop data,
`~/Downloads/GRINiscope`). `~/Downloads/CSHL Mouse V4` is FFV1-compressed, which qc_eval's AVI reader rejects; it was
not measured. On the 600 px recordings the lit disk fills the sensor, and the unlit area sits in the corners,
outside any box, so a crop saves 3–7 %. On the GRINiscope recording a crop saves 26 % of per-pixel work. That is
the small-GRIN case §6.5 described. It is worth building once the lab says how common such recordings are. `fov.tsv` (`--tile-visits`) measures that in a
few seconds per recording.

## Caveats

- **The decision rule is in time, and time is what a speed change can win.** In count, Discover's fixed-rate cap
  spends about 40 % of its visits on empty cores. Moving those visits to occupied tiles at the same count would
  cost about 6–9 times more per visit, so it would be a recall experiment at higher compute, not a free lever. The
  motion-safe version frees only 5–7 % of visits. Not run here.
- Real data has no truth: "never hosts a cell" means "no final cell centre in the core". Tiles holding cells that
  cala misses count as empty, so the empty share is an upper bound for "truly cell-free". That makes the verdict
  conservative.
- The workshop has 2 std seeds and 1 fixed-rate run; the three agree to within 3 points on every share (1.6 points in time).
- Wall time comes from two runs at once on one machine; the work-unit share agrees with it.
- Hooked visits are those of `SlowLoop::step` only. Visits run as jobs (`--via-jobs`, `--visit-workers` on the
  virtual clock, the app's visit workers) are not recorded. They follow the same `next_tile` order, but their
  per-visit times were not measured here.
- qc_eval runs the workshop recording at its default 20 fps (as earlier qc_eval workshop runs did).

## Reproduce

```bash
# builds (in crates/cala): main and branch
cargo build --release --example qc_eval                          # main 277aa527
cargo build --release --example qc_eval --features diagnostics   # this branch
# runs: ~/Projects/cala-data/runs/tile-visits/scripts/runs.sh (sims via run_arms.py, workshop, FOV)
python tools/cala-eval/cmp_runs.py <runs>/qc/main/v3_motion_s5 <runs>/qc/tv/v3_motion_s5
python tools/cala-eval/tile_visits.py <runs>/qc/tv/* --md
python tools/cala-eval/tile_visits.py <runs>/ws/std_s1 <runs>/ws/std_s2 <runs>/ws/app_s1 --md   # app_s1 = the fixed arm
python tools/cala-eval/tile_visits.py <runs>/ws/* --per-tile   # one row per tile
```
