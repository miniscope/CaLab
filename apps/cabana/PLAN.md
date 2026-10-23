# CaBaNA Port Plan

> Status: placeholder. Nothing is decided beyond the coming-soon app that
> exists today. Everything below is a proposal to confirm before work starts.

## Goal

Bring CaBaNA (Calcium Behavioral and Neural Analysis,
`github.com/miniscope/CaBaNA`) to CaLab so a user can load calcium activity and
behavioral states in the browser and ask which cells relate to which states,
with honest null distributions. The Python project stays the reference
implementation. CaBaNA is currently an early design demo, tested only on
simulated data with planted ground truth, so the port waits for it to settle.

## What CaBaNA is

Every analysis reduces to three arrays on the neural clock:

| Array    | Shape             | Meaning                          |
| -------- | ----------------- | -------------------------------- |
| activity | n_cells x n_time  | calcium or deconvolved activity  |
| states   | n_time x n_states | boolean behavioral state matrix  |
| mask     | n_time            | frames that are valid to analyze |

Spatial bins, behavioral syllables and scored social bouts are all ways of
filling the states matrix. The pipeline is import, transform, preprocess,
analyze, results, plots. Metrics include information content, split-half
stability, AUROC, PETH, mutual information, signal correlation,
population-vector overlap, PCA, decoders (ridge, kNN, naive Bayes), GLM,
pairwise correlation and participation ratio. One shuffle engine (circular
shift, block, bout, speed-matched, per-cell and within-state nulls) gives any
metric a null distribution and p-values, with max-stat, BH or Bonferroni
correction. Output is a tidy cell x state x metric table with p-values and
z-scores, figures, per-cell evidence cards and cell classes. Inputs include
Minian, CaImAn, DeepLabCut, BORIS, Keypoint-MoSeq, `.camap` bundles, CaLab
deconvolution npz and raw numpy arrays. Results ship as `results.zip`
(manifest JSON plus npz), `summary.csv`, `pipeline.yaml` and figures, described
by `resultset-v1.json`.

## Prerequisites in the CaBaNA repo

Foundational work that should land before any port starts:

1. Results format fixes. The saved npz holds `<U` (unicode string) arrays that
   `@calab/io` cannot parse; store strings another way (for example a JSON
   sidecar or fixed-width bytes). The manifest JSON is written with
   `allow_nan=True`, which `JSON.parse` rejects; write `null` for missing values.
2. A stable `resultset-v1` schema, versioned, so CaLab can validate imports.
3. A CaLab-side slider component, which interactive `tune()` is waiting on.
4. Validation beyond simulated data, so the port targets metrics that hold up.

## Proposed integration shape (to confirm)

Recommended by the CaBaNA ROADMAP: a hybrid.

- Shift-sum kernel family in Rust/WASM, for interactive single-metric shuffle
  tests in the browser.
- GLM, PCA, Bayes and cohort statistics stay in Python behind a job route.
- Python remains the reference implementation; WASM results are checked
  against it.

Alternatives to weigh:

- Browser-only: simplest to host, but GLM, PCA and decoders would all need
  Rust ports and the dependency list grows.
- Python-engine only: CaLab app is a thin viewer over Python jobs. No new
  Rust, but no interactive shuffles and every run needs a server.

## Mapping onto CaLab

| CaBaNA piece            | CaLab home                                                        |
| ----------------------- | ----------------------------------------------------------------- |
| results.zip import      | `@calab/io` (after the `<U` and NaN fixes)                        |
| shift-sum kernels       | new crate under `crates/`, loaded through `@calab/compute`        |
| Python job route        | `python/` bridge; registry entry exists with `result_schema=None` |
| interactive tune()      | shared slider component in `@calab/ui`                            |
| CaDecon output as input | existing deconvolution npz export                                 |
| community and tutorials | `@calab/community`, `@calab/tutorials`, added later               |

## Phases

1. Close the CaBaNA prerequisites above and confirm the integration shape.
2. Results viewer: import `results.zip`, show the cell x state x metric table,
   evidence cards and cell classes. No computation in the browser.
3. Interactive shuffle test: port the shift-sum kernels to Rust/WASM for one
   metric, validated against Python on the same inputs.
4. Add metrics to the WASM set as they prove worthwhile; wire Python job route
   for GLM, PCA, Bayes and cohort stats.
5. Tutorials, community sharing and a landing-page screenshot; flip the app
   status from coming-soon.

## Open questions

- Is the hybrid shape right, or does a viewer-only first release suffice?
- Which states inputs (BORIS, DeepLabCut, Keypoint-MoSeq) get browser-side
  importers versus staying in Python?
- Where does the Python job route run, and who hosts it?
- What tolerance counts as "matches the Python reference" for WASM metrics?
- Does `resultset-v1` get a published JSON schema CaLab can vendor?
