# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-10)

**Core value:** Neuroscientists can interactively tune deconvolution parameters on their own calcium imaging data, see immediate visual feedback of fit quality, and learn the tuning workflow through progressive guided tutorials -- all in the browser with zero setup.
**Current focus:** Phase 3 - Visualization

## Current Position

Phase: 3 of 8 (Visualization)
Plan: 1 of 2 in current phase
Status: In Progress
Last activity: 2026-02-11 -- Completed 03-01 (Chart Infrastructure)

Progress: [█████-----] 1/2 Phase 3

## Performance Metrics

**Velocity:**
- Total plans completed: 7
- Average duration: 5 min
- Total execution time: 33 min

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-data-foundation | 3/3 | 8 min | 3 min |
| 02-wasm-solver | 3/3 | 22 min | 7 min |
| 03-visualization | 1/2 | 3 min | 3 min |

**Recent Trend:**
- Last 5 plans: 02-01 (13 min), 02-02 (6 min), 02-03 (3 min), 03-01 (3 min)
- Trend: 03-01 fast (pure TypeScript utilities + component, no build toolchain issues)

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap]: Custom ISTA solver in Rust over OSQP-WASM (per research recommendation)
- [Roadmap]: Transferable ArrayBuffer ping-pong for worker communication (GitHub Pages cannot serve COOP/COEP headers for SharedArrayBuffer)
- [Roadmap]: Phases 2 (solver) and 3 (visualization) can develop in parallel
- [01-01]: Manual project scaffold instead of npm init solid for precise Vite 7 version control
- [01-01]: Individual SolidJS signals (createSignal) instead of createStore for linear import flow
- [01-01]: jsdom added as devDependency for Vitest DOM test environment
- [01-02]: Zero-copy typed array view with copy fallback for unaligned offsets
- [01-02]: Regex header parsing for .npy Python dict literals (no eval/Function)
- [01-02]: Big-endian rejection with helpful message rather than byte-swapping
- [01-02]: Negative values tracked in stats but no warning (deltaF/F can be negative)
- [02-01]: DFT-based Lipschitz constant instead of sum-of-squares (operator norm, not Frobenius norm)
- [02-01]: FISTA with adaptive restart (O'Donoghue & Candes 2015) to prevent oscillation with non-negativity
- [02-01]: Two-sequence FISTA formulation (x_k proximal, y_k extrapolated) for correct convergence
- [02-01]: Homebrew gcc-15 as C linker for Rust native tests (WSL2 lacks build-essential)
- [02-02]: Disabled wasm-opt (bundled version incompatible with Rust 1.93 bulk-memory ops)
- [02-02]: LIBRARY_PATH env var for wasm-pack host-target build script compilation
- [02-02]: Worker singleton pattern (create once, never terminate) for WASM instance reuse
- [02-03]: 5*tauDecay*fs padding for overlap-and-discard windowing (research Pattern 3)
- [02-03]: 20% relative threshold for tau change warm-start classification (research Pattern 4)
- [02-03]: 30ms debounce for rapid slider movements; stale job discard via counter
- [02-03]: Copy trace subarray before transfer to avoid detaching parent Float64Array
- [03-01]: Left-click drag for pan, scroll-wheel for zoom (oscilloscope model per research)
- [03-01]: X-axis only zoom with y auto-range (scientific trace viewing standard)
- [03-01]: Disabled uPlot default box-select zoom in favor of drag-to-pan
- [03-01]: autoResize enabled on SolidUplot for responsive width filling

### Pending Todos

None yet.

### Blockers/Concerns

- ~~Library version verification needed before Phase 1 scaffolding~~ RESOLVED: Vite 7.3.1, SolidJS 1.9.x, Vitest 4.0.18 all verified and installed

## Session Continuity

Last session: 2026-02-11
Stopped at: Completed 03-01-PLAN.md (Chart Infrastructure)
Resume file: .planning/phases/03-visualization/03-01-SUMMARY.md
