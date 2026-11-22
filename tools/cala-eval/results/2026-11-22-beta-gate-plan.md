# Beta gate plan: can look-back Discover + Final settle replace Discover + Refine? (22 Nov 2026)

Written and committed before any measured run. The smoke run below came first and is not used for any verdict.

## The question

Can look-back Discover followed by its Final settle replace Discover then Refine as the default for recordings?

- **New path:** `main` (`6a579e05`) opened with `?lookback`. Discover with look-back, then the Final settle (#447).
  Background settle off, no pacing (Max), no governor, default look-back pool.
- **Old path:** v2.20.0's default. Discover, then one Refine pass (one press of Refine).

## Which build is "old"

The old path is built from the `v2.20.0` tag in its own worktree (`~/Projects/CaLab-wt-v2200`, `898b6e73`, own
`npm install` and `build:wasm`). It is **not** `main` with `?lookback` off: 62 files in `crates/` and `apps/cala/src`
differ between the tag and `main`. Some of those changes touch the plain path too:

- #426: the cluster replay runs in visit jobs;
- #458: footprint history is thinned;
- #460: smooth playback.

Identity was not cheap to prove, so the tag is used.

Both builds are served by vite on port 5198, one at a time. The run script swaps them by its own PID. Both arms are
driven by `main`'s `apps/cala/scripts/memory-measure.mjs`, patched on this branch:

- A plain `--single` run now saves the library at the end of Discover (`-live.json`) and after Refine (`-final.json`).
- The in-page 100 ms probe records when Refine starts and ends, so both arms are timed on the same clock.

## Data and runs

| recording            | path                                                                        | frames |
| -------------------- | --------------------------------------------------------------------------- | ------ |
| `sa` Samara 10_43_21 | `~/Downloads/Samara Data/10_43_21` (read-only)                              | 17,879 |
| `sb` Samara 14_57_02 | `~/Downloads/Samara Data/14_57_02` (read-only)                              | 17,875 |
| `ws` workshop        | `~/Projects/workshop-processing-and-analysis/data/sessions/prerecorded/raw` | 23,711 |

- Per recording: **3 old runs** and **2 new runs**, headed Chrome with the Metal GPU, `--single --headed --every 5`
  (new: `--lookback`).
- The brief asked for 2 old runs. A third old run (about 10 minutes in total) is **added beyond the brief**, so the
  old path's run-to-run spread has three pairs instead of one.
- Order, interleaved per recording: `old-1, new-1, old-2, new-2, old-3`, recordings `sa`, `sb`, `ws`.
- One run at a time, after the guard `while pgrep -f "^node .*memory-measure.mjs"`. Load average, head SHA and the
  qc_eval process count are logged for every run in `load.txt`.
- No qc_eval run of mine during the Chrome runs. Runs from other agents cannot be stopped; they are logged.
- Output: `~/Projects/cala-data/runs/beta-gate/`. Tables: `tools/cala-eval/beta_gate_summary.py`.
- Chrome `--single` runs make no export, so nothing is written into the data folders.

**Smoke (not used):** `smoke/sa-old-0`, v2.20.0 on `sa`. Discover 53.4 s, Refine 76.8 s, 325 cells, no page errors.
This matches the 19 Nov "off" row (56 s + 82 s, 332 cells). Main's driver works against the v2.20.0 page: missing
hooks are optional-chained.

## Measures and pass lines

**Matching:** one-to-one, greedy by footprint cosine, centroids within 12 px, a match at cosine ≥ 0.7. This is the same
rule as #454 and #464.

**Single pairs only (the #464 post-hoc amendment):** every cosine is between one cell of one run and its match in one
other run. Nothing is averaged before the median is taken.

### A. Footprints of repeatable cells (deciding)

Notation: old runs `Oa` and `Ob`, new run `Nk`.

- For every ordered pair of distinct old runs (`Oa`, `Ob`) and every new run `Nk`, take the cells of `Oa` that are
  matched in both `Ob` and `Nk`.
- For each such cell, the per-cell paired difference is `d = cos(Nk, Oa) − cos(Ob, Oa)`.
- There are 6 × 2 = 12 combinations per recording. They are pooled.

**Margins come from the old path's own spread.** The three old-old pairs give three medians and three 10th
percentiles. The spread of each is max − min.

| line | measure                                                                    | passes if                                            |
| ---- | -------------------------------------------------------------------------- | ---------------------------------------------------- |
| A1   | median of `d`                                                              | ≥ −max(spread of the old-old medians, 0.002)         |
| A2   | 10th percentile of the new-side cosines minus that of the old-side cosines | ≥ −max(spread of the old-old 10th percentiles, 0.01) |

**The floors** (0.002 and 0.01) apply when three old runs happen to agree more closely than the method can resolve.

- 0.002 is two thirds of #464's L2 margin (0.003), so this gate is not looser than the last one.
- 0.01 for the tail: #464's like-for-like 10th percentiles moved by 0.013–0.021 between Max and paced runs of the
  same path.

Also reported: the share of cells that are lower on the new side.

### B. Missing and extra cells

**B1, missing (deciding).** The share of an old run's cells that are not found:

- by another old run: mean over the 6 ordered old-old pairs;
- by a new run: mean over the 3 × 2 old-new pairs.

Passes if (new − old) ≤ max(spread of the six old-old shares, 2 percentage points). The 2-point floor is the
resolution of about 300 cells at one run per arm (about 6 cells).

**Extra (reported, not deciding).** The share of a run's cells that the anchor old run does not have: new runs against
old-old. The PI has said more cells is neither better nor worse.

**Repeatable cells (reported).** Cells found by all three old runs:

- the share of them each new run has;
- against the leave-one-out figure: of the cells two old runs share, the share the third has.

**Cell counts (reported).**

### C. Wall time (deciding)

- Old total = Discover (first frame → last frame) + Refine (start → done). The 0–5 s wait for the driver's click is
  excluded.
- New total = first frame → settled library (frames done + Final settle).

C1 passes if new mean − old mean ≤ max(range of the three old totals, 5 % of the old mean). 5 % is about 7 s on
Samara, a little more than one 5 s sample.

### D. Peak memory (deciding)

The largest renderer footprint or RSS over the 5 s samples (as in #447). The GPU process is reported apart.

D1 passes if new mean − old mean ≤ max(range of the three old peaks, 10 % of the old mean), and no new run reaches 6 GB.
10 % is the sample-timing and GC scatter seen between repeated runs in #447 and #464.

### E. Errors (deciding)

E1 passes if every run has:

- no `pageerror` or crash;
- `STOP done`;
- `LOOKBACK_CHECK PASS` (new runs);
- driver exit 0.

Frames dropped for the slow loop are reported per run.

## Verdict rule (fixed now)

| verdict            | when                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GO**             | A1, A2, B1, C1, D1 and E1 pass on all three recordings.                                                                                             |
| **CONDITIONAL GO** | A1, A2, B1 and E1 pass on all three, and only C1 and/or D1 fail. The PI decides whether the extra time or memory is acceptable. The size is stated. |
| **NO-GO**          | A1, A2, B1 or E1 fails on any recording.                                                                                                            |

## Known priors (not used to shape the lines)

- #447 (19 Nov, n = 1): the settle took 5–20 % longer than Refine (workshop 309 s against 269 s; Samara 143–149 s
  against 132–137 s).
- #447: the look-back path had fewer cells: workshop 756 against 831 (−9 %), Samara −2 % and −7 %. This was
  attributed to the cluster replay in Discover.
- #464 Chrome (Max, the new path): Max-vs-Max shared 89 % and 87 % of cells. The old-old figure here is the matching
  reference.
- The code changed after #447: #454–#463, with defaults unchanged. #458 (history thinning) and #460 (smooth playback)
  run on both arms of `main`.

## Sims anchor

Not run. qc_eval's visit model failed its calibration against Chrome at full speed (#456, #461, C1), and qc_eval
cannot run the v2.20.0 code. The ground-truth anchors are the existing sims results:

- #439 and #443: settle = COMBO + Refine on 14 sims;
- #430: COMBO against DR-main, full tier;
- #447: the drain adds nothing once the settle follows.

The results file cites them. It does not rerun them.
