---
phase: 08-python-companion
plan: 02
subsystem: python-package
tags: [python, numpy, fista, deconvolution, npy, calcium-imaging, testing]

# Dependency graph
requires:
  - phase: 08-python-companion
    plan: 01
    provides: "Python package scaffold, kernel module (build_kernel, tau_to_ar2, compute_lipschitz)"
  - phase: 02-wasm-solver
    provides: "Rust FISTA algorithm (fista.rs) as reference implementation"
provides:
  - "run_deconvolution: FISTA solver matching Rust algorithm for offline spike estimation"
  - "save_for_tuning: CaTune-compatible .npy + _metadata.json export"
  - "load_tuning_data: round-trip loader for saved tuning data"
  - "Complete catune public API: 6 functions"
  - "45 passing tests (31 new + 14 kernel) covering solver, I/O, and cross-language equivalence"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: [fista-adaptive-restart, causal-convolution-truncation, adjoint-convolution-klen-offset, json-metadata-sidecar, npy-float64-c-contiguous]

key-files:
  created:
    - python/src/catune/_fista.py
    - python/src/catune/_io.py
    - python/tests/test_fista.py
    - python/tests/test_io.py
    - python/tests/test_equivalence.py
  modified:
    - python/src/catune/__init__.py

key-decisions:
  - "Adjoint convolution uses [klen-1:klen-1+n] truncation (not [:n]) matching Rust convolve_adjoint"
  - "JSON metadata sidecar with built-in keys taking precedence over user metadata"
  - "High-lambda test compares sparsity vs low-lambda rather than absolute threshold"

patterns-established:
  - "FISTA loop: iteration 1..max_iters, convergence check after iteration>5, prev_objective after check"
  - "Forward: np.convolve(signal, kernel, 'full')[:n], Adjoint: np.convolve(residual, kernel[::-1], 'full')[klen-1:klen-1+n]"
  - "save_for_tuning creates {path}.npy + {path}_metadata.json with schema_version 1.0.0"

# Metrics
duration: 4min
completed: 2026-02-11
---

# Phase 8 Plan 02: FISTA Solver and I/O Module Summary

**FISTA deconvolution solver ported from Rust with adaptive restart, save/load I/O with JSON metadata sidecar, 45 passing tests including adjoint transpose verification**

## Performance

- **Duration:** 4 min
- **Started:** 2026-02-11T18:54:43Z
- **Completed:** 2026-02-11T18:58:38Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- run_deconvolution matches Rust FISTA algorithm: correct forward/adjoint convolutions, adaptive restart, non-negative projection, convergence check
- save_for_tuning produces CaTune-compatible .npy (Float64, C-contiguous, little-endian) plus _metadata.json sidecar
- Complete public API: build_kernel, tau_to_ar2, compute_lipschitz, run_deconvolution, save_for_tuning, load_tuning_data
- 45 total tests passing across 4 test files (kernel + fista + io + equivalence)
- Full end-to-end pipeline verified: generate traces -> save -> load -> solve -> verify

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement FISTA solver and I/O module** - `9ced2d7` (feat)
2. **Task 2: Write comprehensive tests for solver, I/O, and cross-language equivalence** - `d0bb532` (test)

## Files Created/Modified
- `python/src/catune/_fista.py` - FISTA solver: run_deconvolution with adaptive restart, 1D/2D input
- `python/src/catune/_io.py` - save_for_tuning (.npy + JSON) and load_tuning_data round-trip
- `python/src/catune/__init__.py` - Updated to export all 6 public API functions
- `python/tests/test_fista.py` - 12 tests: impulse recovery, non-negativity, determinism, multi-trace, parameters
- `python/tests/test_io.py` - 9 tests: round-trip, format compat, metadata, error handling, C-contiguous
- `python/tests/test_equivalence.py` - 9 tests (5 parametrized): kernel properties, adjoint transpose, pipeline, objective monotonicity

## Decisions Made
- **Adjoint truncation [klen-1:klen-1+n]:** Critical detail matching Rust convolve_adjoint -- verified by explicit matrix transpose test
- **Built-in metadata precedence:** In save_for_tuning, schema_version/dtype/dimensions overwrite any user-supplied keys of the same name
- **Sparsity-based lambda test:** High-lambda test compares sum and non-zero count against low-lambda solution rather than asserting absolute near-zero (FISTA correctly retains large spikes even with high penalty)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed high-lambda test threshold**
- **Found during:** Task 2 (test execution)
- **Issue:** test_high_lambda_suppresses_spikes asserted solution.max() < 0.5 with lambda=1.0 and amplitude=5.0, but FISTA correctly retains the spike (just sparser). L1 penalty shrinks the overall sum but does not eliminate large isolated spikes.
- **Fix:** Changed test to compare sparsity (sum and non-zero count) between low-lambda and high-lambda solutions instead of absolute threshold
- **Files modified:** python/tests/test_fista.py
- **Verification:** Test passes, validates correct L1 penalty behavior
- **Committed in:** d0bb532 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug in test)
**Impact on plan:** Corrected unrealistic test expectation. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviation above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Python catune package is complete: PYTH-01 (save_for_tuning) and PYTH-02 (run_deconvolution) satisfied
- Ready for PyPI publishing when desired
- All 45 tests pass with `cd python && .venv/bin/python3 -m pytest tests/ -v`

---
*Phase: 08-python-companion*
*Completed: 2026-02-11*
