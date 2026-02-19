# Changelog

Repo-level changelog for the CaLab monorepo. Uses [Keep a Changelog](https://keepachangelog.com/) format.
Versions correspond to git tags (`v*`) and apply to the entire monorepo.

## [2.0.4] - 2026-02-19

### Added

- Unit tests for `@calab/core` and `@calab/community` packages
- Shared `CompactHeader` component in `@calab/ui`
- `base.css` aggregate import for shared styles
- Glob-based `build-apps.mjs` and dynamic `combine-dist.mjs`
- App template (`apps/_template`) and `docs/NEW_APP.md` guide
- This changelog

### Changed

- Barrel exports trimmed to only externally consumed symbols
- CI build step uses `build:apps` instead of hardcoded app names
- App `package.json` files include `calab` metadata for build discovery

### Fixed

- `@calab/io` missing direct `valibot` dependency (phantom dep via `@calab/core`)

## [2.0.3] - 2025-02-16

### Changed

- Extracted chart logic to `@calab/compute` and shared CSS to `@calab/ui`

## [2.0.2] - 2025-02-15

### Changed

- Removed dead code: unused exports, signals, props, barrel re-exports
- Naming, import, and minor cleanup across monorepo

### Fixed

- Optimized build pipeline and CI caching

## [2.0.1] - 2025-02-14

### Fixed

- AR2 dt mismatch, ESLint rule override, CaRank missing memo
- Capitalize app names in deploy URLs (CaTune, CaRank)
- Bundle worker properly for production builds

### Changed

- Fixed 5 architecture boundary issues from codebase audit

## [2.0.0] - 2025-02-13

### Changed

- Restructured repository into monorepo with `apps/` and `packages/`
- Renamed Python package from catune to calab
