# PR H: the smart floor and the default speed (22 Nov 2026)

Plan and pass lines: [2026-11-22-floor-eval-plan.md](2026-11-22-floor-eval-plan.md). It was committed before any run
(`43b87579`, amended `d07905aa` and `614567f4`, the trim). The arm speeds were committed after the Max runs and before
any paced run (`b4b0b50a`, [targets](2026-11-22-floor-eval-targets.txt)).

**Measured build:** `b4b0b50a` = `main` `8a39a648` (#474) plus eval files only. `main` has since moved: Auto speed,
Refine removed, look-back on by default, Extract after Discover. None of that is in these numbers.

## Summary for the PI

1. **Recommendation:** keep Max as the default for now. Offer `seeAllFps` ("every frame seen") as the recommended
   slower position.
   - The pre-set rule lands on its "mixed" branch (D3). That branch picks `seeAllFps` as the fastest arm worse than
     the others on no proxy.
   - I do not make it the default yet, for two reasons:
     - On the sims, the floor adds false cells.
     - `seeAllFps` itself was not run on the sims (trimmed).
   - A two-run sim check of `seeAllFps` would settle it.
2. **Slower is a little better in one respect only:**
   - **Residual structure is lower.** `residual_excess` falls from 0.590 at Max to 0.558 at the floor (margin 0.011).
     It is lower at every paced speed.
   - **Held-out reconstruction is flat.** 0.0139 at Max; 0.0141 at `seeAllFps`; 0.0135 at the floor, just past the
     noise margin on the low side.
   - **Neighbour cross-talk and common-cell held-out z are flat** within run-to-run noise.
   - **Repeatability is the same** (0.991-0.994 median cosine).
3. **More cells, mostly weak.**
   - Paced runs end with 355-376 cells against 313-323 at Max on Samara. The cells beyond the common set have a median
     held-out z of 1.0-1.4 against 1.5-2.3 at Max.
   - On the sims, the floor finds more true cells on the motion sim (recall 0.927 to 0.949). It also roughly doubles
     the false cells (motion sim 66-89 to 124-132; static sim 7-11 to 19-22). Precision drops beyond noise on both
     sims (0.90 to 0.85; 0.98 to 0.97).
   - Footprint accuracy against truth is unchanged (median r 0.990 / 0.992 at both speeds).
4. **The floor estimate shown after a Max run is too high, by one ladder step.**
   - On Samara it said 80 fps. At 80 the Background settle reached a dose of 1.75 (not 2), and need-driven look-back
     got 93 % of what it got at 56 fps. At 56 fps (0.7x) everything was served. So the real floor is between 56 and
     80, about 60.
   - The estimate a paced run shows (60) is right.
   - The cause is the slow-worker term measured at Max. It reads about 1.75x the paced value even after
     `unpacedFactor` 0.75 (Samara 121-129 against 68-74 fps). The factor that fits is about 0.43 (sims 0.53-0.55).
5. **Time (Samara 10_43_21, Discover + Final settle):**

   | Max | `seeAllFps` | 1.4x floor | floor | 0.7x floor |
   | --- | --- | --- | --- | --- |
   | 147 s | 242 s | 261 s | 328 s | 425 s |

## What ran

- Headed Chrome (Metal GPU), port 5198, one run at a time, `memory-measure.mjs --single --headed --every 5 --lookback
  [--pacefps F]`. Load at start 3.5-6.1.
- 19 runs, all exit 0. Every paced run had cap 2 and the settle pool (S = 1). Every run had a full Final settle.
- **Arms (rule R1).**
  - Samara `sa`: floor 80, 1.4x 112, 0.7x 56, `seeAllFps` 129.
  - Sims `m5` (v3 motion s5) and `t6` (v3 static s6): floor 60 and 30.
- **Trimmed (parent, for budget):** workshop and `14_57_02` dropped; sims at Max and floor only.
- **Scoring.** Each final library was scored with a fixed-library `qc_eval` (`floor_eval_score.sh`).
  - The machine hibernated from 16:30 to 21:09 during the scoring. Scoring wall times are not used.
- **Validation.**
  - V1: a 1 px shift lowers the held-out score and median z on all three recordings (sa 0.0139 to 0.0135; m5 0.1260
    to 0.1208; t6 0.1042 to 0.0987). The alignment holds.
  - V2: seed 2 against seed 1 changes Q1 by under 0.00002 on `sa`.

## H1-H3: the floor

Samara, per run (Discover's last frame):

| arm | fps | dose (cap 2) | need frames per birth | slow-loop drops | visit busy |
| --- | ---: | --- | --- | --- | --- |
| Max | 313-336 | 0 | 18-19 | 22-25 % | 0.48-0.54 |
| `seeAllFps` | 124-127 | 0.59-0.81 | 48-55 | 0 % | 0.60-0.66 |
| 1.4x floor | 110 | 1.12-1.14 | 58 | 0 % | 0.61-0.62 |
| floor | 79 | 1.74-1.76 | 75-79 | 0 % | 0.60-0.62 |
| 0.7x floor | 55 | 1.94 | 82-86 | 0 % | 0.62-0.63 |

- **H1 fails on Samara.** At the floor, Background settle (1.75 < 1.8) and need-driven look-back (77 < 95 % of 84) are
  not quite served. At 1.4x floor both are clearly not served, as intended.
- **H2 fails as written.** Going from the floor to 0.7x still adds dose (+11 %) and need frames (+9 %), because the
  floor was set one step high. Quality does not improve beyond noise from floor to 0.7x.
- **H3.**
  - Measured floor: between 56 and 80.
  - Estimate after a Max run: 80, one ladder step high, which is within the pass line.
  - Paced estimate: 60 (raw 66-72), right.
  - `seeAllFps` was right: 0 frames missed at 124-127 fps.
- **Sims.** At the floor, every consumer is served: dose 1.84-1.95, 0 drops.
  - On `m5`, the paced estimate (50) is below the Max-run estimate (60).
  - On `t6`, the paced estimate (40) is above it (30).
- **`unpacedFactor` 0.75 does not hold.** The slow-worker term at Max reads 1.33-1.75x its paced value. The factors that
  would fit: about 0.43 on Samara, 0.53-0.55 on the sims.
- **Visits (`visitsBind`).**
  - Idle at the floor on Samara and the motion sim (busy 0.60-0.63).
  - Not idle on the static sim (0.87). Its visit term (17-22 fps) was below the 30 fps target, so visits can bind
    there.
- **Priors** (20 / 30) were below every measured floor, the conservative side.

## Quality

Samara, mean of runs. The margin is the largest run-to-run spread within an arm.

| proxy | Max | `seeAllFps` | 1.4x | floor | 0.7x | margin | floor against Max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Q1 held-out reconstruction (higher) | 0.01393 | 0.01407 | 0.01380 | 0.01349 | 0.01392 | 0.00041 | worse, by 0.00004 beyond the margin |
| Q2 common-cell held-out z (higher) | 8.26 | 7.95 | 8.37 | 7.51 | 7.34 | 2.2 | level |
| Q3 residual excess (lower) | 0.590 | 0.567 | 0.568 | 0.558 | 0.561 | 0.011 | **better** |
| Q4 neighbour cross-talk (lower) | 0.070 | 0.062 | 0.060 | 0.066 | 0.063 | 0.009 | level |
| Q5 repeatability, cosine / matched share | 0.992 / 0.88 | 0.993 / 0.92 | 0.993 / 0.91 | 0.993 / 0.91 | 0.994 / 0.91 | | level, slightly higher share |
| cells (common + other) | 239 + 79 | 236 + 122 | 239 + 117 | 239 + 131 | 241 + 128 | | +50 |
| median footprint px | 527 | 573 | 588 | 597 | 605 | | +13 % |

- Some trace pairs overflowed in Q4's correlation (warning), so Q4 is approximate.
- The cells beyond the common set have a median held-out z of 1.0-1.4 when paced, against 1.5-2.3 at Max.

Sims: truth (T) and proxies, Max against floor (two runs each).

| | `m5` Max | `m5` floor | `t6` Max | `t6` floor |
| --- | --- | --- | --- | --- |
| T1 precision | 0.915 / 0.888 | 0.854 / 0.843 | 0.985 / 0.980 | 0.966 / 0.971 |
| T2 recall | 0.933 / 0.921 | 0.953 / 0.945 | 0.944 / 0.951 | 0.948 / 0.951 |
| T3 footprint r | 0.990 / 0.990 | 0.990 / 0.990 | 0.992 / 0.992 | 0.992 / 0.992 |
| T4 trace r | 0.978 / 0.979 | 0.976 / 0.977 | 0.980 / 0.980 | 0.981 / 0.980 |
| T5 false cells | 66 / 89 | 124 / 132 | 7 / 11 | 22 / 19 |
| Q1 held-out | 0.1260 / 0.1262 | 0.1265 / 0.1262 | 0.1042 / 0.1039 | 0.1035 / 0.1038 |
| Q3 residual excess | 0.823 / 0.818 | 0.791 / 0.788 | 0.226 / 0.225 | 0.221 / 0.222 |

On the sims, too, the floor lowers the residual. It also adds false cells (precision lower beyond noise on both
sims). Recall rises beyond noise on `m5` only. T4 is slightly lower on `m5`, a composition effect of the extra
matched cells.

## Reading against the pre-set rule

- **D1 (slower pays) is not met.** The floor is better beyond the margin on 1 of Q1-Q4 (Q3), not 2. The sims are worse
  on T1.
- **D2 is not met.** Q3 is better.
- **D3 (mixed).** The fastest arm worse than the others beyond the margin on no proxy is `seeAllFps`: Q1 is the
  highest, Q3 within the margin of the best, Q4 is low.
- Not covered by the rule: `seeAllFps` was not run on the sims, and the floor's sim result is a precision loss.
- Hence the summary: `seeAllFps` is the rule's pick for a recommended slower position. Max stays the default until a
  sim check of `seeAllFps` shows its extra cells are not mostly false.
- All of this rests on one real recording (two runs per arm) and two sims, so it is provisional.

## Follow-ups (not done)

1. Set `unpacedFactor` to about 0.45-0.55, or prefer the paced estimate once one exists. The Max-run floor is one step
   high.
2. Visits can bind on a dense static recording (`t6`). Consider `visitsBind`.
3. Run `seeAllFps` x2 on the two sims (about 15 min) before choosing it as the default.
4. Remeasure on current `main` (look-back on by default, no Refine, Auto).

Files: run data `~/Projects/cala-data/runs/floor-eval/` (`runs.md`, `quality.json`, `load.txt`, `score/`); scripts
`tools/cala-eval/floor_eval*.{sh,py}`.
