# The false positives that grow with compute are leftover light, not neuropil (Nov 2026)

With more slow-loop compute (more visits, or more frames per tile), precision
fell: on the motion sim, 4x visits took P@8 from .934 to .858. The extra false
positives (`COMPUTE_VS_PRECISION.md`, PR #312) were read as population-coupled
diffuse light (neuropil) that the patch problem's background cannot absorb.
This note checks that reading against the simulator's ground truth and against
real data, then fixes what the false positives actually are.

**Verdict.**

- The extra false positives are not neuropil, and they are not population-coupled.
- They are light that nearby, already-found cells leave behind:
  - their tails beyond the tight supports;
  - the high-pass moat;
  - footprints that lag motion.
- Such a mix follows several neighbours a little and none of them enough for the add test's one-neighbour check (r < 0.6).
- This is the familiar CNMF-style failure: footprints that do not span a cell's whole light leave that light as spurious sources. The root fix is footprints at their full extent (section 5).

**The guard.** An add-test guard (`joint_neighbours`) fits the candidate's held-out trace on the nearby cells' traces _jointly_.

- On the sims it does what it should: motion s5 at 4x goes from P@8 .858 to .900, with R@8 .786 → .794.
- On the workshop recording it also blocks real cells: Minian matches fall at the default budget (section 4). There, neighbours co-fire in population events, and the held-out frames are chosen for high residual, i.e. during those events.
- So it ships **off by default**, as `--joint` in the harnesses.

## 1. Is the simulator's neuropil realistic, and does it make these cells?

### The sim's neuropil at cell scale

For every final cell of the 4x motion run, the ground-truth neuropil movie was:

1. passed through the same σ = 20 px high-pass;
2. projected onto the cell's filtered footprint.

| class (motion s5, 4x)                 | n   | neuropil fluctuation on the footprint (noise σ) | GT cells' light on the footprint (noise σ) |
| ------------------------------------- | --- | ----------------------------------------------- | ------------------------------------------ |
| true cells                            | 488 | 0.13                                            | 50                                         |
| "noise" FPs (no GT unit within 10 px) | 27  | 0.13                                            | 10                                         |

- Under the footprint of a "noise" FP, the neuropil moves 0.13 noise σ, the same as under a true cell.
- At σ ≈ 115 px (`spatial_sigma_um` 190), the sim's neuropil is almost entirely removed by the high-pass.
- The light that is there is GT cells' light, mostly from bright cells 10–25 px away.

### What the FP traces follow

The pass-2 traces (`qc_eval --dump`) of the 27 FPs were correlated with the sim's other signals. Medians:

| what                                   | value                                              |
| -------------------------------------- | -------------------------------------------------- |
| r with the population drive            | +0.01                                              |
| r with any of the 5 neuropil envelopes | ≤ 0.25                                             |
| r with motion displacement or speed    | +0.01                                              |
| R² on GT units within 45 px            | 0.16                                               |
| r with the projected GT-cell light     | +0.24                                              |
| strongest single correlate             | a bright cell ~22 px away, _negative_ r (its moat) |

### The residual after cells, measured the same way on real and simulated data

`tools/cala-diagnostics/residual_after_cells.py`:

1. Rigid motion correction.
2. High-pass σ = 20.
3. Per-frame least squares on the high-passed footprints, moats included.
4. 0.5 s bins.

This uses 1800 frames: real frames 6000–7800, sim frames 3000–4800. Band power is given relative to white noise in the same band.

| data, footprints               | 1.5–4 px | 4–10 px | 10–20 px | > 20 px | residual 1.5–20 px power explained by population drive | blocks with r(residual, population) > 0.3 |
| ------------------------------ | -------- | ------- | -------- | ------- | ------------------------------------------------------ | ----------------------------------------- |
| real, Minian (708)             | 5.3      | 18.7    | 21.2     | 34.7    | 2.7 %                                                  | 4.5–7 %                                   |
| real, cala library (688)       | 5.7      | 22.9    | 34.9     | 46.3    | 3.5 %                                                  | 4.5–6 %                                   |
| sim motion, cala library (503) | 2.6      | 15.6    | 19.8     | 8.2     | 2.0 %                                                  | 4 %                                       |
| sim motion, all GT units       | 1.8      | 5.4     | 5.4      | 3.8     | 2.5 %                                                  | 1–3 %                                     |
| sim static, all GT units       | 1.1      | 1.0     | 0.8      | 3.1     | 0.5 %                                                  | 0–0.5 %                                   |

- **Cell scale.** The sim's cell-scale residual after the found cells is within ~1.5x of the real one. In both, the residual is mostly light from cells, found or unfound.
- **Population coupling.** Neither the real nor the simulated residual is population-coupled at cell scale: the population drive explains 2–3.5 % of it.
- **Large scale.** Real data has ~5x more residual above 20 px. That is the global mode and the smooth local field, which the fast loop's background handles; in the slow loop the 3 x 3 bump grid handles it.
- **Below 1.5 px.** The real residual has more pixel-scale power (2.7 vs 1.2): the fixed-pattern gain that motion correction makes shimmer (`PIXEL_NOISE.md`). The `_fpn` spec adds it.

So the sim's neuropil is realistic where it was calibrated (global mode, ~100 px local field), and it is irrelevant at cell scale. That matches real data. Nothing to recalibrate.

A population-coupled regressor or a low-rank smooth background in the patch problems would therefore not remove these false positives:

- the false positives are not coupled to the population;
- they are 2x a cell's size, not ≫ cell size.

A stronger local background would also start to swallow real cells. Its local bump already takes ~73 % of a real cell's energy (#299).

## 2. What the false positives are

Composition of the non-matched cells, using the classes in `COMPUTE_VS_PRECISION.md`:

| class (motion s5, 4x) | n   | R² of its trace on the library neighbours' traces (40 px) | max single-neighbour r |
| --------------------- | --- | --------------------------------------------------------- | ---------------------- |
| true cells            | 488 | 0.07                                                      | 0.14                   |
| noise                 | 27  | 0.18                                                      | 0.22                   |
| partial               | 25  | 0.21                                                      | 0.32                   |
| adjacent              | 21  | 0.32                                                      | 0.42                   |
| dup                   | 8   | 0.32                                                      | 0.52                   |

- **Adjacent, partial and duplicate cells** are 54 of the 81 false positives at 4x. Their traces are explained by their neighbours jointly well above true cells (adjacent and dup: R² ≥ .3 for half of them), while each single neighbour stays below the 0.6 bar.
- **"Noise" cells** are broad (half-width 9.9 px vs 7.2 for true cells, 63 % at the 20 px support cap vs 27 %) and weak (ledger peak 6.8 σ vs 32). Their light is GT cells' leftover light, mostly too weak to tie to any one source.

## 3. The change

`assess_add` keeps its one-neighbour check: no nearby cell's held-out trace may follow the candidate's at r ≥ `merge_corr`. The optional joint check, `SlowLoopConfig::joint_neighbours` (off by default), adds:

- The candidate's held-out trace is regressed on the held-out traces of all nearby cells, within 2 support radii.
- If the fit is significant (F test at 1e-3, so a few held-out frames cannot fit noise) and its adjusted R² is at least `merge_corr`², the candidate is the neighbours' leftover light. It is left to refinement, absorption and merging, like a one-neighbour match.

Properties:

- No new threshold: the bar is the existing `merge_corr`, squared.
- No background term, so no real-cell energy is absorbed. A true cell is blocked only when nearby cells explain its trace. Independent neighbours (the sims) do not, but co-firing ones (real CA1 population events) do.
- Cost: one small Gram solve per assessed candidate.
- `--joint` in `qc_eval` / `discover_eval` turns it on.
- Restricting the regressors to non-overlapping neighbours (so their traces cannot carry the candidate's own light) was tried. It gives back most of the sim gain (motion s5 4x P@8 .873) and still costs real matches (331 vs 362 at r ≥ .7, 1x).

## 4. Results vs frames read

Setup:

- `qc_eval sim`, 9600 frames (8 min), `--batch 8`, serial `step`.
- 1x = 3e7 work units per frame (the default); 2x = 6e7; 4x = 1.2e8; "252 fr/tile" = `--frames-per-tile 252`.
- "main" is the default build; "joint" is `--joint`.
- FP classes are as in `COMPUTE_VS_PRECISION.md`.
- Run-to-run noise is about .016.

### Simulations

| sim       | arm         | P@4 main → joint | R@4           | P@8           | R@8           | cells     | FP noise/adj/partial/dup  |
| --------- | ----------- | ---------------- | ------------- | ------------- | ------------- | --------- | ------------------------- |
| motion s5 | 1x          | 0.951 → 0.970    | 0.689 → 0.665 | 0.934 → 0.940 | 0.754 → 0.754 | 501 → 498 | 12/9/9/4 → 8/7/10/5       |
| motion s5 | 2x          | 0.940 → 0.941    | 0.730 → 0.697 | 0.915 → 0.922 | 0.779 → 0.776 | 529 → 523 | 17/15/8/4 → 11/11/14/5    |
| motion s5 | 4x          | 0.895 → 0.917    | 0.730 → 0.733 | 0.858 → 0.900 | 0.786 → 0.794 | 569 → 548 | 27/21/25/8 → 22/17/12/4   |
| motion s5 | 252 fr/tile | 0.941 → 0.948    | 0.699 → 0.699 | 0.893 → 0.929 | 0.765 → 0.779 | 532 → 521 | 18/12/14/13 → 13/15/9/1   |
| motion s6 | 1x          | 0.955 → 0.956    | 0.683 → 0.658 | 0.947 → 0.948 | 0.760 → 0.760 | 524 → 523 | 5/8/10/6 → 1/7/16/2       |
| motion s6 | 2x          | 0.931 → 0.939    | 0.721 → 0.709 | 0.931 → 0.938 | 0.790 → 0.784 | 554 → 546 | 7/11/12/8 → 6/11/14/3     |
| motion s6 | 4x          | 0.900 → 0.906    | 0.747 → 0.740 | 0.882 → 0.888 | 0.792 → 0.798 | 586 → 587 | 17/20/17/13 → 12/25/18/11 |
| motion s6 | 252 fr/tile | 0.945 → 0.949    | 0.714 → 0.680 | 0.915 → 0.920 | 0.789 → 0.761 | 563 → 540 | 10/20/10/8 → 6/20/12/5    |
| static s5 | 1x          | 0.967 → 0.981    | 0.680 → 0.672 | 0.975 → 0.985 | 0.756 → 0.743 | 470 → 457 | 4/0/6/2 → 3/1/2/1         |
| static s5 | 2x          | 0.967 → 0.971    | 0.726 → 0.718 | 0.960 → 0.973 | 0.787 → 0.769 | 497 → 479 | 6/1/9/4 → 4/0/9/0         |
| static s5 | 4x          | 0.936 → 0.948    | 0.752 → 0.751 | 0.948 → 0.960 | 0.784 → 0.784 | 501 → 495 | 11/4/9/2 → 11/3/6/1       |
| static s5 | 252 fr/tile | 0.966 → 0.966    | 0.701 → 0.710 | 0.958 → 0.964 | 0.761 → 0.757 | 481 → 476 | 10/0/8/2 → 9/3/3/1        |
| static s6 | 1x          | 0.966 → 0.975    | 0.712 → 0.695 | 0.969 → 0.960 | 0.782 → 0.768 | 508 → 503 | 6/1/7/2 → 6/3/9/2         |
| static s6 | 2x          | 0.946 → 0.963    | 0.752 → 0.735 | 0.946 → 0.953 | 0.801 → 0.774 | 533 → 511 | 15/5/9/1 → 8/2/12/2       |
| static s6 | 4x          | 0.921 → 0.934    | 0.757 → 0.742 | 0.918 → 0.940 | 0.798 → 0.801 | 547 → 536 | 18/9/12/7 → 15/4/10/4     |
| static s6 | 252 fr/tile | 0.959 → 0.964    | 0.741 → 0.730 | 0.939 → 0.954 | 0.809 → 0.798 | 542 → 526 | 11/10/9/3 → 13/2/7/2      |

On the sims:

- Precision at 8 min is higher in 15 of 16 arms.
- The biggest gains are where compute is high (motion s5: 4x +.042, 252 fr/tile +.036).
- The fall of precision with compute shrinks on motion s5: 1x → 4x was −.076, now −.040. It barely changes on motion s6 (−.065 → −.060).
- Recall at 4 min is lower in most arms (−.01 to −.03): leftover-looking real cells wait for their neighbours to refine.
- Recall at 8 min is within noise except static s5/s6 at 2x and motion s6 at 252 fr/tile (−.018 to −.028).

### Real data

Workshop CA1, 15 min, `discover_eval real --motion --frames 18000 --no-pass2`. Minian has 708 cells.

| budget | arm                               | library | Minian matched r ≥ .7 | r ≥ .5 | cells without a Minian match (r < .5) | late merges (≥ frame 6000) | cohort born 2400+ removed later |
| ------ | --------------------------------- | ------- | --------------------- | ------ | ------------------------------------- | -------------------------- | ------------------------------- |
| 1x     | main                              | 629     | 362                   | 430    | 199                                   | 187                        | 36 %                            |
| 1x     | joint                             | 507     | 298                   | 362    | 145                                   | 134                        | 33 %                            |
| 1x     | joint, non-overlapping regressors | 558     | 331                   | 394    | 164                                   | 164                        | 36 %                            |
| 4x     | main                              | 799     | 381                   | 470    | 329                                   | 413                        | 51 %                            |
| 4x     | joint                             | 666     | 340                   | 411    | 255                                   | 313                        | 45 %                            |

On real data the guard removes cells Minian does not have and cuts churn, but it also removes ~60 Minian-matched cells at the default budget. Minian is not ground truth, but a loss that size in matched cells is a recall cost. That is why the guard is off by default.

## 5. Where cala limits footprint extent, and what full extent needs

How much light is outside the footprints today (motion s5, 1x, main, 469 matched cells). Each GT cell (oracle footprint, 24 px window, no scatter halo in these sims) is compared with its matched cala cell's support:

| quantity                                          | median  | p10     | p90     |
| ------------------------------------------------- | ------- | ------- | ------- |
| unfiltered light outside the support              | 4.0 %   | 2.3 %   | 9.5 %   |
| high-passed energy outside the support            | 5.2 %   | 4.5 %   | 7.2 %   |
| positive high-passed light outside the support    | 0.0 %   | 0.0 %   | 0.5 %   |
| share of that outside energy in the negative moat | 100 %   | 99.6 %  | 100 %   |
| support radius                                    | 17.8 px | 14.6 px | 20.0 px |

- On these sims the support holds almost all of a cell's positive light. What is lost is the high-pass moat, which the model drops by cutting the _filtered_ column to the support.
- The sims have no scatter halo (`scatter_halo_fraction` 0). Real cells have a ~1 % plateau out to ~50 px (halo energy 0–45 %, cala-port notes), so on real data truncation also drops positive light. These numbers are a lower bound for real data.

### Every place that limits extent, or assumes it is bounded

Footprint shape itself:

| where                                                                              | what                                                                                                                                                    | to take full extent                                                                                                                                   | cost                                                                                  |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `trace/library.rs:354` (`support_disk`), defaults `:86-88`                         | support radius = 2.5 HWHM, clamped to 6–20 px; the ~11 px half-width FPs sit at the 20 px cap                                                           | drop the cap; take the support from the footprint's own extent (where its estimate exceeds its standard error)                                        | fast-loop cost ∝ support pixels (below)                                               |
| `trace/library.rs:369` (`Core` filtered values "on the support"), fast loop        | the filtered column `H a` is kept only on the unfiltered support, so the moat (5 % of a cell's high-passed energy, reach ~2σ = 40 px) is never modelled | store `H a` out to the filter's reach                                                                                                                 | column pixels ×~4 for a 12 px cell (r 18 → 18+20 px)                                  |
| `discover/local.rs:188-250` (`Cell::from_canvas`)                                  | unfiltered values cut to the support disk; filtered column computed on the support's bbox only                                                          | same support rule as the library, filtered over the full reach                                                                                        | as above, in every patch problem                                                      |
| `discover/local.rs:220`                                                            | a footprint whose support touches the FOV mask is rejected                                                                                              | clip at the mask instead of rejecting                                                                                                                 | none                                                                                  |
| `discover/mod.rs:2443`, `:2929`                                                    | add candidates are fitted on a 0.75-diameter disk ("detect small, merge later")                                                                         | fine as a seed if later growth is free                                                                                                                | none                                                                                  |
| `discover/mod.rs:3635`                                                             | refine domain = support + 2 px, capped at `max_support_px`                                                                                              | grow where the running statistics (`fpstats`) say the footprint is non-zero, without the cap                                                          | per refine ∝ domain                                                                   |
| `discover/mod.rs:1379` (`stats_margin_cells` 0.4 → 4 px), `discover/fpstats.rs:59` | the running footprint statistics cover only support + 4 px, so growth beyond that is never seen                                                         | margin out to where light is still significant (~filter reach)                                                                                        | fpstats update per frame ∝ disk pixels, the biggest per-cell cost in the observe path |
| `discover/local.rs:130-180` (`invert`)                                             | projected gradient on the candidate's domain only, values ≥ 0                                                                                           | unchanged (a domain choice, not a limit) once domains are not capped                                                                                  | —                                                                                     |
| `discover/local.rs:275` (`BgBasis::new`), `discover/mod.rs:2469` (`with_bump`)     | 3 x 3 bump grid (σ ≈ 37 px) and a σ = 10 px local bump at the candidate                                                                                 | not a footprint limit, but a broad cell competes with the bump; with full-extent footprints the bump in the keep test should be the only diffuse term | none                                                                                  |

Geometry that assumes a bounded extent:

| where                                                          | what                                                                                 | to take full extent                   | cost                                                                                                                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discover/mod.rs:405-406`, `:468`                              | tile 64 px + patch margin 24 px; config requires margin ≥ `max_support_px`           | margin ≥ largest support (e.g. 50 px) | patch 112² → 164² px: ~2.1x per visit (load, Gram, solves)                                                                                                                 |
| `discover/reservoir.rs` (patch = tile + margin)                | reservoir stores whitened patches                                                    | same margin                           | reservoir bytes ~2.1x per tile at the same frames per tile (or half the frames)                                                                                            |
| `discover/shard.rs:475-495` (`zone`, `ZONE_GUARD_PX`)          | a visit's zone is its patch plus the bboxes of the cells it reads, plus a 4 px guard | unchanged rule, larger zones          | fewer visits in parallel (zones collide more), so parallel speed-up drops                                                                                                  |
| `discover/mod.rs:2875`, `:3519` (`reach = 2 · max_support_px`) | neighbour searches use the cap as the reach                                          | use the actual radii                  | none                                                                                                                                                                       |
| `trace/library.rs:274`, `:463`, `:536`, `:697`                 | Gram neighbours within `radii[i] + rmax`; overlap groups = connected components      | unchanged                             | with ~40 px columns most of the FOV becomes one overlap group; the solver's sweeps then cover the whole library (warm-started, so few sweeps, but no per-group early exit) |

Cost to the fast loop:

- Per frame it is ~(projections over every support) + (sparse Gram sweeps).
- Projections scale with the summed support pixels: ~4x if columns carry the moat, more for halos to 50 px.
- Gram nonzeros scale with pairs whose columns overlap: about (r_new / r_old)⁴ ≈ 5–15x.
- At 2 MPix the trace stage is already the bottleneck (~4.6 µs per cell per frame), so full extent likely needs the GPU trace path or a cheaper column representation, e.g. the moat as a separable low-pass term computed once per frame: `H a = a − G * a`, and `G * (Σ a_i c_i)` is one blur per frame.

**Proposed follow-up (not built).**

1. Remove the support cap and grow supports from the running statistics (support where the estimate is significant).
2. Carry each filtered column to the filter's reach, so the moat is modelled.
3. Size the patch margin from the largest support.

The existing joint trace solve and footprint updates already demix overlapping cells; no new demixing method is needed.

Expected effect:

- The moat and tail leftovers that make the adjacent, partial and duplicate FPs (54 of 81 at motion s5 4x) should disappear at the source, without a guard that also blocks co-firing real cells.
- The broad "noise" FPs are weak mixtures of several neighbours' leftovers, so they should shrink too.
- The price is fast-loop cost (4–15x in the footprint terms, unless the moat is handled by the per-frame blur trick) and slower slow-loop visits (~2x pixels per patch).
- Precision should then no longer fall with compute, because more tests stop finding leftover light to accept.

## What is left

- **Broad, weak "noise" cells.** Most remain under the guard. They pass keep tests because they carry real transient light, just not their own.
  - A shape-and-strength rule (broad, at the support cap, ledger peak < ~8 σ) would catch 41 % of them and 1 % of true cells. It is a threshold rule and was not built.
- **The guard on real data.** Its cost comes from co-firing neighbours. A version that compares _spatial_ evidence (does a neighbour's grown footprint explain the candidate's light) is what the existing absorb/grow alternatives already do. Full-extent footprints make that comparison fair.
