# Why look-back + Final settle footprints are larger: plan (22 Nov 2026)

Written before any scoring against ground truth. Follow-up to the beta gate
([2026-11-22-beta-gate.md](https://github.com/Aharoni-Lab/CaLab/pull/472), PR #472): on three real recordings the
look-back Discover + Final settle footprints have 33–75 % more pixels than v2.20.0's Discover + Refine.

## Seen before this plan (orientation, post hoc for the purposes of this study)

While finding the existing run trees I printed pixel counts (pixels > 0) and the energy below 10 % of peak for
libraries that earlier studies left on disk. These numbers were seen before the plan and shaped it:

- Sims, 14 runs (`demix-suite/lbsettle-full`): `DR-main` 603 px, `COMBO` 646, `COMBO+R` 697, `SETTLE` 697.
- Workshop recording in qc_eval (`runs/lbsettle/real`): plain Discover 283 px, + one Refine 370; `COMBO` 460–467,
  `COMBO+R` 657, `SETTLE` 647–661. Discover with look-back only 349, with replay only 354. Faint energy 0.0006
  (D + R) against 0.013 (`COMBO+R`, `SETTLE`).

So before any scoring: a Refine and a settle from the same look-back library end at the same size, and the growth is
much larger on real data (+78 %) than on the sims (+16 %).

## Questions

1. **Which size is closer to the truth?** On sims, where does the light the new path adds lie: inside the cell's own
   true footprint, on a neighbour's, or where no cell is?
2. **Do the sims show the real-data pattern at all** (size, faint share, the settle growing more than Refine)? If
   not, the sims cannot decide the real-data question and that is said plainly.
3. **Which ingredient makes the difference?** Candidates from the gate: (1) background / noise state of re-read
   frames, (2) settle read order, (3) cluster replay in the settle, (4) held-out gate, (5) dropped frames. Added from
   the orientation: (6) cluster replay in Discover, (7) look-back in Discover.
4. **Cell loss:** is it the frames dropped for the slow loop?

## Metrics (script `settle_size.py`, new; GT loading, matching and motion offset from `demix_metrics.py`)

Per matched cell (Hungarian, r ≥ 0.7, detectable GT units), estimate `a` and true footprint `g`, both scaled to peak
1 (the estimate scaled by least squares onto `g` over the true core, pixels with `g` ≥ 0.5, so a bitten or noisy
peak does not set the scale):

- **Extent:** pixels with `a` ≥ 0.10 and ≥ 0.01 of peak, and pixels > 0, each as a ratio to the same count on `g`.
- **Energy split:** share of the estimate's energy (Σa²) and of its light (Σa) in three places: on the cell's own
  true support, on another unit's true support and not its own, outside every true support. "True support" = `g`
  above a floor; the floor is set after looking at the GT's own value range (first step, before any estimate is
  scored), and two floors are reported if the result depends on it.
- **Missed light:** share of the true footprint's light (Σg) on pixels where the estimate is 0. This is the
  "truncated footprints leave light behind" quantity.
- **Core shape error:** 1 − cosine between `a` and `g` over pixels with `g` ≥ 0.10 of peak; and the same over the
  skirt (0.01 ≤ `g` < 0.10).
- **Radial profile:** median `a` and `g` by distance from the true centre (in D), to see over- or under-reach.
- **Neighbour leak:** the suite's bite ratio, leak sd and crosstalk rows (`demix_pairs.tsv`, `demix_corr.tsv`),
  reused as they are.
- **Strata:** isolated (no other GT centre within 1.5 D), close (one within 1 D), between. The replay acts on
  overlap clusters only, so growth on isolated cells cannot be the replay alone.

Real data (no truth): pixels > 0, pixels ≥ 10 % and ≥ 1 % of peak, faint-energy share, radial profile, and
connected-component / single-peak checks (PI rule: one contiguous single-peaked blob). The same code runs on the
app's beta-gate libraries and on the qc_eval real-data libraries, to see whether qc_eval reproduces the app.

## Comparisons

Paired by sim (same GT unit matched in both arms), mean paired difference with a 95 % CI over sims (bootstrap over
sims, as the suite does). The existing trees are scored first; they cost no compute.

| step | arms | isolates |
| --- | --- | --- |
| A | `DR-main` vs `SETTLE` (14 sims) | the headline: which is closer to truth |
| B | `COMBO+R` vs `SETTLE` | settle mechanics against an ordinary Refine, same library (candidates 1, 2) |
| C | `OFF+S` vs `SETTLE`; `REF+S` vs `SETTLE` (quick tier) | replay everywhere / replay in Discover only (3, 6) |
| D | `DR-main` vs `OFF+S` | look-back + settle without replay (7) |
| E | `ST-frozen`, `ST-stats` vs `ST-full` (quick tier) | fresh held-out frames: how much the gate lets through (4) |
| F | workshop + Samara qc_eval libraries: `DRR`, `OFFS`, `REFS`, `SETTLE` | the same attribution on real data, sizes only |
| G | app beta-gate libraries | does qc_eval reproduce the app's sizes |

New runs only where a comparison is missing after A–G:

- same `COMBO` library settled with the replay on and off (needs a settle-only override of `--joint-update` in
  qc_eval, eval branch only);
- v3 sims (real cell size, 10 px) for the key arms if the v2 sims do not show the real pattern;
- workshop Discover with `--slow-keep` at the app's kept shares (about 0.66 new, 0.81 old) for the cell loss.

## How the verdict is read

- "Larger is closer to truth" when the new path's added light lies mostly on the cells' own true support: missed
  light falls, and energy on neighbours and outside truth does not rise by more than the missed light falls.
- "Larger is over-reach" when energy outside the own true support rises with no fall in missed light, or neighbour
  leak / crosstalk rises.
- If the sims' growth is a different kind from the real data's (question 2), the verdict on the sims is reported
  with that limit, and the real-data evidence (shape of the added light, neighbours' cores) is reported beside it
  as indirect.

## Limits

RAM ≤ 6 GB per job; at most 2 qc_eval processes at once; no Chrome; Samara data read-only.

## Addendum: the PI's reframing (22 Nov 2026, before any score was read)

Added after the metric script was written and its first smoke run was started, before any of its output was read.

The PI: Discover + Refine (v2.20.0) is not the reference ("could be those are less good too"); cala has no real users
yet, so matching the old release does not matter. The study therefore ranks the two paths, it does not test the new
one against the old.

- **Sims:** both paths are scored against the truth on the same footing. Besides the size metrics above: bitten
  footprints, crosstalk and trace r (the suite's rows, already on disk), and true cells found (matched detectable
  units, false cells), not cells against the old path.
- **Real data, proxies that assume neither path is right:**
  - held-out reconstruction: `qc_eval`'s held-out score where the runs have it (`ho_score`, `ho_score_frac`), and the
    residual left around cells;
  - neighbour trace crosstalk: the correlation of close pairs' traces against far pairs' (the suite's excess, on the
    libraries' own traces);
  - repeatability: seed-to-seed agreement at equal footing (already measured in #439, #443 and the gate; reused).
- **Recommendation:** whichever path is better by these, said plainly.
- **Cell loss:** diagnosed on its own terms: true cells found on sims with frames dropped at the app's shares
  (`--slow-keep`), with and without the replay.
