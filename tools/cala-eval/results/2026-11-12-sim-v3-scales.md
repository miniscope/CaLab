# Sims at the real recording's cell size and blur (v3), and cell-size arms (12 Nov 2026)

The standard sims (`ca1_workshop_v2.spec.json`) have ground-truth footprints of 14.4 px
and about 3.8 px edge blur; the workshop recording's cala footprints are 9.8-10.2 px with
about 1.5 px edges (S2.4). v3 recalibrates the spec to the real values. Specs only, no
minisim change: `tools/minisim-calibration/make_v3_specs.py` writes
`ca1_workshop_v3.spec.json` (10 px), `ca1_workshop_v3_size6.spec.json` and
`ca1_workshop_v3_size16.spec.json`; every change and its reason is in that file and in
`tools/minisim-calibration/CALIBRATION.md` ("v3"). The v2 sims are unchanged and are the
fourth point (14.4 px).

## Statistic

Same as on the real data, on the detectable units of `oracle.bin` (`tools/cala-eval/gt_scales.py`):

- `d = 2 sqrt(A_half / pi)`, `A_half` = pixels at or above half the peak of the `full` footprint;
- edge sigma = `peak / (sqrt(2 pi) max |grad|)` (an upper bound on the blur: the object has its
  own edge). On the real recording this reads 1.65-1.9 px on cala's footprints, which carry
  1 px of cala smoothing (`d/10`); removing it in quadrature gives 1.4-1.6 px. The ground-truth
  footprints have no such smoothing, so the target for them is 1.4-1.6.

## Result (seeds 5-9, 480 s, 600 px; median over detectable units, mean over seeds, range in brackets)

| arm | d, px | edge sigma, px | detectable cells | units placed |
|---|---|---|---|---|
| real, cala footprints (S2.4: 3 runs) | 9.8-10.2 | 1.65-1.9 raw, about 1.5 after removing cala's smoothing | (700 cala cells) | |
| v2 static | 14.54 (14.41-14.67) | 3.86 (3.83-3.88) | 639 (635-642) | 666 |
| v2 motion | 14.44 (14.32-14.58) | 3.86 (3.82-3.90) | 679 (671-686) | 722 |
| **v3 static** | **10.16** (10.16-10.16) | **1.38** (1.37-1.39) | 649 (632-657) | 829 |
| **v3 motion** | **10.11** (10.09-10.16) | **1.37** (1.36-1.38) | 692 (666-711) | 902 |
| size6 static | 6.01 (5.97-6.08) | 1.36 (1.36-1.37) | 634 (618-650) | 799 |
| size6 motion | 5.99 (5.97-6.08) | 1.36 (1.35-1.38) | 674 (654-701) | 864 |
| size16 static | 15.94 (15.92-15.96) | 1.37 (1.35-1.38) | 677 (660-697) | 846 |
| size16 motion | 15.90 (15.84-15.96) | 1.36 (1.35-1.38) | 711 (680-745) | 923 |

Recovered footprints of cala on `static_s5` (`qc_eval`, below): median `d` 13.5 px on v2 and
9.5 px on v3, against 9.9 px on the real recording.

## What was held, what moved (static_s5; `tools/cala-eval/sim_stats.py`)

| property | v2 | v3 | size6 | size16 |
|---|---|---|---|---|
| mean grey over the recording (200 frames) | 64.5 | 63.3 | 73.1 | 72.9 |
| centre 200 x 200 px grey | 116 | 102 | 112 | 115 |
| detectable cells | 635 | 632 | 635 | 660 |
| peak-SNR proxy, median (relative, see below) | 2.91 | 3.50 | 3.03 | 3.59 |
| detectable per 3 x 3 grid cell, min / max | 0.70 | 0.51 | 0.52 | 0.51 |

- The SNR proxy is `footprint peak x (C p99.5 - median) / pixel noise` (MAD of frame
  differences) over the first 48 s, for the detectable units; a relative measure only.
- Held: frame size, pixel size, motion, vessels, illumination, neuropil field, activity, grey
  level (mean), detectable count per frame.
- Moved, on purpose: cell size, blur, cell depth layer and density (cells per volume, to keep
  the detectable count), flat focal field.
- Moved, as a cost: the peak-SNR proxy is 20 % above v2 on v3 (3.50 against 2.91), the centre of
  the mean image is 12 % darker on v3, detectable cells are less uniform over the frame (0.5
  against 0.7 min/max; the illumination falloff matters more once the PSF is sharp), and the
  edge sigma is 1.37 px (target 1.4-1.6). The size arms keep the v3 optics and differ only in
  cell size, with density and neuropil amplitude set to keep the detectable count and the mean grey.

## Why these parameters (short; details in `CALIBRATION.md`)

- v2's blur is the scatter blur (`scatter_blur_per_um` 0.05, sigma 9 um at the 180 um layer).
  Lowering it to 0.010 gives 1.4 px edges, but then the cells measure 6.9 px at v2's 5 um radius;
  the soma radius goes to 8.3 um for 10 px (4.6 um for 6 px, 13.1 um for 16 px).
- minisim's `detectable` is a point-source test that ignores cell size and collapses with defocus
  once the scatter blur is small. With v2's 2500 um field curvature the in-focus surface is a
  bowl, and detectable cells sat in a ring (13 in the centre of a 3 x 3 grid against 130 at the
  edges). v3 uses a flat field and a 16 um cell layer at the focal depth.
- The mean grey is mostly the neuropil haze and it, like the detectable count, depends on the
  recording length, so the final tuning was done on 480 s generations.
- Size by pixel pitch (S2.4's first idea) was not used: it rescales the vessels, neuropil
  field, motion and frame together and does not change the blur in pixels independently.

## Sanity check: `qc_eval` on `static_s5` (main 8a086ae, `--batch 8 --budget 30000000 --slow-seed 1`)

| | v2 `static_s5` | v3 `v3_static_s5` |
|---|---|---|
| ground truth loads (oracle.bin, `gt.tsv`) | yes | yes |
| GT detectable cells | 635 | 632 |
| cala cells at 9600 | 486 | 722 |
| P8 / R8 | 0.979 / 0.785 | 0.824 / 0.960 |
| P8x (non-detectable matches left out) | 0.979 | 0.982 |
| measured `d`: GT footprints / cala footprints, px | 14.45 / 13.49 | 10.16 / 9.51 |
| wall, peak RSS | 218 s, 0.98 GB | 218 s, 0.88 GB |

On v3 cala finds more cells than there are detectable ground-truth cells, and the
extra matches are cells minisim does not flag as detectable (P8 0.82 against P8x 0.98).
The `detectable` flag is stricter on v3 than on v2 for the reason above, so P8 reads low
on v3 by construction; use P8x or the flag-free counts when comparing the two. Seed 5 only.

## Files

- Sims: `~/Projects/cala-data/sims-v3/<arm>_s<seed>/`, arms `v3_static`, `v3_motion`,
  `size6_static`, `size6_motion`, `size16_static`, `size16_motion`, seeds 5-9 (30 recordings,
  3.4 GB each, 102 GB, 2.4-2.8 GB peak RSS to generate). `sims.env`: `SIMV3_<ARM>_S<seed>`.
- Regenerate: `$MINISIM_PY tools/cala-eval/gen_sims.py --sims ~/Projects/cala-data/sims-v3 --arms
  v3_static,v3_motion,size6_static,size6_motion,size16_static,size16_motion --seeds 5-9 --parallel 1`.
