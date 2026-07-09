# Changelog

Repo-level changelog for the CaLab monorepo. Uses [Keep a Changelog](https://keepachangelog.com/) format.
Versions correspond to git tags (`v*`) and apply to the entire monorepo.

## [2.6.0]

> Unreleased. Covers every change since `v2.5.0` (PR #168).

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
