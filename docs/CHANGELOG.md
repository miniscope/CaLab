# Changelog

Repo-level changelog for the CaLab monorepo. Uses [Keep a Changelog](https://keepachangelog.com/) format.
Versions correspond to git tags (`v*`) and apply to the entire monorepo.

## [Unreleased]

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

- **README** the "no data upload" claim now states precisely what is collected:
  trace data never leaves the browser, anonymous usage analytics are collected
  via Supabase, and community sharing is explicit and opt-in

### Fixed

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
