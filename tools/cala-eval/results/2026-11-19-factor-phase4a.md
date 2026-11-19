# Factor pipeline, phase 4a: what a live run may claim from Discover's factors

Spec: `docs/superpowers/specs/2026-11-17-cala-factor-pipeline-design.md` (Amendment 1, A4; Amendment 2, A9 and A11). Plan: `docs/superpowers/plans/2026-11-19-cala-factor-phase4a.md`.
Commit: `qc_eval` built at 66789daa (harness source last changed at baeed65c); tools (`factor_arms.py`, `factor_closeness.py`) of the same branch, `feat/cala-factor-extract`. Machine: Apple M1 Max, 10 cores, 32 GB. Runs of 19 Nov 2026. Data: the run folder `factor_phase4a_20261119`.

A live stream cannot replay its raw file. Its factors are therefore the ones Discover writes while it runs (600-frame windows of preprocessed frames, stored low-rank), not the recalibrated factors of phase 1. Phase 1's recalibrated factors passed gate A1 on the same six recordings; what differs is the calibration with which the factors were written (inferred: no arm isolates it). This phase asks what a live run may claim from Discover's own factors. Three things were measured with gate A1 (rules on the QC-pass cells; a QC-pass cell is a cell of the reference run that passes the quality check): Discover's factors alone (arm `live`); the same with a flat field map from an earlier stretch or session (`seed`, arms `raw_seed` and `live_seed`); and main's look-back, which re-reads past frames during Discover, reading the factors instead of the raw file (arms `lb_raw`, `lb_fac`, `lb_live`).

Gate A1's rules, as in phase 1: 1 truth correlation (median change at least -0.01, 5th percentile at least -0.05, where the truth is usable); 2 footprint loss at most 0.02; 3 trace loss at most 0.08 (where the truth is not usable); 4 footprint jump at tile lines at most the reference's plus 0.10. A loss is 1 minus the median of a measure over the QC-pass cells. A QC-pass cell that has no partner in the test run counts as the worst case in every rule ("lost").

## What a live run may claim

Every verdict below is read from a gate recomputed from the run files. The recomputation equals the tool's own tables in all 20 comparisons, and an independent numpy computation of rules 1 to 3 equals the tool's values. A pass is a result for this recording in this bounded run (first 12000 or 6000 frames, a tenth of the slow-loop budget, one run per arm), not a claim for recordings in general.

| comparison                                                                 | recording                                  | gate    | failing rule: value (limit)        | lost QC-pass (reverse) | note                                                                                                             |
| -------------------------------------------------------------------------- | ------------------------------------------ | ------- | ---------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `live` vs `raw`                                                            | `wl200`                                    | pass    | none                               | 0                      | rule 1 over 22 cells; trace loss 0.1100 not applied (would fail rule 3)                                          |
| `live` vs `raw`                                                            | `wl24_01`                                  | fail    | 2: 0.0325 (0.02); 3: 0.1550 (0.08) | 0                      |                                                                                                                  |
| `live` vs `raw`                                                            | `wl24_04`                                  | fail    | 2: 0.0349 (0.02); 3: 0.2032 (0.08) | 0                      |                                                                                                                  |
| `live` vs `raw`                                                            | `plain`                                    | pass    | none                               | 0                      |                                                                                                                  |
| `live` vs `raw`                                                            | `v4`                                       | pass    | none                               | 0                      |                                                                                                                  |
| `live` vs `raw`                                                            | `motion`                                   | fail    | 2: 0.0223 (0.02)                   | 0                      | rule 3 0.0303 passes                                                                                             |
| `live_seed` vs `raw_seed`, seed from a later stretch of the same recording | `wl24_01`                                  | fail    | 2: 0.0638 (0.02); 3: 0.1855 (0.08) | 0                      | seed map has 16 percent of its pixels at the clip limits; its dark level is 60.7 against 35.5                    |
| same                                                                       | `v4`                                       | pass    | none                               | 0                      | unseeded already passes                                                                                          |
| same                                                                       | `wl24_04`                                  | not run |                                    |                        | seed stretch made no map: "skipped: too little motion: 1 shift bins with >= 25 new frames, need 2"               |
| `live_seed` vs `raw_seed`, seed from another session (**extra**)           | `wl24_04`, seed `wl24_01` (3 days earlier) | pass    | none                               | 0                      | one recording; the app's direction                                                                               |
| same (**extra**)                                                           | `wl24_01`, seed `wl24_04` (3 days later)   | fail    | 2: 0.0523 (0.02); 3: 0.1903 (0.08) | 0                      | not the app's direction                                                                                          |
| `lb_fac` vs `lb_raw`                                                       | `wl200`                                    | fail    | 1: 5th percentile -0.0702 (-0.05)  | 2 (0)                  | a lost cell (-0.837) and a paired cell (-0.075) are the two lowest changes; the 5th percentile sits between them |
| `lb_fac` vs `lb_raw`                                                       | `plain`                                    | pass    | none                               | 7 (6)                  | 5 of the 7 lost carry truth; 2 more would fail rule 1                                                            |
| `lb_fac` vs `lb_raw`                                                       | `motion`                                   | pass    | none                               | 11 (10)                | rule 1 off (no usable truth): medians only; rule 2 headroom 0.0017                                               |
| `lb_live` vs `lb_raw`                                                      | `wl200`                                    | pass    | none                               | 2 (0)                  | trace loss 0.1121 not applied (would fail rule 3); 5th percentile -0.0382                                        |
| `lb_live` vs `lb_raw`                                                      | `plain`                                    | pass    | none                               | 7 (6)                  | 5th percentile -0.0406 (limit -0.05)                                                                             |
| `lb_live` vs `lb_raw`                                                      | `motion`                                   | pass    | none                               | 11 (10)                | rule 1 off; trace loss 0.0577                                                                                    |

Lost = QC-pass cells of the reference with no partner in the test arm. Reverse = QC-pass cells of the test arm with no partner in the reference; the test arm's QC flags come from its own `cells.tsv`, read as the tool reads the reference's (a cell missing from `cells.tsv` counts as QC-pass), and a partner is a cell paired by footprint. Comparisons by id have no lost cells by construction (shown as 0, no reverse). On `plain` and `motion` the loss is close to a swap: about as many cells of the factor arm have no partner in the file arm as the other way.

Nothing may be claimed as within gate A1 for the two real WL24 wireless recordings with Discover's factors without recalibration; a seed from another session helped once, on one recording (a seed from three days earlier), and not on the other (a seed from three days later). These arms measure Discover's factors read by the harness, not a stream: Discover itself runs on raw frames; the refine replays of `live` and `live_seed` read the raw file for the preprocessor's running state, the warp and the missing-pixel mask (the factors are Discover's own, written by no replay); `lb_fac`'s Extract replays the raw file once; only `lb_live` reads no raw after Discover. Gate A1 caps lost cells nowhere (see "Gate A1 under pairing").

Decision: open, for the owner.

The owner must decide or confirm:

- **Setup identity.** Per the dataset notes, both WL24 sessions are Miniscope Zero, mouse WL24, with the same pipeline. Not confirmed by anything: the same scope unit, field of view and optical path (a flat field carries illumination and optics, not only the sensor). The cross-session seed results depend on it.
- **A true earlier session.** The seeded comparisons used a later stretch of the same recording, or another session three days earlier (the app's direction; one pass) or three days later (one fail). Whether that is close enough to the app's use case.
- **Live factors without recalibration on the WL24 setup.** `live` fails gate A1 on both real WL24 wireless recordings (trace loss 0.1550 and 0.2032 against 0.08), where the recalibrated factors of phase 1 had 0.0441 and 0.0487. That is two recordings of one setup; the only other real recording, `v4`, is another setup and passes. Whether to claim live factors for this setup at all, or only with a seed.
- **A lost-cell rule for gate A1 under pairing** (a proposal, see "Gate A1 under pairing"). Whether to add it.

## Gate A1, live factors

`live` is gate A1 of the arm `live` against the file pipeline `raw` on the same recording (same Discover; cells compared by id). `live_seed` is judged against `raw_seed`, not against `raw`: the seed changes Discover, so `raw` has other cells. Tile-line jumps use lines every 32 px (the two offset grids), as in phase 1.

| recording | comparison                     | QC-pass cells (lost) | 1 truth: median, 5th pct                            | 2 footprint loss | 3 trace loss           | 4 jump, test / reference | gate |
| --------- | ------------------------------ | -------------------- | --------------------------------------------------- | ---------------- | ---------------------- | ------------------------ | ---- |
| `wl200`   | `live` against `raw`           | 63 (0)               | +0.0194, -0.0265 (22 cells): pass                   | 0.0047: pass     | 0.1100: does not apply | 0.985 / 0.976: pass      | pass |
| `wl24_01` | `live` against `raw`           | 58 (0)               | no truth: does not apply                            | 0.0325: fail     | 0.1550: fail           | 1.013 / 0.995: pass      | fail |
| `wl24_04` | `live` against `raw`           | 40 (0)               | no truth: does not apply                            | 0.0349: fail     | 0.2032: fail           | 1.083 / 1.049: pass      | fail |
| `plain`   | `live` against `raw`           | 142 (0)              | +0.0040, -0.0051 (135 cells): pass                  | 0.0004: pass     | 0.0038: does not apply | 0.976 / 0.962: pass      | pass |
| `v4`      | `live` against `raw`           | 202 (0)              | no truth: does not apply                            | 0.0082: pass     | 0.0070: pass           | 0.927 / 0.929: pass      | pass |
| `motion`  | `live` against `raw`           | 178 (0)              | not usable (92 cells, median 0.403): does not apply | 0.0223: fail     | 0.0303: pass           | 0.932 / 0.897: pass      | fail |
| `wl24_01` | `live_seed` against `raw_seed` | 53 (0)               | no truth: does not apply                            | 0.0638: fail     | 0.1855: fail           | 1.071 / 1.009: pass      | fail |
| `v4`      | `live_seed` against `raw_seed` | 197 (0)              | no truth: does not apply                            | 0.0054: pass     | 0.0061: pass           | 0.964 / 0.963: pass      | pass |

On `wl200` the pass rests on rule 1 over 22 cells (median change +0.0194, 5th percentile -0.0265). Rule 3 does not apply there because the truth is usable; its trace loss 0.1100 would fail it (limit 0.08) and is close to the values of the failing real recordings (0.1550 and 0.2032). Phase 1's `chosen` had 0.1039 there.

Beside phase 1's recalibrated factors on the same recordings (`chosen`, from the phase 1 report). What differs is the calibration with which the factors were written (inferred: no arm isolates it):

| recording | trace loss `live` | `live_seed` | `chosen` | footprint loss `live` | `live_seed` | `chosen` |
| --------- | ----------------- | ----------- | -------- | --------------------- | ----------- | -------- |
| `wl200`   | 0.1100            | -           | 0.1039   | 0.0047                | -           | 0.0052   |
| `wl24_01` | 0.1550            | 0.1855      | 0.0441   | 0.0325                | 0.0638      | 0.0086   |
| `wl24_04` | 0.2032            | -           | 0.0487   | 0.0349                | -           | 0.0072   |
| `plain`   | 0.0038            | -           | 0.0015   | 0.0004                | -           | 0.0000   |
| `v4`      | 0.0070            | 0.0061      | 0.0010   | 0.0082                | 0.0054      | 0.0000   |
| `motion`  | 0.0303            | -           | 0.0009   | 0.0223                | -           | 0.0006   |

`chosen` passed gate A1 on all six recordings. The gap is largest on the two real WL24 wireless recordings, in the trace loss: `wl24_01` 0.1550 against 0.0441, on `wl24_04` 0.2032 against 0.0487; footprint loss on `motion` 0.0223 against 0.0006. `live_seed` is judged against another reference than `live` and `chosen`, so its column is only indicative.

## The flat field seed

The app would give a live stream a flat field map from an earlier session of the same device (the seed), so that Discover's first frames are already flat-fielded. The harness reads the map a finished run left (`--ff-seed-run`): its gain map, column offsets, dark level and frame count of the last map. The seed runs are a later stretch of the same recording (`--from F`, the first 12000 frames of it at 200 px, 6000 at 600 px). The seed comes from the same recording, from a stretch that lies 10 to 20 minutes into it at 200 px and 5 to 10 at 600 px (at 20 fps). The two cross-session extras (below) use another session of the same mouse and scope model. The three synthetic sets got no seed: they never get a flat field map.

**The two cross-session extras (beyond the plan).** `wl24_04` was seeded with the whole-run flat field map of `wl24_01`'s `raw` arm (a session three days earlier: the app's direction), and `wl24_01` with `wl24_04`'s map (three days later: not the app's case). What the dataset notes say: each session's `README.md` is titled "Miniscope Zero, mouse WL24" (both titles, with their own dates), and both say "Same scope and pipeline as `WL25_20251204` / `WL27_20251205`" (other datasets, "a third mouse"). So: same scope model, mouse and pipeline per the dataset notes. **Not confirmed by anything: the same scope unit, field of view and optical path** (a flat field carries illumination and optics, not only the sensor).

| recording | seed stretch from frame           | its first map          | the seed (its last map)                 | seed gain sd | seed dark | seed residual | maps made |
| --------- | --------------------------------- | ---------------------- | --------------------------------------- | ------------ | --------- | ------------- | --------- |
| `wl24_01` | 12000 (12000 frames, not shorter) | 2 bins, gain sd 0.1056 | frame 11399, 10 bins, 10778 frames used | 0.2183       | 60.7      | 1.5e-02       | 8         |
| `wl24_04` | 12000 (12000 frames)              | none                   | -                                       | -            | -         | -             | 0         |
| `v4`      | 6000 (6000 frames, not shorter)   | 8 bins, gain sd 0.0595 | frame 5399, 12 bins, 4658 frames used   | 0.0599       | 1.7       | 3.0e-05       | 3         |

`wl24_04`: the seed stretch made no flat field map (0 updates in 12000 frames), so `raw_seed` and `live_seed` were not run there. The seed run's own record says why: "skipped: too little motion: 1 shift bins with >= 25 new frames, need 2". Open: why that stretch has so little motion; the same recording's first 12000 frames made 8 maps.

**Why the `wl24_01` same-recording seed did not help: the evidence.** The first map of the seed run came from 2 motion bins; the map used as the seed is its last, from 10 bins.

- **Clipped pixels.** 8.3 and 7.8 percent of the seed map's pixels sit at the clip limits 0.8 and 1.25 (16.1 percent together); the other maps checked have 0.6 to 1.5 percent together.
- **Drift inside the seed stretch.** Over its maps 4 to 6 the gain sd rose 0.115, 0.167, 0.206, the residual 2.3e-04, 4.9e-03, 8.6e-03 and the tissue sd 0.06, 0.10, 0.15. Against the recording's own last map: gain sd 0.076, residual 2.8e-04. Inferred: an illumination change, or tissue leaking into the map.
- **A healthy map fails too.** `wl24_01` seeded with the last map of `wl24_04`'s own run (gain sd 0.075, 1.3 percent clipped) also fails gate A1. So a poor map cannot be the whole reason.
- **Dark level, an untested candidate.** The dark level of the seed is applied from frame 0. The gap between the seed's dark level and the target run's own first map comes in the same order as the outcomes:

| case                      | dark of the seed | dark of the target's first map | gap  | `live_seed` gate |
| ------------------------- | ---------------- | ------------------------------ | ---- | ---------------- |
| `wl24_01`, same recording | 60.7             | 35.5                           | 25.2 | fail             |
| `wl24_01`, seed `wl24_04` | 57.5             | 35.5                           | 21.9 | fail             |
| `wl24_04`, seed `wl24_01` | 50.0             | 40.1                           | 9.9  | pass             |
| `v4`, same recording      | 1.7              | 1.5                            | 0.3  | pass             |

This is n = 4 and confounded (the gap, the map's quality and the session change together). It is a candidate to test, not the cause.

First map of each run, and how far it was from the map before it (`change p99`, in sigma, as the harness logs it; for an unseeded run the map before is the flat start, inferred):

| recording | arm                | seed                             | bins | frames used | gain sd | dark | change p99 (sigma) |
| --------- | ------------------ | -------------------------------- | ---- | ----------- | ------- | ---- | ------------------ |
| `wl24_01` | `raw`              | -                                | 5    | 2497        | 0.0720  | 35.5 | 0.60               |
| `wl24_01` | `raw_seed`         | same recording                   | 8    | 2645        | 0.0772  | 35.5 | 0.88               |
| `wl24_04` | `raw`              | -                                | 4    | 2744        | 0.0645  | 40.1 | 0.66               |
| `v4`      | `raw`              | -                                | 7    | 2391        | 0.0595  | 1.5  | 3.73               |
| `v4`      | `raw_seed`         | same recording                   | 7    | 2327        | 0.0590  | 1.5  | 1.81               |
| `wl24_04` | `raw_seed` (extra) | `wl24_01` raw map, other session | 8    | 2602        | 0.0638  | 40.1 | 0.30               |
| `wl24_01` | `raw_seed` (extra) | `wl24_04` raw map, other session | 8    | 2477        | 0.0721  | 35.5 | 0.64               |

`live` and `live_seed` share their Discover with `raw` and `raw_seed` up to the first map, so their lines are the same. The seeded first map of `wl24_01` moved further from its seed (0.88 sigma) than the unseeded one moved from the flat start (0.60): a seed that is far from the run's own map. The cross-session seed of `wl24_04` was close (0.30 sigma); that of `wl24_01` was as far as the unseeded start (0.64 against 0.60). On `v4` the same-recording seed was nearer than the flat start (1.81 against 3.73 sigma).

### Gate A1 with a seed, and how much of the gap it closes

| recording | comparison                                                      | QC-pass cells (lost) | 1 truth: median, 5th pct | 2 footprint loss | 3 trace loss | 4 jump, test / reference | gate |
| --------- | --------------------------------------------------------------- | -------------------- | ------------------------ | ---------------- | ------------ | ------------------------ | ---- |
| `wl24_01` | `live_seed` against `raw_seed`                                  | 53 (0)               | no truth: does not apply | 0.0638: fail     | 0.1855: fail | 1.071 / 1.009: pass      | fail |
| `v4`      | `live_seed` against `raw_seed`                                  | 197 (0)              | no truth: does not apply | 0.0054: pass     | 0.0061: pass | 0.964 / 0.963: pass      | pass |
| `wl24_04` | `live_seed` against `raw_seed`                                  | not run              | -                        | -                | -            | -                        | -    |
| `wl24_04` | **extra**: `live_seed` (seed from `wl24_01`) against `raw_seed` | 39 (0)               | no truth: does not apply | 0.0116: pass     | 0.0609: pass | 1.032 / 1.016: pass      | pass |
| `wl24_01` | **extra**: `live_seed` (seed from `wl24_04`) against `raw_seed` | 62 (0)               | no truth: does not apply | 0.0523: fail     | 0.1903: fail | 1.059 / 1.057: pass      | fail |

The two extras were compared with the same tool and 32 px lines. Their own `.md` files in the run folder used the tool's default 64 px lines for the jump of the `live_seed` pairs (1.207 / 1.179 and 1.082 / 1.140); rules 1 to 3 are the same and rule 4 passes with either for these pairs.

| recording | seed                  | trace loss `live` / seeded / `chosen` | share of the gap closed | footprint loss `live` / seeded / `chosen` | share of the gap closed | seeded gate |
| --------- | --------------------- | ------------------------------------- | ----------------------- | ----------------------------------------- | ----------------------- | ----------- |
| `wl24_01` | same recording        | 0.1550 / 0.1855 / 0.0441              | -27 percent             | 0.0325 / 0.0638 / 0.0086                  | -131 percent            | fail        |
| `v4`      | same recording        | 0.0070 / 0.0061 / 0.0010              | 15 percent              | 0.0082 / 0.0054 / 0.0000                  | 34 percent              | pass        |
| `wl24_04` | extra: from `wl24_01` | 0.2032 / 0.0609 / 0.0487              | 92 percent              | 0.0349 / 0.0116 / 0.0072                  | 84 percent              | pass        |
| `wl24_01` | extra: from `wl24_04` | 0.1550 / 0.1903 / 0.0441              | -32 percent             | 0.0325 / 0.0523 / 0.0086                  | -83 percent             | fail        |

The share is (`live` minus seeded) over (`live` minus `chosen`). The seeded loss is measured against `raw_seed`, `live` and `chosen` against `raw`, so the share is indicative only. A negative share means the seeded arm is worse than `live`. The two extras are one recording per direction: the 92 and 84 percent on `wl24_04` are one pass on one recording, with a seed from three days earlier (the app's direction) from a session that is the same mouse and scope model per the dataset notes; whether it is the same scope unit, field of view and optical path is not confirmed. The other direction (seed from three days later, not the app's case) failed.

Seeded Discover against unseeded Discover (`raw_seed` against `raw`, cells paired by footprint; **not a gate**, it shows what the seed alone changes in the file pipeline):

| recording | seed                     | pairs | QC-pass cells (lost, reverse) | footprint loss | trace loss | jump, test / reference (64 px) | A1 rules, if it were a gate |
| --------- | ------------------------ | ----- | ----------------------------- | -------------- | ---------- | ------------------------------ | --------------------------- |
| `wl24_01` | same recording           | 84    | 58 (4, reverse 3)             | 0.0532         | 0.0586     | 1.097 / 1.150                  | fail                        |
| `v4`      | same recording           | 165   | 202 (46, reverse 43)          | 0.0282         | 0.0068     | 0.938 / 0.895                  | fail                        |
| `wl24_04` | **extra**: other session | 56    | 40 (2, reverse 4)             | 0.0272         | 0.0280     | 1.179 / 1.071                  | fail                        |
| `wl24_01` | **extra**: other session | 87    | 58 (4, reverse 6)             | 0.0292         | 0.0349     | 1.140 / 1.150                  | fail                        |

A seed changes Discover's cells: on `v4` 46 of 202 QC-pass cells have no partner after a seed that is near the run's own map. The comparison of `live_seed` with `raw_seed` removes this by using the seeded file run as its reference.

## Look-back on factors

Main's look-back re-reads past frames during Discover. In `lb_raw` it reads them from the raw file. In `lb_fac` its cursor reads the factor windows written by Discover itself (`--lookback-source factors`, the two offset grids). The factor source marks as missing only the pixels that were never valid in their window (taken from the factor file); nothing is preprocessed, warped or masked again. `lb_live` is `lb_fac` plus Extract on the factors. The arms run Discover with main's joint flags on, one pass. The three Discovers differ, so cells are paired by footprint (cosine at least 0.5, centroids at most 20 px apart, one to one, greedy); a QC-pass reference cell without a partner counts as lost. `lb_fac` against `lb_raw` measures two things together: the factor source, and a delay. Blocks of look-back frames wait until their 600-frame window is written, so a newborn cell gets its most recent frames up to about one window later than in `lb_raw` (inferred from the code, as the whole-phase review read it). No arm separates the two: a raw-source arm with the same availability rule does not exist.

| measure                                                                          | `wl200` `lb_fac`                  | `wl200` `lb_live`                 | `plain` `lb_fac`                   | `plain` `lb_live`                  | `motion` `lb_fac`                                   | `motion` `lb_live`                                  |
| -------------------------------------------------------------------------------- | --------------------------------- | --------------------------------- | ---------------------------------- | ---------------------------------- | --------------------------------------------------- | --------------------------------------------------- |
| pairs (reference cells)                                                          | 67 (71)                           | 67 (71)                           | 178 (192)                          | 178 (192)                          | 242 (258)                                           | 242 (258)                                           |
| QC-pass cells (lost)                                                             | 61 (2)                            | 61 (2)                            | 139 (7)                            | 139 (7)                            | 160 (11)                                            | 160 (11)                                            |
| 1 truth: median, 5th pct                                                         | -0.0007, -0.0702 (23 cells): fail | +0.0098, -0.0382 (23 cells): pass | -0.0000, -0.0279 (134 cells): pass | +0.0036, -0.0406 (134 cells): pass | not usable (91 cells, median 0.416): does not apply | not usable (91 cells, median 0.416): does not apply |
| 2 footprint loss                                                                 | 0.0114: pass                      | 0.0114: pass                      | 0.0011: pass                       | 0.0011: pass                       | 0.0183: pass                                        | 0.0183: pass                                        |
| 3 trace loss                                                                     | 0.0009: does not apply            | 0.1121: does not apply            | 0.0001: does not apply             | 0.0042: does not apply             | 0.0022: pass                                        | 0.0577: pass                                        |
| 4 jump, test / reference                                                         | 1.035 / 1.001: pass               | 1.035 / 1.001: pass               | 0.964 / 0.943: pass                | 0.964 / 0.943: pass                | 0.928 / 0.940: pass                                 | 0.928 / 0.940: pass                                 |
| gate A1                                                                          | fail                              | pass                              | pass                               | pass                               | pass                                                | pass                                                |
| paired cells alone: footprint loss                                               | 0.0106                            | 0.0106                            | 0.0009                             | 0.0009                             | 0.0149                                              | 0.0149                                              |
| paired cells alone: trace loss                                                   | 0.0009                            | 0.1110                            | 0.0000                             | 0.0038                             | 0.0015                                              | 0.0399                                              |
| truth correlation, median: `lb_raw` / arm                                        | 0.837 / 0.794                     | 0.837 / 0.908                     | 0.968 / 0.971                      | 0.968 / 0.982                      | 0.473 / 0.481                                       | 0.473 / 0.622                                       |
| truth correlation, arm minus `lb_raw`: median, 5th pct (cells)                   | -0.0004, -0.0233 (25)             | +0.0243, -0.0299 (25)             | +0.0000, -0.0122 (175)             | +0.0069, -0.0074 (175)             | +0.0014, -0.0568 (145)                              | +0.1060, -0.0895 (145)                              |
| truth footprint correlation, median: `lb_raw` / arm                              | 0.857 / 0.855                     | 0.857 / 0.855                     | 0.986 / 0.985                      | 0.986 / 0.985                      | 0.942 / 0.953                                       | 0.942 / 0.953                                       |
| truth footprint correlation, difference, all cells: median, 5th pct (cells)      | +0.0008, -0.0182 (25)             | +0.0008, -0.0182 (25)             | +0.0000, -0.0478 (175)             | +0.0000, -0.0478 (175)             | +0.0000, -0.0995 (145)                              | +0.0000, -0.0995 (145)                              |
| truth footprint correlation, difference, cells whose truth unit overlaps another | +0.0013, -0.0214 (20)             | +0.0013, -0.0214 (20)             | +0.0002, -0.1101 (17)              | +0.0002, -0.1101 (17)              | -0.0127, -0.3138 (16)                               | -0.0127, -0.3138 (16)                               |
| look-back frames: `lb_raw` / arm                                                 | 24698 / 20733                     | 24698 / 20733                     | 16445 / 15979                      | 16445 / 15979                      | 16708 / 16346                                       | 16708 / 16346                                       |
| cell-frames: `lb_raw` / arm                                                      | 286826 / 266422                   | 286826 / 266422                   | 487990 / 492557                    | 487990 / 492557                    | 829380 / 837540                                     | 829380 / 837540                                     |
| cells still in need: arm                                                         | 0                                 | 0                                 | 0                                  | 0                                  | 0                                                   | 0                                                   |
| look-back wall s: `lb_raw` / arm (see the note below)                            | 41.8 / 11.2                       | 41.8 / 8.6                        | 178.9 / 50.1                       | 178.9 / 54.5                       | 184.0 / 58.8                                        | 184.0 / 55.8                                        |
| window files read                                                                | 31                                | 31                                | 29                                 | 29                                 | 33                                                  | 33                                                  |

Truth correlation lines are over cells with a truth unit within 6 px after the frame offset, paired cells only; the truth footprint lines measure both footprints against the truth unit of the reference cell (like for like). Truth on `motion` is not usable for rule 1 (median 0.416 on QC-pass cells), so rule 3 applies there; the 5th percentiles of its truth lines are not rule values (rule 1 does not apply, and would fail on them).

- `wl200`: the factor source served 20733 look-back frames against 24698 of the raw source (-16.1 percent) and 266422 cell-frames against 286826 (-7.1 percent); no cells were left in need in either.
- `plain`: the factor source served 15979 look-back frames against 16445 of the raw source (-2.8 percent) and 492557 cell-frames against 487990 (+0.9 percent); no cells were left in need in either.
- `motion`: the factor source served 16346 look-back frames against 16708 of the raw source (-2.2 percent) and 837540 cell-frames against 829380 (+1.0 percent); no cells were left in need in either.

The factor source served fewer look-back frames than the raw source on all three recordings (blocks wait for their window; idle budget is not banked; inferred), as the lines above give. The look-back wall seconds of `lb_fac` and `lb_live` leave out the compression of pass 1, which sits in the stage times, and ran under up to five processes (see Run times): they are not a speed-up. Cell-frames, which are what the slow loop spends, differ less. `wl200`: 20 windows written, 31 window files read, `plain`: 10 windows written, 29 window files read, `motion`: 10 windows written, 33 window files read (a window is read again when the cursor returns to it; inferred from reads exceeding windows).

`lb_fac` and `lb_live` have the same Discover: their `footprints.bin` are the same bytes on all three recordings (yes), so rules 2 and 4 and the footprint truth lines are equal; only the traces (Extract) differ. `lb_live`'s Extract builds its projectors from the factors, and its traces change more against the file run (trace loss 0.1121 on `wl200`) than `lb_fac`'s (0.0009), while their truth correlation is higher (median change +0.0243 against -0.0004). The trace loss measures change from the file run, not error.

### Lost cells and the gate

The look-back arms on `plain` and `motion` pass gate A1 although 7 and 11 QC-pass reference cells were lost. How the gate counts a lost cell (`a1_gate`, `a1_value`, `a1_loss` in `factor_closeness.py`): a lost cell takes the value 0 in every rule (truth correlation 0 in the test run, so its change is minus its reference correlation; footprint cosine 0 and trace correlation 0, so a loss of 1). The rules then take a median (rules 1 to 3) or a 5th percentile (rule 1) over the QC-pass cells. I recomputed rules 1 to 3 from the per-cell rows with plain numpy and got the tool's values for all comparisons.

| arm                | QC-pass cells (lost) | lost cells with a truth unit, of cells with truth | rule 1 as the gate counts it: median, 5th pct | rule 1 over paired cells alone | rule 2: gate / paired alone | rule 3: gate / paired alone | gate A1 |
| ------------------ | -------------------- | ------------------------------------------------- | --------------------------------------------- | ------------------------------ | --------------------------- | --------------------------- | ------- |
| `wl200` `lb_fac`   | 61 (2)               | 1 of 23                                           | -0.0007, -0.0702                              | -0.0006, -0.0251               | 0.0114 / 0.0106             | 0.0009 / 0.0009             | fail    |
| `wl200` `lb_live`  | 61 (2)               | 1 of 23                                           | +0.0098, -0.0382                              | +0.0117, -0.0309               | 0.0114 / 0.0106             | 0.1121 / 0.1110             | pass    |
| `plain` `lb_fac`   | 139 (7)              | 5 of 134                                          | -0.0000, -0.0279                              | +0.0000, -0.0064               | 0.0011 / 0.0009             | 0.0001 / 0.0000             | pass    |
| `plain` `lb_live`  | 139 (7)              | 5 of 134                                          | +0.0036, -0.0406                              | +0.0038, -0.0088               | 0.0011 / 0.0009             | 0.0042 / 0.0038             | pass    |
| `motion` `lb_fac`  | 160 (11)             | 4 of 91                                           | -0.0002, -0.2128; does not apply, would fail  | +0.0004, -0.0552               | 0.0183 / 0.0149             | 0.0022 / 0.0015             | pass    |
| `motion` `lb_live` | 160 (11)             | 4 of 91                                           | +0.1153, -0.2064; does not apply, would fail  | +0.1180, -0.0701               | 0.0183 / 0.0149             | 0.0577 / 0.0399             | pass    |

- **The verdicts follow from the rules.** Medians barely move when a few cells are lost: on `plain` the footprint loss is 0.0011 with the 7 lost cells counted and 0.0009 without. Rule 1's 5th percentile moves when the lost cells with a truth unit reach about 5 percent of the cells with truth: on `plain` 5 of 134 (3.7 percent) moved it from -0.0064 to -0.0279, still above -0.05, so rule 1 passes.
- **`wl200` `lb_fac` fails rule 1 on its lowest two cells, one lost and one paired.** The lowest changes among the 23 cells with truth are -0.8371 (a lost cell, reference truth correlation 0.837), -0.0751 (a paired cell), -0.0257 and -0.0136. The 5th percentile of 22 to 23 cells is about the second-lowest value: -0.0702 with the lost cell counted, -0.0251 over the 22 paired cells. The verdict flips on one cell either way, and `lb_live` (-0.0382, passes) is as marginal.
- **`motion` has no rule that bounds lost cells.** Its truth is not usable, so rule 1 does not apply, and rules 2 and 3 are medians: 11 of 160 QC-pass cells (6.9 percent) are lost, the footprint loss is 0.0183 against 0.02 (0.0149 over paired cells alone), so the headroom is 0.0017. This is a property of the gate, not a defect of the tool's verdict.

### Gate A1 under pairing

The gate's wording is "a lost cell is the worst case in every rule". That is true per cell; in effect each rule tolerates a different share of lost cells. Read from `a1_gate`, with the numbers below from a synthetic sweep in which the lost cells take the worst value and every other cell is perfect (idealised):

- **Rule 1 (truth).** Only lost cells with a truth unit enter, each as minus its reference correlation. The median ignores them; the 5th percentile tolerates about 5 percent of the cells with truth: at most 1 lost of 22, 1 of 23, 6 of 134 and 8 of 160 pass.
- **Rules 2 and 3 (median loss).** A lost cell counts as loss 1, but the median passes while just under half of the QC-pass cells are lost: at most 30 of 61, 69 of 139 and 79 of 160.
- **Rule 4 (tile lines).** Lost cells do not enter.
- **The swap.** Under pairing, a lost cell of the file arm has a mirror image: QC-pass cells of the factor arm with no partner in the file arm. `plain`: 7 lost and 6 reverse; `motion`: 11 and 10; `wl200`: 2 and 0. On `plain` and `motion` the loss is close to a swap, not a one-sided loss.
- **The ruling behind "worst case"** was made for comparisons by id, where no cell is lost. It does not carry over to pairing.

**Proposal for the owner (not adopted; the gate was not changed in this phase).** Add a rule 5 for paired comparisons: the share of QC-pass reference cells without a partner is at most the reverse share (test cells without a reference partner) plus 2 percentage points; with usable truth, also: truth units recovered with correlation at least 0.8 in the test run are at least those in the reference run minus max(1, 2 percent).

## How it was measured

`tools/cala-eval/factor_arms.py` ran `qc_eval` once per arm and recording, from `run_4a_200.sh` and `run_4a_600.sh` in the run folder (logs `run_200.log`, `run_600.log`). Every arm ended with return code 0 (checked: 28 `run.json` files).

- **Build.** `qc_eval` copied to the run folder, built at 66789daa (harness source last changed at baeed65c). The identity check and the smoke run used it. The tools are those of the branch at the phase's task commits (`factor_arms.py` 0b35f729, `factor_closeness.py` f0190a5c). The tables of this report were recomputed from the files with the tools of the checkout at the time of writing; the tool's own `report.md` files agree with them.
- **Scale, as in phases 0 and 1.** 200 px recordings (`wl200`, `wl24_01`, `wl24_04`): first 12000 frames, 5 refine replays. 600 px recordings (`plain`, `v4`, `motion`): first 6000 frames, 2 refine replays. Slow-loop budget 3,000,000 work units per frame (a tenth of `qc_eval`'s default), 2 jobs per recording.
- **Recordings.** `wl24_01` and `wl24_04` (real wireless, 200 px, sessions of 1 and 4 Dec 2025, from the folder names), `v4` (real, 600 px), `wl200`, `plain`, `motion` (synthetic with truth).
- **Arms** (flags of each arm's command, after the common `--motion --frames N --budget U`):

  - `raw`: `--passes 6 --later-passes refine --extract-pass`
  - `live`: `--passes 6 --later-passes refine --extract-pass --replay-source factors --tiling offset --extract-engine factors --factors-out <arm>/factors`
  - `seed`: `--passes 1 --from 12000`
  - `raw_seed`: `--passes 6 --later-passes refine --extract-pass --ff-seed-run <recording>/seed`
  - `live_seed`: `--passes 6 --later-passes refine --extract-pass --replay-source factors --tiling offset --extract-engine factors --ff-seed-run <recording>/seed --factors-out <arm>/factors`
  - `lb_raw`: `--passes 1 --joint-update all --joint-sign all --lookback 2 --lookback-drain 4800 --extract-pass`
  - `lb_fac`: `--passes 1 --joint-update all --joint-sign all --lookback 2 --lookback-drain 4800 --extract-pass --lookback-source factors --tiling offset --factors-out <arm>/factors`
  - `lb_live`: `--passes 1 --joint-update all --joint-sign all --lookback 2 --lookback-drain 4800 --extract-pass --lookback-source factors --tiling offset --replay-source factors --extract-engine factors --factors-out <arm>/factors`

  `live`'s command does not set `--factors-pass`; the default is 1 (checked in `qc_eval.rs`): the refine replays read the factors of Discover's own pass. The extras' `raw_seed` and `live_seed` have the commands of those arms with the seed folder changed (`run_xseed.sh`, `run_xseed_wl24_01.sh`); they were not run through `factor_arms.py` and have logs, not `run.json`.

**What each arm still reads from the raw file after Discover.** Discover itself runs on raw frames in all arms.

- `live` and `live_seed`: the refine replays still read the raw file, for the preprocessor's running state, the warp and the missing-pixel mask. No factor comes from a replay: the factors are Discover's own. Extract runs on the factor engine.
- `lb_fac`: Discover's look-back reads the factor windows; Extract replays the raw file once.
- `lb_live`: Extract on the factors too. Only this arm reads no raw after Discover.
- Evidence, Extract's preparing time on `wl200`: `lb_raw` 14.12 s, `lb_fac` 13.94 s, `lb_live` 0.04 s (a raw read preprocesses frames; the factor engine builds projectors).

- **Identity check (the default paths are unchanged).** Two 1800-frame runs on `wl200` (`chosen` and the default look-back `lb_raw`, without the new flags) with the harness before this phase (built at b6990928) and with this phase's harness: 7 files compared, 7 with the same bytes (chosen/extract_trace.f32, lb_raw/extract_trace.f32, chosen/footprints.bin, lb_raw/footprints.bin, chosen/factors/w0000000.fac, chosen/factors/w0000600.fac, chosen/factors/w0001200.fac), 0 different. `lb_raw/lookback.tsv` differs in `wall_s` only (6.724 against 6.743 s). The check does not cover: the flat field update path (seeded or not: the 1800 frames made no map), runs without motion, the 600 px recordings, and the arms `raw`, the nulls, the tilings and `c_chosen`.
- **Smoke run.** The new flags on 1800 frames of `wl24_01` before the long runs: `lb_fac` read factors ("lookback source: factors, 3 window files read"), lookback: 4055 frames (2724 pushed, 42199 cell-frames, 36 births, 0 cells still in need), 3.3 s wall; the seed run `--from 1800 --frames 3600` printed "from frame 1800: 38434 frames" and made its first flat field map ("first map at frame 2999 (4 bins, gain sd 0.0803, change p99 0.56 sigma; 0.0 s)").
- **Run times.** The 200 px series ran 00:00 to 00:33 and the 600 px series 00:34 to 01:35 on 19 Nov; the two extras ran 00:34 to 00:49 and 00:49 to 01:05. Up to five harness processes ran at once for part of the night (the plan said four), and the extras overlapped the 600 px series, so **run times are not timing results**. They are in each `report.md` and in the table below.

| recording | wall seconds per arm                                     |
| --------- | -------------------------------------------------------- |
| `wl200`   | lb_fac 138, lb_live 98, lb_raw 139, live 335, raw 314    |
| `wl24_01` | live 463, live_seed 447, raw 431, raw_seed 424, seed 68  |
| `wl24_04` | live 370, raw 346, seed 75                               |
| `plain`   | lb_fac 373, lb_live 324, lb_raw 393, live 538, raw 454   |
| `v4`      | live 595, live_seed 573, raw 490, raw_seed 481, seed 166 |
| `motion`  | lb_fac 392, lb_live 309, lb_raw 400, live 520, raw 447   |

## What was not measured

- The refine replays of `live` and `live_seed` read the raw file for the preprocessor's running state and the missing-sample mask. A live run has neither. Phase 3 (Refine on factors) removes the replays; until then `live` measures Discover's factors read by the harness, not a stream.
- A seed from a true earlier session of the same scope unit. The seed runs use a later stretch of the same recording, and the two extras use another session of the same mouse and scope model (per the dataset notes) whose scope unit, field of view and optical path are not confirmed.
- A raw-source look-back arm with the same availability rule as the factor source (it would separate the factor source from the delay).
- Look-back on factors on the real recordings, with a seed, or with refine replays.
- The joint flags on the flat field arms (phase 3's gate checks the joint replay on and off).
- Live latency and a real-time stream: `--offered-fps` refuses `--replay-source factors`.
- Full-length recordings and the default slow-loop budget. Only the first 12000 or 6000 frames, a tenth of the budget.
- The browser: no app change in this phase.
- Main's demixing metrics (`demix_metrics.py`, `demix_report.py`): they need a minisim `oracle.bin`. The truth footprint correlation stands in for their footprint r.
- Run-to-run spread: no arm was repeated and the comparisons have no null runs, so a loss near a limit (for example the footprint loss 0.0183 of `motion`'s look-back against 0.02) is one draw.
- Why the seed stretch of `wl24_04` has so little motion, and whether the two WL24 sessions share a scope unit, field of view and optical path.

## Notes on the data

- **Seed run frames.** The seed runs' logs print: `wl24_01` "from frame 12000: 28234 frames"; `wl24_04` "from frame 12000: 27250 frames"; `v4` "from frame 6000: 17711 frames". Each run used its first 12000 (200 px) or 6000 (600 px) frames.
- **A correction to the first reading.** The overnight notes said the `wl24_01` same-recording seed came from 2 motion bins. That is the seed run's first map. The seed the harness reads is its last map (`read_seed_run` takes the last updated row): 10 bins, 10778 frames.
- **Extras' jump measure.** The extras' own `.md` files use 64 px lines for the jump; the table above uses 32.
- **`wl200` truth.** `live` raises the median truth correlation (0.843 to 0.905 over 25 cells) while its lag-1 trace loss against the file run is 0.1100: the factor engine's traces are not the frame engine's, and the file run's traces are not the truth. Rule 3 does not apply there for that reason.
