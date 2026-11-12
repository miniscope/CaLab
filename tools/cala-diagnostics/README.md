# Cala discovery diagnostics

These tools inspect `discover_eval` runs without changing discovery algorithms.
Run from the repository root. Python 3.10+ and NumPy are required for trajectory
analysis; Matplotlib is optional for PNG/PDF plots; Zarr is optional for the Minian
comparison. The small benchmark additionally needs the pinned Minisim environment
described in `tools/minisim-calibration/README.md` (pinned at 01a9ce2, the
revision the validated benchmark used; the exporter needs c243dca or later).

```sh
cargo build --manifest-path crates/cala/Cargo.toml --release --example discover_eval
crates/cala/target/release/examples/discover_eval real /path/to/raw /path/to/run \
  --motion --no-pass2 --fps 19.762756882076214 --checkpoints 40
python tools/cala-diagnostics/analyze_evolution.py /path/to/run \
  --fps 19.762756882076214 --png-plots
python tools/cala-diagnostics/profile_run.py /path/to/run --fps 19.762756882076214
```

Set `--fps` from the recording timestamps. AVI nominal rates can be wrong. The
native example processes every frame sequentially; browser forwarding can skip
processing batches, so native discovery schedules and throughput do not establish
interactive browser performance. A concurrent, instrumented benchmark is
exploratory, not an isolated throughput benchmark.

`analyze_evolution.py` accepts `--out`, `--cases`, `--start`, and an optional
`--all-cases` for a searchable visual gallery of every ID with saved published
shapes, or an optional `--minian /path/to/minian_out` containing `A.zarr`. `--maxshift` sets the integer
translation search radius (default 16 px). Its default output is `RUN/analysis`.
No Python package installation or network access occurs inside these scripts.

## Saved diagnostics and interpretation

`footprint_history.bin` is append-only changed **published** shapes. Its header is
`CALAFPH1` followed by little-endian u32 height and width. Every record contains
u64 consumed recording frames, u64 library version, u64 cell ID, u32 pixel count,
then pixel-count u32 indices, f32 unfiltered values, and f32 filtered values.
`library_versions.tsv` contains the complete membership at each publication.
Removed cells' shape history remains available. The exact final membership and
all reconstructed final columns are checked against `footprints.bin` before the
analysis succeeds.

`edits.tsv` describes **working** edits; its `recording_frame` is zero-based, so
the analysis converts it to consumed frames by adding one. `frame` is slow-loop
observed time, not recording time. Merge keeps `id` and removes `other`; split
keeps `id` and introduces `other`. Add/absorb `other` is merely a nearby cell and
is not a lineage edge. Edits between publications can create and remove IDs that
have no saved shape. A merge/delete may act on a working shape changed since its
last publication. Those limitations prevent causal conclusions from a case sheet
alone.

The main outputs are:

- `all_ids.tsv`: working IDs, lifetimes, published membership intervals, final
  presence, delete reason, edit counts, and shape/center summaries.
- `shape_observations.tsv`: every changed published shape's geometry and adjacent
  and first-shape cosines. Cosines use the full sparse unfiltered support at its
  recorded image position; movement changes cosine even when shape is conserved.
- `publication_intervals.tsv`, `lineage.tsv`, `rates_per_minute.tsv`: exact saved
  membership intervals, logged merge/split links, and duration-normalized rates.
- `recurrence_candidates.tsv`: removed-to-new-ID candidates within 8 px and with
  unfiltered cosine ≥0.6, excluding direct logged lineage. This is a spatial
  screen, not proof of identity.
- `analysis_summary.json`, `report.md`, `case_sheets.html`: compact results and
  representative first/intermediate/last published footprints over a whole-run
  max projection. Optional `overview.png`/`.pdf` are standalone standard plots.

The 4 px displacement and 0.5 adjacent cosine screens are descriptive, not error
definitions. High refinement/edit rates can reflect adaptation or correction.
The Minian comparison uses a global translation from summed peak-normalized
footprints and local unfiltered cosine; values below 1% of a Minian component's
peak are omitted. It reports many-to-one **agreement/disagreement only**. Saved
Minian components are imperfect and are not ground truth. Distinct Minian matches
on two pre-merge shapes are inspection candidates, not confirmed false merges.

## Simulations and exact oracle cases

The benchmark wrapper and summarizer provide their supported flags with `--help`:

```sh
python tools/cala-diagnostics/run_small_benchmark.py --help
python tools/cala-diagnostics/summarize_small.py --help
python tools/cala-diagnostics/analyze_matching.py --root /path/to/benchmark
```

Keep the seed, dimensions, duration, optics/scatter setting, motion settings,
generator version, and command with each result. Small cropped fields have a
large boundary fraction. A no-halo simulation and a halo=0.45 simulation are
different optical conditions, and neither alone generalizes to a real recording.

Simulation runs export `gt_footprints.bin` (the same `CALAFP01` sparse library
format as final footprints), `gt_units.tsv` (GT slot to oracle ID and original
oracle-unit-index mapping), and `gt_offset.tsv` (shift detected coordinates onto
oracle coordinates). The optional exact oracle inspection tools use those files:

```sh
python tools/cala-diagnostics/analyze_gt_edits.py /path/to/run /path/to/sim
python tools/cala-diagnostics/plot_gt_case.py /path/to/run /path/to/sim \
  --id 18 --gt 18
```

`analyze_gt_edits.py` computes the same sparse-union Pearson correlation and
positive filtered-footprint centroid gate as the Rust evaluator against exported
GT columns, but reports per-shape nearest matches, not a Hungarian assignment.
The Rust final `labels.tsv` supplies final one-to-one match membership. Without
exact exports, the script falls back to unfiltered oracle cosine and explicitly
marks the result provisional: GT slot and original oracle ID can differ.
`gt_structural_events.tsv` records before/after published shapes and their temporal
distance from a working edit. Retention candidates require a strong, separated
pre-delete GT match and no final Rust match; they do not establish why the keep
test failed. `plot_gt_case.py` renders oracle activity, saved shape correlation,
example footprints, and the best final local GT agreement for a specified pair.

`profile_run.py` analyzes measured stage wall times. Work counters are operation
proxies and must not be relabeled as measured stage wall time. Profile evidence,
true-GT simulation failures, real-data consistency checks, and mechanism
hypotheses should remain distinct in reports.

Continued new-cell discovery for hours is expected. A count plateau or zero late
add rate is not a target. Treat rates and growth descriptively; judge retention,
quality and identity using actual evidence. Simulation recovery should also be
conditioned on activity opportunities and time since sufficient signal arrived.

Run the small synthetic diagnostic regressions with:

```sh
python -m unittest discover -s tools/cala-diagnostics -p 'test_*.py'
```

## Frozen keep-test replay (optional SciPy)

`replay_keep.py` requires NumPy and SciPy. It reads targeted snapshots produced
by the `diagnostics` feature (see the capture's `FORMAT.txt`) and independently solves each frozen probe with nonnegative cell
amplitudes and **unconstrained** background coefficients. It does not rerun or
change discovery. Run after the capture completes:

```sh
python tools/cala-diagnostics/replay_keep.py /path/to/capture \
  --out /path/to/replay --target 18 \
  --oracle /path/to/sim/oracle.bin --oracle-id 18 --slow-start 50 --fps 20 \
  --replace final_refine_old=/path/to/capture/refine_SEQUENCE_slowFRAME_tileT/old.bin \
  --replace final_refine_new=/path/to/capture/refine_SEQUENCE_slowFRAME_tileT/new.bin
```

`--oracle` and all `--replace` arguments are optional. `--target` selects the
captured detector ID; `--oracle-id` is the original simulation oracle ID, which
can differ from a GT export slot or detector ID. Replace arguments use
`LABEL=CALAFP01_PATH`; the target ID is selected from that library, or its sole
cell is used. A GT library substitution must already be aligned to the observed
recording coordinates: inspect `gt_units.tsv` and `gt_offset.tsv` first.

`replay.json` preserves coefficients, signed background weights, losses, and
spatial identifiability measures; `replay.tsv` is the comparison table. SVD
projects out the free background and SciPy NNLS solves cell coefficients. The
numerical audit separately reproduces f32 products with f64 accumulation using
the dumped native reduced Gram, ridge inverse, projections, and frame energy.
It compares the 100-sweep/1e-2 native stopping rule with an accurate solve of
that same rounded quadratic, then with the float64, unregularized SVD solution.
Native reconstruction errors are explicit so roundoff and optimizer tolerance
can be distinguished from a substantive change in the verdict.

Built-in contrasts remove only the local bump, remove neighbour cells, compare
published versus working targets, or restore capture-time noise weights to
columns when capture-time probe snapshots are available. Each replacement also
gets a no-local-bump contrast. Probe pixels stay frozen; replacement targets use
the keep snapshot's noise weights. Other cells, background maps, bump centre,
and threshold stay fixed except for the element named by the contrast. Loss
normalization still uses each arm's measured residual variance and degrees of
freedom. Thus a target-only refinement substitution does not test a new bump
centre or predict future evidence. A better verdict in one frozen contrast is
not evidence that the corresponding detector change is safe in general.

`probe_original_frame` is a zero-based slow-loop input index: with example
`--start S`, its recording index is `S + probe_original_frame` and consumed
recording count is one larger. Keep/refine/delete `slow_frame` is instead an
observed count, whose consumed recording count is `S + slow_frame`. `--slow-start`
sets S (default 50); `--fps` sets timestamp calibration (default 20). Oracle
amplitudes use the zero-based recording index. Oracle fractions report both raw
amplitude and amplitude above the complete oracle trace's fifth-percentile
baseline; the next-two-second peak is descriptive and need not be an event peak.

The synthetic signed-background regression is included in the existing unittest
command. It skips when SciPy is unavailable, leaving NumPy-only diagnostics
usable. No recording data or frozen real probes are stored in the repository.

## Offline background comparisons

[Background experiment definitions](BACKGROUND_EXPERIMENTS.md) describe the fixed
nine-model family, units, penalties, and statistical limits. These tools compare
frozen probes and synthetic controls; they do not modify detector state or choose
a production rule. NumPy, SciPy, and Matplotlib are required for the controls.

```sh
python tools/cala-diagnostics/background_models.py /path/to/capture --out /path/to/frozen
python tools/cala-diagnostics/background_controls.py \
  --snapshots /path/to/early/keep_EVENT /path/to/late/keep_EVENT \
  --gt-footprints /path/to/run/gt_footprints.bin --gt-id 18 --out /path/to/controls
python tools/cala-diagnostics/report_background_controls.py --results /path/to/controls
python tools/cala-diagnostics/compare_keep_captures.py \
  --captures /path/to/cases --metrics /path/to/controls/metrics.tsv --out /path/to/comparison
```

For capture comparison, each immediate case subdirectory contains `capture/`,
`run/` (the evaluator outputs including exact GT exports), and `manifest.json`.
The manifest has `case` (label), `target` (detector ID), `category` (e.g.
`retained_GT` or `tentative_unexplained`), `exit_code: 0`, and
`final_footprints_identical_to_baseline: true`. Assert that last field only after
comparing the diagnostic run's final footprint bytes with its baseline. The
comparison checks these conditions, preserves per-probe GT shape agreement, and
applies one frozen threshold per model from the supplied calibration metrics.

Synthetic controls use independent spatial fields and disjoint calibration and
evaluation seeds. Candidate parameters must be fixed before heldout scoring.
Their false KEEP rates are conditional, probe-level rates for the specified
mixture, not false-cell production rates. They omit native transient-triggered
probe selection and sequential ledger history, so calibrated thresholds are not
production-ready. A pooled rate also does not guarantee protection for every
negative family. Actual probes from one cell are dependent; pass counts are
descriptive rather than independent-binomial performance estimates.

A/B defaults reproduce the developmental ID18 geometry, not independent spatial
fields. Retained matched cells chosen for transfer checks are selected survivors,
not a random population sample. `tentative_unexplained` simulation outputs are
not proven background-only controls. Penalties can improve their objective while
worsening raw residuals, so both gains must be reported. See the experiment notes
before interpreting any apparent improvement.

## Masked-background experiment

[Masked-background protocol and results](MASKED_BACKGROUND.md) describe the
exterior-fit comparison, empirical calibration, portable manifest commands,
and its negative result. The native background basis extrapolates noisily into
the footprint mask; this experiment does not change the production detector.

## Pixel noise

`PIXEL_NOISE.md` covers the fine noise in the preprocessed video and its
apparent waves, measured with `crates/cala/examples/pixnoise_eval.rs`. It
also has the ground-truth tests of spatial pre-filters and a flat field
(`CALA_PREFILTER`, `CALA_FLATFIELD` in `discover_eval` / `trace_eval`).

## Leftover light vs neuropil

`residual_after_cells.py` measures the residual a footprint set leaves, on real
data (Minian `A.zarr` or a cala `footprints.bin`) or on a minisim recording (GT
units or a cala library), the same way on both: spatial band powers in noise
units, autocorrelation, and coupling to the population drive. It needs NumPy,
SciPy, OpenCV and (for Minian) Zarr. `LEFTOVER_LIGHT.md` has the results and the
joint neighbour-trace check they led to.
