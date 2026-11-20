# qc_eval motion arms: ground truth in cala's registered frame

13 Nov 2026. Branch `fix/qc-eval-motion-offset` (from main a09d984). Scratch: `scratchpad/motion-offset`, which is not
in the repo. Found by the S2.4 M0 run (`2026-11-12-scales-m0.md` §6).

## Verdict

**The motion-arm scores were measuring a frame offset as well as cala.** qc_eval compared cala's footprints, which are
in cala's registered frame, with ground truth in the sim's tissue frame. On the motion sims the two frames are 1 to
3.3 px apart. The fix moves the ground truth into cala's frame before anything is scored.

- **6 px cells:** `size6_motion_s5` goes from P8/R8 .167/.176 to .891/.943. The motion arm now agrees with the static
  arm (`size6_static` .953/.943 over seeds 5–7).
- **10 and 14 px cells:** P8 and R8 change by less than .02. Matching at r ≥ 0.7 tolerates a 1–2 px offset. The
  matched r (`r_fp`) rises by .024 on average (.942 → .966 over `motion_s5`–`s9`; .940 → .976 on `v3_motion_s5`).
  Every absolute motion-arm `r_fp` reported before today is low by about that much.
- **No earlier conclusion flips.** The support-rule flip (#344/#358), the refine gate (#365/#367) and the #350 merge
  veto were all paired comparisons on the motion arms. They were rescored from their saved checkpoint footprints.
  No paired difference moves by more than .008, and every pass/fail stays the same (table below).
- **Static arms do not change.** `static_s5` is byte-identical to main except for the wall-time files and the new
  `unit` column of `gt.tsv`.

## Root cause

- `qc_eval`'s `Pipeline::new` builds the motion corrector's template from frames 0–199
  (`MotionCorrector::initialize`). The template is their mean, re-registered and re-averaged, so it shows the tissue
  wherever it sat in those frames.
- The default `TemplateStrategy::PinnedToWarmup` keeps that position for the whole run. Every registered frame is
  therefore the tissue moved by a fixed offset, about the mean true content shift over the warm-up. For
  `size6_motion_s5` the truth's warm-up mean is (−3.07, −0.76) px; the measured offset is (−3.11, −0.85) px.
- `build_gt` pushed the oracle footprints (tissue frame) straight into the GT library. Every GT comparison went
  through that library: matching, P/R, `fp_r`, the FP classes, crosstalk, `traces_gt.tsv` and the oracle library.
  Nothing removed the offset.
- An integer shift search, `best_offset`, had been in the file since #284 but was never called. It is removed.

## The fix

**Offset from what the sim and cala did.** A record `s` registers its frame onto the template
(`corrected(p) = frame(p − s)`), and the frame shows the tissue moved by the true content shift `m`. So the registered
frame is the tissue moved by `s_t + m_t`.

- That sum is constant up to registration error.
- `FrameOffset::estimate` takes its median per axis over frames `0..=--start` (51 frames). The robust sd measures the
  registration error.
- `m` is minisim's ground-truth `shifts`, exported to `<sim>/shifts.npy`:
  - `make_trace_sim.py` now writes it;
  - `export_gt_motion.py` backfilled every motion sim in `~/Projects/cala-data` (`sims`, `sims-gt110`, `sims-v3`).
- A `--motion` run with GT stops if the file is missing, unless `--gt-offset none` is given. No constant is tuned.

**Applying it.**

- Every oracle footprint (full and core) is moved by the offset with the bicubic (Keys) kernel, sub-pixel, before
  `build_gt`. Everything downstream therefore sees the moved GT.
- A moved unit's centre is the peak of its moved core inside the frame. This is `make_trace_sim.py`'s own
  definition.
  - A first version moved the old centre instead. That pushed 20 cells cut by the frame edge out of the GT on
    `v3_motion_s5`, while cala still sees their visible half (P8 −.009).
  - With the peak rule, edge cells are handled as in a static sim.

**Outputs.**

- `motion_offset.tsv`:
  - the applied estimate;
  - the whole-run estimate;
  - one estimate per 1200-frame block, as a constancy check;
  - the true shifts' own spread, for scale.
- `motion.tsv`: cala's rigid shift of every frame.
- `gt.tsv`: gains `unit`, the `oracle.bin` index. `fp_scales.py` and `recovery_vs_snr.py` use it instead of
  nearest-centroid mapping, which breaks once GT centroids move.

**Rescoring.** `qc_eval sim <sim> <out> --motion --rescore RUN` rescores an earlier `--churn-log` run without running
the loops.

- It re-registers frames 0–50 to get the offset. The records depend only on the video and the motion settings.
- It scores every checkpoint of `RUN/fp_history.bin` both ways and writes `rescore.tsv`.
- Its tissue-frame numbers reproduce the runs' own `global.tsv` exactly. For example, `f0_motion_s5` gives .9017/.7744
  both ways.

**Tests** (`cargo test`, qc_eval's unit tests now run):

- `translate_footprint` matches a blob rendered at the moved centre (r > .999, centroid within .02 px) for integer
  and sub-pixel shifts.
- `FrameOffset` recovers a (−3.07, 0.69) template position within .03 px from noisy records with outliers.
- 6 px cells offset by (−3.07, −0.76): matching at r ≥ 0.8 finds fewer than 10 % unaligned, and 100 % (r > .99) after
  alignment.

## Is the offset sub-pixel, and constant?

It is sub-pixel, and constant to a few tenths of a pixel. Per run:

| run               | applied (dy, dx) px | per-frame sd | whole run      | block range (dy, dx) |
| ----------------- | ------------------- | ------------ | -------------- | -------------------- |
| `size6_motion_s5` | (−3.11, −0.85)      | .18, .24     | (−3.28, −0.78) | .14, .07             |
| `v3_motion_s5`    | (−1.09, 0.71)       | .13, .24     | (−1.04, 0.70)  | .11, .08             |
| `motion_s5`       | (0.11, −1.49)       | .11, .14     | (0.10, −1.34)  | .06, .10             |
| `motion_s6`       | (−0.91, 0.16)       | .12, .16     | (−0.98, 0.23)  | .14, .05             |
| `motion_s7`       | (−1.08, −2.16)      | .23, .07     | (−1.03, −2.19) | .12, .13             |
| `motion_s8`       | (−0.15, −1.64)      | .16, .14     | (−0.21, −1.50) | .16, .14             |
| `motion_s9`       | (0.80, 1.40)        | .11, .15     | (0.83, 1.45)   | .22, .09             |

- Block range is the max minus the min of the eight 1200-frame block medians.
- The pinned template holds the offset to within .22 px over 8 minutes. The 51-frame estimate is within .17 px of the
  whole-run one.
- For a 6 px cell, a .17 px error costs r about .001 (`exp(−δ²/4σ²)`).
- Not modelled:
  - the non-rigid part of the template's position, which is the sim's patch field averaged over the warm-up (a few
    tenths of a px, varying over the field);
  - the oracle's footprints of cells cut by the sensor edge, which lack the part outside the sensor. Moved inward,
    they keep a hard edge.

  Both affect a few cells within 2 px of the frame edge. These are the remaining `tp` → `partial` moves on
  `v3_motion_s5`.

## Before and after (1×, `--batch 8 --budget 30000000 --slow-seed 1`, main a09d984 defaults)

- **Before:** main a09d984.
- **After:** the branch binary. Same flags, plus `--motion` on the motion arms.
- cala's output is identical: same cells and same `final.tsv`. Only the scoring differs.
- P8/R8 are at frame 9600 and P2/R2 at frame 2400. `r_fp` is the median matched footprint r. The `fp_*` columns are
  the FP class counts at frame 9600.

| run               | offset (dy, dx) | P8           | R8           | P2           | R2           | r_fp         | fp_dup  | fp_adjacent | fp_partial |
| ----------------- | --------------- | ------------ | ------------ | ------------ | ------------ | ------------ | ------- | ----------- | ---------- |
| `size6_motion_s5` | (−3.11, −0.85)  | .167 → .891  | .176 → .943  | .170 → .903  | .150 → .799  | .745 → .962  | 10 → 45 | 141 → 27    | 482 → 8    |
| `v3_motion_s5`    | (−1.09, 0.71)   | .911 → .908  | .927 → .924  | .938 → .939  | .807 → .809  | .940 → .976  | 20 → 14 | 38 → 41     | 10 → 15    |
| `motion_s5`       | (0.11, −1.49)   | .897 → .915  | .753 → .768  | .887 → .916  | .547 → .565  | .952 → .970  | 6 → 3   | 15 → 19     | 24 → 14    |
| `motion_s6`       | (−0.91, 0.16)   | .948 → .952  | .784 → .786  | .938 → .943  | .582 → .584  | .957 → .967  | 10 → 8  | 4 → 6       | 11 → 10    |
| `motion_s7`       | (−1.08, −2.16)  | .914 → .931  | .737 → .756  | .877 → .926  | .539 → .573  | .916 → .965  | 4 → 0   | 10 → 14     | 26 → 17    |
| `motion_s8`       | (−0.15, −1.64)  | .930 → .926  | .760 → .756  | .912 → .915  | .532 → .532  | .945 → .962  | 3 → 4   | 6 → 5       | 21 → 22    |
| `motion_s9`       | (0.80, 1.40)    | .935 → .947  | .774 → .780  | .887 → .899  | .550 → .555  | .940 → .964  | 8 → 3   | 11 → 12     | 12 → 11    |
| `motion_s5`–`s9`  | mean ± 95 % CI  | +.009 ± .012 | +.008 ± .012 | +.020 ± .024 | +.012 ± .018 | +.024 ± .019 |         |             |            |
| `static_s5`       | none            | .950 (same)  | .785 (same)  | .948 (same)  | .597 (same)  | .968 (same)  | 2       | 2           | 13         |

On `size6_motion_s5`, 482 "partial" FPs and 141 "adjacent" FPs before the fix were cells next to their own displaced
GT unit.

The oracle mode was affected too: its library is the GT. On `size6_motion_s5` over 600 frames, the explained variance
is .499 unaligned and .717 aligned, and the median trace r is .64 and .85.

## Earlier conclusions, rescored

The table gives the paired arm − control difference, mean ± 95 % t-CI over seeds 5–9 (n = 3 for #350 4×). Each is
shown in the tissue frame (as reported) and aligned. The rescorer reproduces the reported tissue-frame numbers exactly.

| eval                        | arm vs control        | metric | d tissue (reported) | d aligned    | gate    | result    |
| --------------------------- | --------------------- | ------ | ------------------- | ------------ | ------- | --------- |
| support rule 1× (#344/#358) | skirt vs rings        | P8     | −.011 ± .016        | −.014 ± .016 | ≥ −.02  | unchanged |
|                             |                       | R8     | +.018 ± .011        | +.016 ± .007 | ≥ −.02  | unchanged |
|                             |                       | R2     | +.024 ± .028        | +.020 ± .025 | ≥ −.05  | unchanged |
|                             |                       | r_fp   | −.002 ± .004        | −.000 ± .003 | ≥ −.010 | unchanged |
|                             | basin vs rings        | r_fp   | −.010 ± .002        | −.010 ± .003 | ≥ −.010 | unchanged |
| support rule 4×             | skirt vs rings        | P8     | −.028 ± .018        | −.029 ± .019 | —       | unchanged |
|                             |                       | R8     | −.007 ± .009        | −.007 ± .009 | —       | unchanged |
| refine gate 1× (#365/#367)  | split-half            | P8     | +.005 ± .018        | +.001 ± .023 | ≥ −.02  | unchanged |
|                             |                       | R8     | −.002 ± .016        | −.005 ± .015 | ≥ −.02  | unchanged |
|                             |                       | R2     | −.008 ± .012        | −.006 ± .014 | ≥ −.05  | unchanged |
|                             |                       | r_fp   | +.000 ± .001        | +.001 ± .001 | ≥ −.010 | unchanged |
| refine gate 4×              | split-half            | P8     | +.007 ± .014        | +.008 ± .017 | ≥ −.02  | unchanged |
|                             |                       | R8     | −.001 ± .005        | +.001 ± .011 | ≥ −.02  | unchanged |
| merge veto 1× (#350)        | `--merge-history 0.3` | P8     | −.008 ± .017        | −.006 ± .019 | —       | unchanged |
|                             |                       | R8     | +.002 ± .010        | +.004 ± .005 | —       | unchanged |
| merge veto 4×               | `--merge-history 0.3` | P8     | −.011 ± .032        | −.003 ± .047 | —       | unchanged |

- The "—" gates are reported differences with no pass/fail rule.
- Full table, with P2, R2 and `r_fp` for every evaluation: `scratchpad/motion-offset/pairs.md`.
- Absolute control levels on the v2 motion arm rise in every evaluation:
  - P8 by .004–.013 and R8 by .004–.010;
  - P2 and R2 by .01–.03;
  - `r_fp` by .023–.024.

**Why nothing flips.** The offset is a property of the sim and the motion corrector, so both arms of a pair carry the
same one. At 14 px it costs both arms about the same.

**What changes:**

- absolute motion-arm numbers, above all `r_fp`;
- any motion-arm result on small cells: the 6 px sweep in `2026-11-12-scales-m0.md` was switched to static arms for
  this reason, and can now use motion arms.

## Files

- Scratch:
  - `runs/{before,after}/<sim>/out` (`after_v1` is the first version, which moved the centres; superseded);
  - `rescore/<eval>/<arm>/motion_s<seed>/rescore.tsv`;
  - `pairs.md` and `ba.md`;
  - the scripts `runq.sh`, `rescore_all.sh`, `pairs.py` and `ba.py`.
- Reproduce a rescore:

  ```
  qc_eval sim $CALA_SIMS/motion_s5 <out> --motion --rescore <run>
  ```

  where `<run>` is a `--churn-log` run directory.
