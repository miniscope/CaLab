# Changelog

Repo-level changelog for the CaLab monorepo. Uses [Keep a Changelog](https://keepachangelog.com/) format.
Versions correspond to git tags (`v*`) and apply to the entire monorepo.

## [Unreleased]

### Fixed

- **CaTune** always draws the solver's working trace (raw minus the
  rolling-percentile baseline, bandpass-filtered too when the Noise Filter is
  on) in light blue, but the legend only listed it once the Noise Filter was
  enabled, leaving an unlabeled trace that could not be hidden. The legend now
  always lists it, as "Baseline-corrected" with the filter off and "Filtered"
  with it on, and the legend's "?" popover says this is the trace the solver
  fits. **CaDecon**'s Trace Inspector uses the same rule: "Filtered" only when
  the high-pass or low-pass filter is actually on

## [2.9.0] - 2026-10-03

Web apps `v2.9.0`; Python package `calab` `py/v0.3.0`. Phase 2 of the October
2026 codebase review: the structural work that makes adding a new web app a
single command.

### Added

- **CaTune** imports MATLAB `.mat` files, using the same trace-candidate rules
  as CaDecon: 1×1 arrays are never offered, a lone matrix among vectors is
  auto-selected, and the drop text and errors list `.mat` (#218)

- **Import** `.npy` files in float16, int64/uint64 (widened to Float64), bool
  and big-endian byte order now load; they used to be rejected (#213)

- **Python** version handshake for the bridge. Results from a web app carry
  `schema_version` (required) and `solver_version` (optional), checked with
  Cargo's caret rule against what the installed `calab` reads. An incompatible
  version raises `calab.BridgeVersionError` (and the app gets HTTP 409); a
  compatible but different one warns with `calab.BridgeVersionWarning`. The
  error says which side to upgrade. The solver version is the single `version`
  in `crates/solver/Cargo.toml`, exposed as `solver_version()` in WASM and as
  `calab._solver.__version__` / `calab._solver.protocol_version()` in Python.
  CaTune and CaDecon now send `solver_version` in their bridge exports
  (#212, #215)

- **Python** the bridge has an app registry (`calab._bridge.APPS`, one
  `AppSpec` per app slug), a generic `calab._bridge.launch(slug, traces, fs)`
  that `calab.tune()` / `calab.decon()` now wrap with unchanged signatures, and
  generic `POST /api/v1/results/{app}[/{array}]` routes. It reads the deployed
  site's `apps.json` (2 s timeout, fetched once per process), so a pinned
  `calab` follows renamed app paths and can tell you to upgrade for an app newer
  than itself; offline it falls back to the built-in registry.
  `CALAB_APPS_MANIFEST` points it at another manifest URL or turns it `off`
  (#212, #217)

- **Site** `apps.json`, a manifest of the published apps (id, display name,
  path, description, status, plus the release and commit), at the root of the
  GitHub Pages site. It is generated from each app's `package.json` `calab`
  block; `scripts/check-apps-manifest.mjs` fails CI and `build:pages` if it is
  missing or stale (#217)

- **Packages** `@calab/vite-config`: `defineCalabApp(appDir, { wasm })` is an
  app's whole Vite/Vitest config, so each `vite.config.ts` is three lines, and a
  root `tsconfig.app.json` replaces the per-app paths and references. App
  identity is `calab.id` in the app's `package.json`, injected as the build-time
  `__APP_ID__` and validated against a slug regex (#211)

- **Packages** `@calab/community-ui`, holding the community and auth widgets
  that used to be in `@calab/ui` (`AuthGate`, `CommunityBrowserShell`,
  `FilterBar`, `SubmitFormModal`, ...), plus the widgets hoisted from the apps:
  `SubmitForm` + `createSubmitFormFields`, `CommunityScatterPlot`,
  `FeedbackMenu`, `GroundTruthControls` and the submission payload builder
  (`buildBaseSubmissionPayload`, `toCommunityDataSource`) (#215, #218)

- **Packages** `createImportStore()` in `@calab/io` and the `@calab/ui/import`
  components (`ImportOverlay`, `FileDropZone`, ...): the import flow CaTune and
  CaDecon each kept a copy of. Shared app CSS moved to
  `@calab/ui/styles/app-global.css` and `app-controls.css` (#218)

- **Packages** `@calab/core/wasm` entry point: the solver adapter (`initWasm`,
  `Solver`, `solver_version`, the new `getSolverVersion()`, ...) is no longer in
  the `@calab/core` barrel, so importing types or math never bundles the WASM
  glue (#215)

- **Tooling** `npm run dev [app]` starts any app's dev server by directory name,
  `calab.id` or display name (default CaTune), running the WASM `predev` step
  that `npm run dev -w apps/<name>` skips (#217)

- **Tooling** `apps/_template` is now a minimal real app (auth callback,
  analytics session, import flow, chart, real test), and
  `npm run new-app -- <id> <DisplayName> [--wasm]` scaffolds a new app that
  runs, tests, builds and appears on the landing page and in `apps.json` with
  no further edits. CI runs the scaffolder end to end on every push (#219)

- **Tests** Playwright smoke test per app (`e2e/`), run against the production
  build in headless Chromium: CaTune's demo data solves, a CaDecon run reaches
  "Complete" and paints its raster, CaRank ranks an imported `.npy`, Admin's
  auth guard holds, and the landing page and `apps.json` list every app. Any
  console error, 4xx/5xx response or off-site request fails the test. Run with
  `npm run build:e2e && npm run test:e2e`; see `e2e/README.md` (#216)

- **Tests** degenerate-input sweeps over every FFI entry point: Rust
  (`solver_degenerate.rs`, `ffi_surface.rs`, and `proptest` property tests),
  pytest (`test_degenerate_inputs.py`, with an inventory test that fails if a
  new export is not swept) and WASM (`wasm-degenerate.test.ts`, against the
  real build). Parser tests cover every dtype, truncation at every byte, random
  corruption and zip/zlib bombs (#213)

- **CI** coverage: `npm run test:coverage` merges V8 coverage across workspaces
  and fails if a package drops below its floor (core, io, compute, community,
  ui, community-ui); the report is uploaded as `coverage-lcov`. New `e2e` job.
  `check:app-tests` fails if an app has no `test` script, which `npm test`
  would otherwise skip silently (#210, #216)

### Changed

- **Import** `.npz` and `.mat` decompression is capped at 1 GiB by default
  (`DEFAULT_MAX_DECOMPRESSED_BYTES`); larger archives throw
  `DecompressedSizeLimitError`. The `.npz` check runs on declared sizes before
  allocating, so a forged header is rejected up front, and `.mat` inflates in a
  stream that stops at the cap. `parseNpz` / `parseMat` take
  `{ maxDecompressedBytes }` to raise it. Parser error text no longer names
  CaTune or CaDecon (#213)

- **Community** a non-numeric "time since injection" or "imaging depth" is now
  dropped from a CaTune submission instead of being stored as `NaN` (#218)

- **CaTune** the λ legend in the community scatter plot reads `0` / `10`
  instead of `0.0e+0` / `10.000`, and when every point coincides the axis pads
  by 10% of the value (1 ms at zero) instead of collapsing (#218)

- **Python** bridge behaviour changes: a result payload without
  `schema_version` is rejected; the legacy routes (`/api/v1/params`,
  `/api/v1/results`, `/api/v1/results/activity`) accept results only for their
  own app (`/api/v1/params` on a CaDecon session now returns 404 instead of
  being stored and ignored); `BridgeServer(app=...)` rejects unknown slugs
  (#212)

- **Python** `calab.compute_lipschitz` raises `ValueError` for an empty, NaN or
  infinite kernel; it used to return `1e-10` (empty/NaN) or `inf` (#214)

- **Solver** biexponential fits reject a non-physical warm start: warm taus must
  satisfy `0 < tau_rise < tau_decay`, and the fast pair must be absent (both 0)
  or satisfy the same, else `ValueError` / a thrown `Error`. Feeding a previous
  fit back in always passes (#214)

- **Solver** `get_spectrum_frequencies()` always has the same length as
  `get_power_spectrum()`: empty with no trace or fewer than 8 samples (it
  returned `[NaN]`, or bins with no matching spectrum) (#214)

- **Supabase** analytics sessions validate `app_name` by shape, not by a list
  of apps: migration `015_app_name_slug_check.sql` replaces the `IN (...)`
  check with the regex `^[a-z][a-z0-9_-]{1,31}$`, and the `geo-session` edge
  function returns 400 for a malformed name. A new app's analytics no longer
  need a migration (#211)

- **CaRank** no longer ships the WASM solver: its `dist/` drops from 860 KB to
  348 KB (#215)

- **Community** importing `@calab/community` has no side effects. The auth
  subscription starts on `initCommunityStore()` (called in each app's
  `index.tsx`) or on the first `user()` / `authLoading()` read, so each app has
  exactly one auth subscription; CaRank, CaDecon and Admin used to open a
  second (#215)

- **Packages** `@calab/ui` no longer depends on `@calab/community`; an ESLint
  boundary keeps it that way. Code only one app uses moved into that app:
  CaTune's worker pool, worker protocol, export builder and export schema.
  There is one app-side `DataSource` (`'file' | 'demo' | 'bridge'`, in
  `@calab/core`) and one conversion to the stored vocabulary,
  `toCommunityDataSource` (#215, #218)

- **Tooling** ESLint 10, eslint-plugin-solid 0.18, Prettier 3.9 and Vitest 5
  (Vite stays on 7, TypeScript on 5). Dependabot updates these lint/build
  packages together in one `lint-build-toolchain` group (#210)

- **CI** the tag deploy now needs the same `rust`, `python`, `supabase` and
  `e2e` jobs as CI, not just the TypeScript checks, so a tag cannot deploy a
  commit CI would reject. `publish-python.yml` gains the `rust` job and a
  no-cancel concurrency group. The Pages output directory and upload path come
  from the repository name, so a fork or rename deploys correctly
  (#210, #216, #217)

- **Docs** README and CONTRIBUTING list `@calab/community-ui`,
  `@calab/vite-config`, `apps/admin`, `apps/_template` and `e2e/`, drop the
  path-alias instructions (packages resolve through `package.json` `exports`),
  and document Playwright, coverage and the e2e scripts.
  `python/docs/guides/bridge.md` documents the app manifest (#217)

### Removed

- **Tooling** the `dev:carank`, `dev:cadecon` and `dev:admin` root scripts; use
  `npm run dev carank` (etc.) instead (#217)

### Fixed

- **Python** `simulate_traces` could **abort the Python interpreter** (a Rust
  out-of-memory abort, SIGABRT; in the browser, a WASM trap) when given a huge
  `tau_decay_s` such as a units mistake, and overflowed on `fs_hz = 0` or an
  oversized cells × timepoints. Simulation input is now validated before
  anything is allocated, in both bindings, and raises `ValueError` / throws an
  `Error`. `tau_rise_s = 0` (NaN traces) and reversed taus (negative calcium)
  are rejected too, and extreme per-cell tau draws are clamped (#213)

- **Import** a 0-d `.npy` array counts as one element (it read as zero); a
  truncated last variable in a `.mat` file is reported instead of silently
  dropped; and corrupt `.mat` offsets raise "Not a valid .mat file" instead of
  a bare `RangeError` (#213)

- **Charts** dragging an edge of the trace overview's selection clamped against
  the total duration read at drag start rather than its current value (#210)

## [2.8.0] - 2026-10-02

### Added

- **Core** WASM ↔ native parity test. Until now no TypeScript test loaded the
  WASM build of the solver (all of them mock it), and nothing compared its
  output with the native build. `packages/core` now loads the real
  `crates/solver/pkg` through `initWasm` and asserts it reproduces the native
  golden fixtures in `python/tests/fixtures/` — same iteration counts, and
  kernel, filtered trace, solution, baseline and reconvolution within
  `atol=rtol=1e-4` (observed max difference 1.4e-5). The fixtures README now
  lists all five fixtures and the tolerances each consumer actually uses; the
  CaTune `smoke.test.ts` is renamed to `kernel-shape-roundtrip.test.ts`, which
  is what it tests

### Changed

- **Tooling** `npm run typecheck` now discovers every `apps/*` and `packages/*`
  project instead of a hardcoded list. `ensure-wasm` checks up front for
  `cargo`/`wasm-pack` and prints install steps. `rust-toolchain.toml` requests
  the `wasm32-unknown-unknown` target. Added `dev:cadecon` / `dev:admin`, and
  the setup docs now list the real prerequisites (Rust + wasm-pack are required).

- **CI** tokens are read-only by default (Pages/OIDC grants only on the jobs
  that publish). Superseded CI runs are cancelled. Clippy covers all targets
  and the `pybindings` feature set. Dependabot is enabled, and its first
  round of safe bumps is merged: GitHub Actions majors (checkout, setup-node,
  setup-python, cache), serde patches, `@types/node` 26 and jsdom 30
  (#195, #198-#203, #206)

- **README** the "no data upload" claim now states precisely what is collected:
  trace data never leaves the browser, anonymous usage analytics are collected
  via Supabase, and community sharing is explicit and opt-in

### Fixed

- **Solver** the FISTA solve depended on how often the UI polled the fit.
  The display getters (`get_reconvolution`, `get_reconvolution_with_baseline`,
  `get_baseline`) overwrote the scalar baseline that `step_batch` adds into the
  residual, and CaTune (which always subtracts a rolling baseline, so the solver
  never re-estimates it) polls those getters every 100 ms. Results therefore
  varied with wall-clock timing, and `load_state` restored the leaked value so
  warm and cold starts disagreed. The display baseline is now a separate,
  display-only EMA; the solver's baseline is pinned to 0 for filtered traces.
  **CaTune deconvolved activity can change** slightly versus earlier builds;
  results are now deterministic for a given trace and parameters

- **Python** `run_deconvolution_full` (and `deconvolve_single`/`deconvolve_batch`)
  returned `baseline` and `reconvolution` relative to the internally
  rolling-baseline-subtracted trace, contradicting the `DeconvolutionResult`
  docs. They are now in the input trace's frame: `reconvolution` is the full
  model fit including the removed slow baseline, and `baseline` is in input
  units (≈ the offset for a trace with a constant DC offset). **`baseline`
  values change** for any trace with a non-zero floor; `activity` is unchanged.
  Also: list input is accepted and non-1-D/2-D input raises a clear
  `ValueError` (was `AttributeError`); a missing compiled extension raises an
  `ImportError` explaining how to install or build it; the long-running solves
  release the GIL; and the `refine` (`fit_biexponential`) and `box01`
  (it keeps the L1 penalty; use `lam=0` for the pure box) docs now match the
  code

- **Solver** invalid input no longer traps the WASM module or panics the
  Python extension. A single validation layer (`crates/solver/src/validate.rs`),
  shared by both bindings, rejects non-finite traces/arrays, `fs <= 0`,
  `tau_rise >= tau_decay` (FFT and banded modes previously built opposite-sign
  kernels), negative `lambda`, `upsample_factor = 0`, negative or overflowing
  trace lengths, `kernel_length = 0`, and kernels above 2^20 samples (which
  used to abort on allocation). Also fixed: a longer kernel set after
  `set_trace` in FFT mode panicked on the next `step_batch`; toggling HP/LP after
  an `apply_filter` on a same-length trace reused the stale gain curve; an empty
  threshold search reported a NaN baseline; realfft errors `unwrap()`ed instead
  of propagating. **JS:** `Solver.set_params`, `Solver.set_trace`,
  `Solver.step_batch`, `indeca_solve_trace`, `indeca_estimate_kernel`,
  `indeca_fit_biexponential`, `indeca_compute_upsample_factor`, `seed_trace`,
  `simulate_traces` and `get_simulation_presets` now throw on invalid input or
  serialization failure instead of trapping or returning `null`. **Python:** the
  same cases raise `ValueError` (numerical failures `RuntimeError`)

- **Solver** `set_params` spent O(K²) on a direct DFT to compute the Lipschitz
  constant (~0.7 s at K≈13.8k kernel samples). For the non-negative kernels the
  solver builds, `max|H(ω)| = H(0)`, so `L = (Σh)²` is now computed in O(K); the
  DFT remains the fallback for kernels with negative taps

- **CaTune / CaDecon** a solver worker whose WASM failed to initialize only
  logged to the console, so its jobs queued forever: CaTune cells showed
  "solving" indefinitely and a CaDecon run never finished. Workers now report
  init failures to the pool, which also handles `onerror`/`onmessageerror`. A
  failed worker's in-flight job fails; a worker that dies after starting is
  replaced once. If every worker dies, all pending jobs fail and the app shows
  an error message. Disposing the pool now settles in-flight jobs as cancelled
  instead of leaving their callers waiting

- **CaDecon** a run could get stuck or finish with made-up numbers. Any
  exception in the run loop left the run state at "running" with no message.
  A Reset while stopping could let the abandoned loop resume and dispatch onto
  a disposed pool. If every solver job failed, the run quietly fell back to
  τ_rise=0.2 s / τ_decay=1.0 s and reported "complete". The run now always ends
  in a terminal state. A new **error** state shows the reason under the run
  controls, and the pool is disposed on every exit. A run aborts when more than
  half of any phase's jobs fail; smaller failure counts are shown as a warning.
  Reset during a run (including while stopping or paused) abandons it cleanly.
  The trace/kernel FISTA settings are now read once at run start like every
  other run parameter, and Stop during the seed traces no longer runs the seed
  kernel phase first

- **CaTune, CaDecon** the residual trace in the zoom charts subtracted two
  independently min/max-downsampled series, so once a window held more than
  2× the chart's bucket count (>1200 samples in the CaDecon Trace Inspector;
  high sampling rates or zoomed-out CaTune cards) it paired one series' bucket
  minimum with the other's maximum and drew spurious residual spikes. The
  residual is now computed at full resolution and downsampled afterwards. The
  band layout and residual math shared by both charts now live in
  `@calab/compute` (`computeBandLayout`, `scaleToBand`, `residualBandSeries`)

- **Charts** `downsampleMinMax` emitted `Infinity, -Infinity` for a bucket with
  no finite sample (e.g. an all-NaN stretch), breaking uPlot's autoscale. Such
  buckets are now `null` gaps; non-finite samples are skipped within mixed
  buckets and returned as `null` when no downsampling is needed

- **Import** the partial-NaN validation warning claimed "CaTune will skip NaN
  values during deconvolution"; nothing skips them. It now says the solver does
  not support NaN/Inf samples, that affected cells will fail to solve, and to
  interpolate over or remove them before importing. It remains a warning, so
  files whose other cells solve still import

- **CaTune** moving a parameter slider orphaned every cell's in-flight solver
  job instead of cancelling it: the job ran its full quantum, its result was
  discarded, and with more cells than workers the orphans queued ahead of the
  fresh jobs. On initial load every cell's first quantum was also solved twice.
  Superseded jobs are now cancelled on the first tick of a parameter change,
  and the parameter watcher no longer fires on mount

- **CaDecon** the bi-exponential kernel fit reported **cold-grid preset values**
  for `tau_rise`/`tau_decay` instead of measured ones. `golden_bracket` returned
  the midpoint of its narrowed interval — a point it never evaluated and never
  compared against the value it was asked to improve — so on the non-unimodal
  two-component objective a refinement step could move uphill,
  `golden_section_refine` drifted, `refine_candidate` discarded the whole
  refinement, and the raw grid node was reported. The next iteration warm-started
  from that node and repeated. `golden_bracket` now seeds from the incumbent,
  tracks the best point it actually evaluated, and can never return worse than
  its input; the fixed 10 iterations become a relative-width tolerance.

  **Reported time constants change.** Measured against synthetic ground truth,

  recovered `tau_decay` error improves from 0.5% to 0.0% on the single-component

  fixture and 0.4% to 0.05% on the two-component fixture. For values falling

  between grid nodes the pre-fix error reached 12.88% (the grid's worst case);

  results produced before this release are quantised to the 20 cold-grid nodes

  and are not comparable with results produced after it (PR #176)

- **CaDecon** `tau_rise` refinement was not clamped to the grid's upper bound,
  unlike every other refined coordinate, so a warm-started value could compound
  past the 0.5 s ceiling the grid searched (PR #176)

- **CaDecon** the log-scaled asymptote axis could hang mid-render. uPlot's
  `logAxisSplits` can loop without terminating on valid bounds — crossing a
  decade sets a non-canonical increment that is missing from its internal
  decimal map, the tick then rounds to zero, and the loop never exits — throwing
  `RangeError: Invalid array length` and killing the page. Replaced with a
  bounded `logSplits` (PR #176)

### Security

- Resolved all 22 `npm audit` findings (2 critical, 12 high) with in-range
  updates, including vite 7.3.6 (dev-server path traversal) and seroval (Solid
  transitive). Bumped solid-js 1.9.15, valibot 1.5, @supabase/supabase-js 2.117,
  driver.js 1.8, vitest 4.1, eslint 9.39.5, typescript-eslint 8.71; root
  `package.json` now declares `engines.node >= 22`

- **Supabase** the community `catune_submissions_public` and
  `cadecon_submissions_public` views (migration 010) run with their owner's
  privileges and are auto-updatable, and Supabase's default privileges grant
  `anon`/`authenticated` ALL on new views, so anyone holding the public anon key
  could insert forged submissions or rewrite/delete every submission through
  them, bypassing RLS. Migration 011 revokes everything but `SELECT` on both
  views. The RLS test harness now mirrors Supabase's real default grants, and
  `assert_denied` requires a specific SQLSTATE instead of accepting any error

- **Supabase** anonymous-auth visitors (every app signs in anonymously at load
  for analytics) carry the `authenticated` role and could post community
  submissions without ever entering an email. Migration 012 requires
  `is_anonymous = false` in the JWT for submission inserts; `subscribeAuth`
  and `AuthGate` now treat anonymous sessions as signed out, so the email
  sign-in prompt is shown

- **Supabase** clients could insert `analytics_sessions` rows directly and
  choose `country_code`, `region`, `is_anonymous`, `created_at`, and rewrite
  any column of their own sessions. Migration 013 makes the geo-session edge
  function the only way to create a session, restricts client updates to
  `ended_at`/`duration_seconds`, and caps each session at 500 events

- **Supabase** submission columns other than the kernel parameters were
  unvalidated server-side: negative counts, `NaN`/`Infinity` floats, unbounded
  text, and an unbounded `extra_metadata` that is republished to every visitor.
  Migration 014 adds length caps, two-sided finite range checks, an ORCID
  format check and a 4 KB `extra_metadata` cap, and aligns CaTune's
  `lambda`/`sampling_rate` minimums with the client. Constraints are added
  `NOT VALID`; existing rows must be checked and the constraints validated
  manually

## [2.7.2] - 2026-08-27

### Fixed

- **Community** the simulated indicator is now recorded on submission so the
  demo filter matches (PR #177)

### Changed

- CI builds abi3 wheels for the Python package, repairs the publish matrix, and
  smoke-tests the result (PR #175)

## [2.7.1] - 2026-08-21

### Added

- **CaDecon** MATLAB `.mat` file import — `parseMat` in `@calab/io` lets the
  CaDecon GUI accept `.mat` alongside `.npy`/`.npz` (PR #170)
- **CaDecon** results export — a download button producing a `.zip` containing
  the activity traces (`.npy`, `.npz`, or `.mat`, matching the input file type)
  and a JSON of run parameters, enabled once a run completes (PR #172)

### Fixed

- Solver: use `isolate_lowest_one` in the Fenwick tree update (PR #171)
- **CaDecon** trace-array selection is now meaningful for `.mat` imports (PR #170)

## [2.7.0] - 2026-07-23

### Changed

- **CaDecon** kernel-RMSE convergence metric and reworked asymptote dashboard —
  convergence is tested on the peak-normalized RMSE between successive
  iterations' bi-exponential kernels, which avoids the previous
  (peak time, FWHM) delta's over-sensitivity to jitter on the poorly-constrained
  rising edge (PR #169)

## [2.6.0] - 2026-07-08

> Covers every change since `v2.5.0` (PR #168).

### Added

- **CaDecon** noise-constrained sparsity — an optional `noise_constrained`
  spike-inference mode that picks the binarization threshold as the sparsest
  spike support whose residual still reaches the data-derived noise floor,
  instead of the fit-maximizing threshold. Knob-free and off by default;
  suppresses spurious low-SNR spikes. Exposed through the WASM solver, the
  CaDecon UI, and the `calab.solve_trace` Python binding (PR #168)

## [2.5.0] - 2026-07-08

> Covers PRs #153–#167 (all merged 2026-07-08).

### Added

- **CaDecon** bi-exponential fit outcome surfaced as `FitMode`
  (`TwoComponent` / `SlowOnly` / `Degenerate` / `Empty`) on the kernel result;
  Python `fit_biexponential` now returns an 8-tuple (trailing `fit_mode` string)
  and `BiexpFitResult` gained a `fit_mode` field; KernelDisplay warns when
  subset fits are degenerate (PR #162)
- **CaDecon** convergence redesign — converge in kernel **shape space** (peak
  time + FWHM asymptote) with median-tail kernel selection and both filters on
  by default (PR #154), plus an **asymptote dashboard** charting the four
  convergence signals (PR #155)
- Shared uPlot chart primitives in `@calab/ui/chart` — colorblind-safe
  Okabe-Ito palette (`TRACE_COLORS`, `GROUND_TRUTH_COLORS`, `KERNEL_FIT_COLORS`,
  `METRIC_COLORS`, `subsetColor`), viridis colormap (`VIRIDIS_LUT`,
  `viridisRGB`/`viridisCss`), tick math (`niceTicks`), and axis/cursor/range
  helpers (`chartAxis`, `labeledAxis`, `syncCursor`, `safeRange`) (PRs #158, #159, #160)

### Changed

- **CaDecon** raster overview uses the shared viridis colormap and drops the
  intensity colorbar (activity is assumed to span 0→full; absolute values are
  not meaningful) (PR #159)
- `calab-solver` tuning-constant hygiene: introduced `SeedConfig`, shared
  `baseline::DEFAULT_BASELINE_QUANTILE`, and a named `BASELINE_EMA_WEIGHT`;
  deduplicated the bi-exponential fast-component grid bounds so the grid search
  and golden-section refinement cannot drift (no behavior change) (PR #163)
- Tooling: ignore local Python virtualenvs `.venv*/` (PR #156)
- Documentation: reconciled repo docs with the CaDecon review series (PR #164),
  aligned the CaDecon tutorials with it (PR #165), and backfilled the changelog
  from git history (PR #167)

### Fixed

- `calab-solver` FFI boundaries (WASM and PyO3) reject non-finite (NaN/Inf)
  input traces with an explicit error instead of returning garbage results
  (PR #161)
- Solver: banded AR(2) forward model aligned via a one-sample source delay so
  the reconvolution matches the double-exponential kernel (PR #157)
- CaDecon: correct per-subset kernel attribution + init/variance robustness
  (PR #153)

## [2.4.0] - 2026-03-20

> Covers the entire 2.4.x line (PRs #99–#152). Reconstructed from git history;
> closely-related PRs are consolidated into single bullets for readability.

### Added

- **`calab` Python package** — CaDecon Python bridge with config, autorun,
  progress, and auto-export (PRs #108, #109); headless-browser batch mode +
  InDeCa PyO3 bindings (PR #110)
- Shared Rust **simulation module** producing synthetic ground-truth traces,
  exposed to both Python and WASM (PR #113)
- Solver: peak-seeded initial-kernel auto-estimation (PR #103); an independent
  fast component in the bi-exponential fit (PR #105); a `skip` parameter for
  bi-exponential fitting (PR #99)
- Migrated the kernel parameterization from (tau_rise, tau_decay) to
  (t_peak, FWHM) (PR #104)
- CaDecon tutorial set (PR #151)
- Draggable minimap edges on the trace overview (PR #145)
- Sphinx + ReadTheDocs documentation site for the Python package (PR #115)

### Changed

- Performance: CaDecon iteration hot paths (PR #107); solver
  cleanup/dedup/optimize (PR #106); snappier Peak/FWHM slider drag (PR #134)
- Tooling: ESLint/Prettier/lint-surface cleanup (PR #120); prune unused exports
  and internalize test-only surface (PR #125); bump GHA for Node 24 and clear
  reactivity lint (PR #133); gitignore the whole `.claude/` directory (PR #135)
- CI: Rust + Python lint/type jobs, a build matrix, and SHA-pinned actions
  (PR #124)
- Tests: smoke / export-roundtrip / sub-frame-timing / warm-start quick-wins
  (PR #127); CaDecon iteration-manager state transitions (PR #128); iteration-
  store & multi-cell-store reactivity (PR #129); geo-session edge function +
  RLS policy matrix (PR #130); bridge timeout & mid-run crash detection (PR #131)
- Documentation: separated CaTune and CaDecon into dedicated guides (PR #117);
  promoted CaDecon to stable + root README update (PR #118); reviewed/improved
  all Python docs (PR #116)

### Fixed

- Address pre-merge audit findings — WASM drift, RLS PII, FFI panics, config,
  tests (PR #150)
- Solver: corrected a binning-induced time offset in iterative kernel fitting
  (PR #102); golden-section refinement bug fix (PR #147)
- CaTune: GT marker alignment + spectrum/zoom-window perf sweep (PR #142);
  repair tutorial highlighting after the Peak/FWHM migration (PR #143)
- Headless: prevent resource leaks on browser start/close failures (PR #121)
- Logic + UX polish — tau constraints, bridge errors, reactivity (PR #126)
- Community: show bridge/training submissions and hide demo presets under
  User data (PR #152)
- CI deploy: bump the install-action pin to fix a wasm-pack 404 (PR #148)

### Security

- Hardened the bridge URL, added localhost bridge auth, and secured the
  geo-session edge function (PR #122)
- Locked down analytics row-level security (PR #123)

## [2.3.0] - 2026-02-26

> Covers the entire 2.3.x line (PRs #85–#96). Reconstructed from git history.

### Added

- **CaDecon** — a new app for automated calcium deconvolution (the InDeCa
  algorithm) that estimates the kernel and deconvolution parameters directly
  from the data, no manual tuning required: app scaffold + data loading +
  subset UI, the InDeCa compute engine with warm-start, visualization / QC
  distributions / drill-down, community-database integration, and ground-truth
  overlay (PRs #85, #86, #87, #88, #90, #91)
- Usage analytics extended to track CaDecon submissions (PR #93)

### Changed

- CaDecon left-sidebar layout/UX (PR #89); convergence-UI improvements and
  kernel-estimation groundwork, including rise-time-collapse mitigation (PR #94)
- CaTune: log-scale DualRangeSlider, card-grid fix, tutorial baseline docs (PR #96)
- Performance: FISTA pipeline (SIMD, loop fusion, Fenwick baseline) (PR #92)

### Fixed

- Solver: alpha/PVE double-counting and energy-pooling correctness (PR #91)

## [2.2.0] - 2026-02-23

> Covers the entire 2.2.x line (PRs #65–#84). Reconstructed from git history.

### Added

- **`calab` Python package** greatly expanded — PyO3 bindings, CaImAn/Minian
  loaders, browser bridge, and a CLI (PR #66)
- Community: DataSource tracking + bridge export button & heartbeat detection
  (PR #67)
- Solver: banded AR(2) O(T) convolution + box constraint (PR #78)
- Dynamic worker-pool scaling with a URL override (PR #77)
- Admin dashboard: analytics breakdowns and bulk moderation (PR #69)
- Chart/UX: transient-zone visual indicator (PR #81)
- Tutorials: Python Package tutorial (PR #68); Python syntax highlighting in
  code blocks (PR #75)

### Changed

- Moved the Rust solver to `crates/solver/` with dual WASM (`jsbindings`) /
  PyO3 (`pybindings`) Cargo features (PR #65)
- Replaced the export-to-Python page with a dismissible modal (PR #79)

### Fixed

- CaTune: minimap no longer pushes the zoom window off-screen (PRs #70, #82);
  clamp rise/decay sliders to prevent a negative kernel (PR #83)
- Analytics: reliable session-duration tracking via heartbeat (PR #84)

## [2.1.0] - 2026-02-20

> Covers the 2.0.8, 2.0.9, and 2.1.x patch line (PRs #58–#64). Reconstructed
> from git history.

### Added

- **Usage-analytics pipeline + admin dashboard** (PR #62)
- Shared **auth menu** in the header across all CaLab apps (PR #61)
- Community: highlight your own submissions in the scatter plot (PR #63)
- Comprehensive README files across all packages and apps (PR #58)

### Changed

- Made `@calab/community` app-agnostic (PR #60)
- Documentation: improved tutorial terminology and scientific accuracy (PR #59)

### Fixed

- Codebase-wide quality sweep — 26 fixes (PR #64)

## [2.0.6] - 2026-02-19

### Changed

- Extracted `FftConvolver` from Solver to enable split borrows in Rust WASM (PR #56)
- Replaced AR model reference with double-exponential time constants in CaTune description

### Fixed

- Consistent CaLab version display across all pages (PR #57)

## [2.0.5] - 2026-02-19

### Added

- Screenshots and version superscript to landing page (PR #55)

### Changed

- Extracted shared `Card`, `CardGrid`, and `Tutorial` components to `@calab/ui` (PR #54)
- Renamed package scope from `@catune` to `@calab` (PR #53)

## [2.0.4] - 2026-02-19

### Added

- Unit tests for `@calab/core` (~48 tests) and `@calab/community` (~22 tests) (PRs #48, #49)
- Shared `CompactHeader` component in `@calab/ui` (PR #50)
- `base.css` aggregate import for shared styles
- Glob-based `build-apps.mjs` and dynamic `combine-dist.mjs` for app auto-discovery (PR #51)
- App template (`apps/_template`) and `docs/NEW_APP.md` guide (PR #52)
- This changelog

### Changed

- Barrel exports trimmed to only externally consumed symbols (PR #47)
- CI build step uses `build:apps` instead of hardcoded app names

### Fixed

- `@calab/io` missing direct `valibot` dependency (phantom dep via `@calab/core`) (PR #47)

## [2.0.3] - 2026-02-18

### Changed

- Extracted chart logic to `@calab/compute` and shared CSS to `@calab/ui` (PR #46)
- Removed dead code — unused exports, signals, props, barrel re-exports (PR #45)
- Naming, import, and minor cleanup across monorepo
- Fixed 5 architecture boundary issues from codebase audit
- Optimized build pipeline and CI caching

### Fixed

- AR2 dt mismatch, ESLint rule override, CaRank missing memo (PR #45)

## [2.0.2] - 2026-02-18

### Fixed

- Capitalize app names in deploy URLs (CaTune, CaRank)

## [2.0.1] - 2026-02-18

### Fixed

- Bundle worker properly for production builds

## [2.0.0] - 2026-02-18

Major restructuring into a monorepo with reusable packages.

### Added

- `@calab/core` — WASM adapter, export schema, types (PR #42, #43)
- `@calab/compute` — worker pool, warm-start cache (PR #43)
- `@calab/io` — file parsers, validation, export (PR #43)
- `@calab/community` — Supabase DAL, submission logic (PR #43)
- `@calab/tutorials` — tutorial definitions, progress persistence (PR #43)
- `@calab/ui` — DashboardShell, DashboardPanel, VizLayout (PR #44)
- **CaRank** app — trace quality ranking with file import and SNR ranking (PR #44)
- Multi-app build pipeline with `combine-dist` script and base paths
- npm workspaces monorepo structure (PR #42)

### Changed

- Moved CaTune app into `apps/catune/` workspace
- Renamed Python package from `catune` to `calab`
- Renamed repo references from CaTune to CaLab
- Stabilized tooling and codified conventions (Prettier, ESLint, CI) (PR #41)

[2.6.0]: https://github.com/miniscope/CaLab/compare/v2.5.0...HEAD
[2.5.0]: https://github.com/miniscope/CaLab/compare/v2.4.10...v2.5.0
[2.4.0]: https://github.com/miniscope/CaLab/compare/v2.3.8...v2.4.10
[2.3.0]: https://github.com/miniscope/CaLab/compare/v2.2.7...v2.3.8
[2.2.0]: https://github.com/miniscope/CaLab/compare/v2.1.2...v2.2.7
[2.1.0]: https://github.com/miniscope/CaLab/compare/v2.0.6...v2.1.2
[2.0.6]: https://github.com/miniscope/CaLab/compare/v2.0.5...v2.0.6
[2.0.5]: https://github.com/miniscope/CaLab/compare/v2.0.4...v2.0.5
[2.0.4]: https://github.com/miniscope/CaLab/compare/v2.0.3...v2.0.4
[2.0.3]: https://github.com/miniscope/CaLab/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/miniscope/CaLab/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/miniscope/CaLab/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/miniscope/CaLab/releases/tag/v2.0.0
