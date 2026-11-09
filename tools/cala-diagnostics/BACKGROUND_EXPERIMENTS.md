# Frozen background competitors

This is an offline experiment. No CaLa production source, algorithm, library,
ledger, observed frame, cell footprint, neighbor column, or noise map is changed.
The baseline is the exact float64 signed-background NNLS replay, rather than the
rounded native coordinate solver. Candidate parameters were frozen before the
new independently seeded controls were evaluated.

## Inputs and API

`load_snapshot(folder)` reads a diagnostic `keep_*` directory and returns a
`Snapshot`: `y`, `a`, `b`, `ids`, `target_index`, `shape`, `inv_sigma`, `fov`,
`meta`, and `probes`. Dense cells/backgrounds have shape [pixels, columns];
observations have shape [observations, pixels].

`make_variants(snapshot, diameter=18)` returns named `BackgroundSpec`s with `b`,
`penalty_L`, and explanatory `metadata`. `BackgroundNNLS(a, spec)` caches the
augmented projection and thin SVD. `.solve(y)` and `.solve_many(Y)` return cell
weights, signed background weights, raw residual sum of squares, penalty,
penalized objective, and cell KKT residual. `solve_many` uses batch dot products
and small NNLS problems, without reconstructing each pixel residual. `.q` is the
cell Gram after the **augmented** background projection, not a physical residual
energy when a penalty is used. `.solve(y, direct_residual=True)` verifies raw RSS
by constructing the residual explicitly.

All variants solve

    min(c >= 0, beta signed) ||y-Ac-B beta||² + ||L beta||².

Full and target-dropped models share exactly the same B and L, so the penalized
objective decrease is nonnegative to roundoff. Raw RSS decrease need not be:
the full optimum can trade a larger data residual against a smaller penalty.

## Fixed variants and units

| Name                                        | Background and penalty                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| original                                    | Captured nine free smooth grid maps and native target Gaussian; no penalty.                                  |
| no_bump                                     | Captured grid maps only; reference for maximum loss of diffuse protection.                                   |
| wide_1p5 / wide_2 / wide_3                  | Same grid; target Gaussian σ = 27 / 36 / 54 px for diameter 18; no penalty.                                  |
| incremental_ridge_0p1 / incremental_ridge_1 | Original B; λ = 0.1 / 1 times squared norm of the bump contribution not representable by the free grid.      |
| shape_gradient_0p01 / shape_gradient_0p1    | Original B; λ = 0.01 / 0.1 times diameter² times squared standardized physical background first differences. |

Native B is defined directly in the already whitened observation coordinates;
the native bump is not multiplied by inv_sigma. Wider Gaussian bumps preserve
that native convention and center through `native_bump**(1/factor²)`. They are
not a freshly chosen physical-light model.

For the incremental penalty, let r=(I-P_grid)bump. Then penalty is
λ||r beta_last||². It regularizes only the signed incremental component, is
invariant to multiplying any basis column by a nonzero factor and dividing its
coefficient by that factor, and leaves grid coefficients free. Units are the
same whitened squared-intensity units as the residual objective.

For the physical shape penalty, field g=(B beta)/inv_sigma and physical pixel
noise σ_i=1/inv_sigma_i. For each horizontal/vertical neighbor pair with both
pixels inside FOV and positive inverse noise, penalize

    λ * diameter² * [sqrt(2/(σ_i²+σ_j²)) * (g_i-g_j)]².

Differences are over one pixel; diameter is in pixels. The edge factor is the
inverse RMS of the two pixel noise scales, so uniform-noise whitening makes
this exactly λ diameter² times the whitened first-difference energy. This is a
choice of scale, not an estimated natural-image prior. It is invariant to basis
rescaling and uniform changes of physical intensity units. It permits signed
coefficients and signed background fields throughout. The physical penalty can
also discourage spatial structure introduced by the noise map; it is therefore
a stronger intervention than merely widening the last map.

## Decision statistic and interpretation

Use `objective_red-objective_full` as the declared penalized-model statistic;
retain `raw_red-raw_full` and both penalties to show the mechanism. Do not label
the objective difference a chi-square improvement or use the existing null
threshold without new calibration. An explicitly declared empirical score may
divide it by `max(full_raw_RSS / candidate_dof, 1)`, where candidate_dof is the
FOV pixel count minus the cell/background column counts, provided each model's
complete normalized score is calibrated on independent negative cases and then
evaluated on heldout cases. This normalization is an empirical scale convention;
the nominal column count is not a claim about effective penalized degrees of
freedom, and the resulting score has no asserted native chi-square null law.
Penalties leave estimated fixed nuisance backgrounds biased. A large positive
objective gain with negative RSS gain is direct evidence that a cell is
substituting for penalized background, not improving raw fit.

For a specified generative Gaussian random-background model, a fixed quadratic
penalty can be interpreted as an inverse background covariance. After handling
the unpenalized background subspace, the minimum penalized objective equals a
generalized least-squares quadratic; the covariance determinant cancels between
full/red because B and its prior are shared. That interpretation requires that
the actual signed nuisance backgrounds follow the declared distribution. A
fixed diffuse field is not such a draw merely because the code fits it with a
penalty. Nonnegative active neighbor constraints add further complications to
a universal one-sided mixture reference law.

The current defensible decision is therefore an explicitly empirical control
test: freeze all candidate parameters, use separate control calibration seeds
to set a threshold for each declared statistic, and evaluate once on heldout
noise, diffuse-light, neighbor, halo, and true-cell cases. Use one threshold per
candidate across the declared ensemble and report subgroup false-positive
rates, rather than equating a pooled rate with protection for every nuisance
family. Rates outside that simulated nuisance distribution remain unknown.

Four ID18 probes are mechanism illustrations, not independent evidence for
selecting a model. More heldout simulation seeds and other true cells are
needed before recommending a production change. Conditioning controls on the
same frozen A/B establishes a local comparison; it does not replay how changed
keep decisions alter future library construction or selected probes.

## Numerical checks

`verification.json` records 36 fits (four frozen snapshots × nine variants):
baseline raw RSS matches the existing independent replay within 1.9e-12;
all penalized objective values match independent augmented bounded least
squares within 1.7e-9; maximum normalized cell KKT is below 1.8e-14. Direct RSS
and sufficient-statistic RSS agree within 1.7e-9. Independently rescaling every
background column from 0.2 to 5 leaves each objective unchanged within 1e-6.
Tiny signed negative nested improvements at floating-point precision are not
clipped in the output.

Example command (use the existing scientific Python environment):

    OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1 python \
      tools/cala-diagnostics/background_models.py work/keep-evidence/default/capture \
      --out work/keep-background/frozen


## Initial developmental comparison

The fixed family was evaluated on 5,120 controls (46,080 scores), with disjoint
calibration/evaluation seeds, and 59 additional captured probes from six complete
4,800-frame Minisim runs. Diagnostic final footprints matched baseline bytes.
Four selected retained true cells contributed 48 probes; two unexplained outputs
contributed 11 probes and must not be treated as proven negatives.

At the reference cutoff, wide_3 changes true-cell pass counts from 8/12 to 12/12,
10/12 to 10/12, 8/10 to 9/10, and 11/14 to 8/14. Thus a pooled improvement from
37/48 to 39/48 hides a regression. Repeated probes are correlated. At separately
calibrated 1% pooled-null thresholds, heldout false KEEP rates are about 0.7–1.2%;
SNR20 positive recovery is 0% original, 92.2% no_bump, 93.0% wide_3, and 98.4%
incremental_ridge_1. All nine candidates fail the four original development
probes at these stricter thresholds.

At the reference cutoff, centered Gaussian negatives pass in 1/256 original,
5/256 wide_3, and 17/256 incremental_ridge_1 cases; shifted Gaussians pass in
7/256, 16/256, and 28/256. shape_gradient_0p1 accepts 245/256 centered and
248/256 shifted cases. Penalizing background can transfer it into the unpenalized
cell; objective gain is not necessarily raw-fit improvement. No default change
is supported by this comparison.

Controls use early/late geometry from the same cell, not spatially heldout cells.
The additional retained cells are selected survivors. Controls use 1/32 noise
quantization rather than native 1/16 and omit transient-triggered probe selection
and sequential history. These rates and thresholds are not production estimates.
A portable subset rerun reproduced all 1,404 overlapping scores (156 cases)
exactly. Data and generated score tables are external artifacts, not repo inputs.
