# Bite refill: one-way leak from a wide cell into a small neighbour

18 Nov 2026. Branch `fix/cala-wide-neighbour-tail` (from main a26f48d9). `SlowLoopConfig::bite_refill`, off by default
(`qc_eval --bite-refill`; `--bite-ratio` 0.8 and `--bite-reset` 0.05 are the defaults). Test
`bite_refill_restores_a_wide_cells_tail`: a wide cell seeded at the leak fixed point stays at 0 under its neighbour's
centre without the refill and comes back to 0.23 with it (truth 0.36).

## The problem

On v2.20 (web and native), close pairs are found as two cells, but a small cell next to a much wider one still picks up
the wide cell's events. It only goes one way, wide into small: pair 170/22 (σ 5.3 / 6.5 px, 9 px apart), leak 0.33 into
170, −0.03 back into 22. The wide cell's footprint is cut short over the small cell: at 170's centre it keeps 0.12 of its
peak where the truth has 0.38. The small cell's footprint is close to the truth there, or slightly too big.

**Why the running statistics cannot undo it.** A cell's statistics estimate is `h(p) = cov(r(p), c) / var(c)` with the
other cells' model subtracted. When the small cell's trace carries `λ c_wide`, the wide cell's estimate over the small
cell is `a_wide(p) − λ a_small(p)`: true tail minus leak, about 0. The traces solved with that footprint keep the leak,
so the bite is a fixed point. The refine gate fix (z 3 → 0) cannot reach it, because the statistics never propose the
missing tail.

## The fix

In a refine visit, for each cell (`refine()`, before the statistics proposal):

1. **Bite test** (`bite_ratio`, 0.8): a neighbour's centre lies inside the cell's support and the footprint there is
   below 0.8 times its value at the mirror point (reflected through the cell's centre).
2. **Refill**: every support pixel on the neighbour's side takes at least the value of its reflection across the line
   through the centre (perpendicular to the neighbour's direction).
3. **Pair trim**: the refill is also proposed together with each biting neighbour cut on the side facing the cell to at
   most its own reflection; the proposal that gains more is kept.
4. **Held-out test**: the same as a statistics refinement (gain > 0, paired z > `refine_z`).
5. **Statistics reset** (`bite_reset`, 0.05): when a refill is kept, the running statistics of the cell and its biting
   neighbours are scaled by 0.05, so they re-learn from traces solved with the new footprints instead of pulling the
   bite back.

About 2,300-2,800 refills tested per run on the pair session, 150-160 kept (`SlowStats::bite_tests`, `bite_refills`).
The experiments below ran with an earlier build whose flags (`--bite-pair`, `--bite-reset 0.05`, `--bite-ratio`) are now
fixed; the PR build with `--bite-refill` reproduces the ratio-0.8 run on the pair session.

## Data

Synthetic MiniMe sessions (`minime.testing.synth`, `grin_v4` preset, 20 fps, 5 min, 600 x 600):

- **Pairs**: 41 planted pairs, centres 7 / 9 / 11 px apart, independent spikes (82 cells); no motion.
- **Dense**: the realistic preset with no planted pairs (461 cells, motion), as the regression check.

Each run is `qc_eval real ... --motion --passes 2 --later-passes refine --batch 8 --budget 30000000 --dump` (Discover +
one Refine + Extract). Leak = `b / a` of `trace ~ a own + b partner + c` against the true traces; bite = the cell's
footprint (peak 1) over the partner's 5 x 5 core divided by the truth's; bitten = bite < 0.5.

## Where the remaining leak comes from (oracle)

Traces extracted with fixed libraries (`qc_eval --library`) for the six cells still leaking > 0.2 after the 0.5-ratio
fix:

| leaking cell ← wide partner | fix as run | wide footprint → truth | small footprint → truth | all footprints true |
| --------------------------- | ---------- | ---------------------- | ----------------------- | ------------------- |
| 80 ← 37                     | 0.41       | 0.10                   | 0.41                    | 0.10                |
| 213 ← 396                   | 0.48       | 0.07                   | 0.42                    | 0.06                |
| 328 ← 258                   | 0.20       | 0.07                   | 0.20                    | 0.07                |
| 388 ← 135                   | 0.25       | 0.02                   | 0.24                    | 0.02                |
| 152 ← 121                   | 0.32       | 0.11                   | 0.31                    | 0.06                |
| 170 ← 22                    | 0.31       | 0.11                   | 0.31                    | 0.09                |

The leak is the wide cell's footprint. With true footprints the trace solve separates the pairs (floor 0.02-0.10).
At ratio 0.5 the wide tails sat at 35-65 % of the truth, above the bite test; hence ratio 0.8.

## Results

**Pairs** (seed 1 / seed 2):

|                         | main        | fix, ratio 0.5 (s1) | fix, ratio 0.8  |
| ----------------------- | ----------- | ------------------- | --------------- |
| cells with leak > 0.2   | 8 / 8       | 6                   | **2 / 4**       |
| cells with leak > 0.1   | 14 / 13     | 10                  | **9 / 8**       |
| leak p90                | 0.15 / 0.17 | 0.12                | **0.10 / 0.09** |
| bitten (of 82)          | 14 / 10     | 3                   | 3 / 4           |
| trace r, 10th pct       | 0.84 / 0.84 | 0.84                | **0.88 / 0.86** |
| pairs found as two      | 41 / 41     | 41                  | 41 / 41         |
| F1                      | 0.67 / 0.66 | 0.68                | 0.67 / 0.66     |
| precision               | 0.89 / 0.86 | 0.89                | 0.88 / 0.84     |

**Dense** (regression):

|                   | main (s1 / s2) | fix, ratio 0.5 | fix, ratio 0.8 |
| ----------------- | -------------- | -------------- | -------------- |
| F1                | 0.687 / 0.669  | 0.677          | 0.678          |
| precision         | 0.917 / 0.892  | 0.896          | 0.894          |
| trace r median    | 0.958 / 0.967  | 0.966          | 0.963          |
| trace r, 10th pct | 0.659 / 0.705  | 0.748          | 0.734          |
| footprint cos     | 0.980 / 0.982  | 0.982          | 0.982          |

QC cost per frame is unchanged (0.314 → 0.318 ms); wall time +2-3 %, within the noise of 2-4 parallel runs.

## Variants that did not help

- **Guard** (block a statistics refinement that would re-bite a cell): blocked ~2,200 useful refinements; bitten 12.
- **Mirror through the peak pixel** instead of the half-max centre: mixed, no clear gain.
- **Refill without the statistics reset**: bitten 6 but leak > 0.2 still 5; pair 22/170 stayed bitten (wide tail 0 at
  170's centre).

## Open

- Not run on the demixing suite (`demix_suite.py`); the minisim sims are not on this machine.
- One or two seeds per setting: read differences of one or two cells as noise. The drop from 8 to 2-4 cells > 0.2 holds
  in both seeds.
- 170 ← 22 (9 px, both wide) still leaks 0.31-0.36.
- The refill assumes a roughly mirror-symmetric cell. The held-out test guards it, but real asymmetric cells were not
  checked.
- Fewer merges with the fix (16 → 8, 14 → 11), not looked into.
