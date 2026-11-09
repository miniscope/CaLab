# Cala discovery diagnostics

These tools inspect `discover_eval` runs without changing discovery algorithms.
Run from the repository root. Python 3.10+ and NumPy are required for trajectory
analysis; Matplotlib is optional for PNG/PDF plots; Zarr is optional for the Minian
comparison. The small benchmark additionally needs the pinned Minisim environment
described in `tools/minisim-calibration/README.md`. Its legacy e33edad pin is
outdated for the current scatter exporter. The validated benchmark used Minisim
01a9ce2 (exporter needs c243+); preserve the actual installed revision.

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
