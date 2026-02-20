# Changelog

Repo-level changelog for the CaLab monorepo. Uses [Keep a Changelog](https://keepachangelog.com/) format.
Versions correspond to git tags (`v*`) and apply to the entire monorepo.

## [Unreleased]

### Changed

- Improved tutorial terminology and scientific accuracy (PR #59)

### Added

- Comprehensive README files across all packages and apps (PR #58)

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

[Unreleased]: https://github.com/miniscope/CaLab/compare/v2.0.6...HEAD
[2.0.6]: https://github.com/miniscope/CaLab/compare/v2.0.5...v2.0.6
[2.0.5]: https://github.com/miniscope/CaLab/compare/v2.0.4...v2.0.5
[2.0.4]: https://github.com/miniscope/CaLab/compare/v2.0.3...v2.0.4
[2.0.3]: https://github.com/miniscope/CaLab/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/miniscope/CaLab/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/miniscope/CaLab/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/miniscope/CaLab/releases/tag/v2.0.0
