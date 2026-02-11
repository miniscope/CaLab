# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-10)

**Core value:** Neuroscientists can interactively tune deconvolution parameters on their own calcium imaging data, see immediate visual feedback of fit quality, and learn the tuning workflow through progressive guided tutorials -- all in the browser with zero setup.
**Current focus:** Phase 5 in progress — Multi-Trace and Export

## Current Position

Phase: 5 of 8 (Multi-Trace and Export)
Plan: 2 of 3 in current phase
Status: Plan 02 Complete
Last activity: 2026-02-11 -- Plan 05-02 complete. Snapshot comparison and export.

Progress: [██████----] 2/3 Phase 5

## Performance Metrics

**Velocity:**
- Total plans completed: 13
- Average duration: 4 min
- Total execution time: 48 min

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-data-foundation | 3/3 | 8 min | 3 min |
| 02-wasm-solver | 3/3 | 22 min | 7 min |
| 03-visualization | 2/2 | 8 min | 4 min |
| 04-interactive-core-loop | 3/3 | 6 min | 2 min |
| 05-multi-trace-and-export | 2/3 | 4 min | 2 min |

**Recent Trend:**
- Last 5 plans: 04-01 (2 min), 04-03 (3 min), 05-01 (2 min), 05-02 (2 min)
- Trend: Feature plans executing cleanly with no deviations or blockers

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
- [03-02]: Visualization store decoupled from solver for reactive data flow
- [03-02]: Mock trace generator creates synthetic data for development (Phase 4 replaces with real solver output)
- [03-02]: Raw + reconvolution fit combined in single panel as multi-series overlay
- [03-02]: Residual trace derived as createMemo for automatic reactivity
- [04-01]: Local lambda signal in ParameterPanel (not viz-store) to avoid modifying shared state before Plan 03 integration
- [04-01]: Local solverStatus signal in ConvergenceIndicator -- Plan 03 will move both to viz-store
- [04-01]: onInput for live solver feedback, onChange for undo history commits (one undo entry per drag gesture)
- [04-02]: Conditional base path via GITHUB_ACTIONS env var (auto-set by runner, no manual config)
- [04-02]: Artifact-based Pages deployment (upload-pages-artifact + deploy-pages) over gh-pages branch approach
- [04-03]: Copy Float64Arrays from solver results with new Float64Array() to avoid ArrayBuffer detachment
- [04-03]: Guard flag pattern (isUndoRedoInProgress) prevents undo/redo from pushing to history
- [04-03]: Solve full trace on initial load (visibleStart=0, visibleEnd=trace.length)
- [04-03]: 30ms debounce via SolverJobScheduler for rapid slider movements
- [05-01]: Single-pass variance (sumSq/n - mean^2) for O(cells*timepoints) activity ranking
- [05-01]: Cold start for batch solves (no warm-start reuse across different cells)
- [05-01]: Sequential batch solve to avoid worker contention with interactive tuning
- [05-02]: Direct port of Rust tau_to_ar2 preserving variable names (d, r, g1, g2) for cross-language consistency
- [05-02]: Schema version 1.0.0 with metadata fields for Phase 7/8 forward compatibility
- [05-02]: Auto-clear pinned snapshot on cell switch (research Pitfall 4)

### Pending Todos

None yet.

### Blockers/Concerns

- ~~Library version verification needed before Phase 1 scaffolding~~ RESOLVED: Vite 7.3.1, SolidJS 1.9.x, Vitest 4.0.18 all verified and installed

## Session Continuity

Last session: 2026-02-11
Stopped at: Completed 05-02-PLAN.md
Resume file: .planning/phases/05-multi-trace-and-export/05-02-SUMMARY.md
