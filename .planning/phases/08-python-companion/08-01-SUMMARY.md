---
phase: 08-python-companion
plan: 01
subsystem: python-package
tags: [python, numpy, kernel, hatchling, calcium-imaging, deconvolution]

# Dependency graph
requires:
  - phase: 02-wasm-solver
    provides: "Rust kernel.rs with build_kernel, tau_to_ar2, compute_lipschitz algorithms"
provides:
  - "Installable Python catune package with kernel math module"
  - "build_kernel, tau_to_ar2, compute_lipschitz functions matching Rust output"
  - "Shared test fixtures (conftest.py) for Plan 02 reuse"
  - "14 kernel tests verifying numerical equivalence"
affects: [08-02-fista-io]

# Tech tracking
tech-stack:
  added: [numpy, hatchling, pytest]
  patterns: [direct-port-identical-variable-names, dft-based-lipschitz, src-layout-packaging]

key-files:
  created:
    - python/pyproject.toml
    - python/src/catune/__init__.py
    - python/src/catune/_kernel.py
    - python/src/catune/py.typed
    - python/tests/conftest.py
    - python/tests/test_kernel.py
    - python/tests/fixtures/README.md
    - python/README.md
    - python/.gitignore
  modified: []

key-decisions:
  - "Pure Python+NumPy over PyO3 Rust extension (per research recommendation)"
  - "tau_to_ar2 returns (g1, g2, d, r) -- 4 values vs Rust's 2 -- exposing d,r for testing convenience"
  - "np.fft.fft with matched padding instead of explicit DFT loop for compute_lipschitz"
  - "Virtual environment (.venv) in python/ directory for isolated development"

patterns-established:
  - "Direct port pattern: identical variable names (dt, d, r, g1, g2, peak) across Rust and Python"
  - "DFT padding match: next_power_of_two(2*n) in both Rust and Python for Lipschitz computation"
  - "src-layout packaging: python/src/catune/ with hatchling build backend"

# Metrics
duration: 3min
completed: 2026-02-11
---

# Phase 8 Plan 01: Python Package Scaffold and Kernel Module Summary

**Pure Python+NumPy catune package with three kernel functions (build_kernel, tau_to_ar2, compute_lipschitz) matching Rust solver output, 14 passing tests**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-11T18:48:37Z
- **Completed:** 2026-02-11T18:52:01Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- Installable Python package (`pip install -e ".[dev]"`) with hatchling build backend
- Three kernel math functions ported from Rust with identical variable names and algorithms
- 14 comprehensive tests all passing, including explicit DFT loop cross-validation
- Shared test fixtures ready for Plan 02 (FISTA solver and I/O)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create Python package scaffold and kernel module** - `aeb0866` (feat)
2. **Task 2: Generate Rust reference vectors and write kernel tests** - `83a29e9` (test)

## Files Created/Modified
- `python/pyproject.toml` - Package config with hatchling, numpy dep, pytest config
- `python/src/catune/__init__.py` - Public API exports (build_kernel, tau_to_ar2, compute_lipschitz)
- `python/src/catune/_kernel.py` - Three kernel functions, direct port from Rust kernel.rs
- `python/src/catune/py.typed` - PEP 561 type stub marker
- `python/tests/conftest.py` - Shared fixtures: standard/fast/slow params, pre-built kernel
- `python/tests/test_kernel.py` - 14 tests covering all kernel functions
- `python/tests/fixtures/README.md` - Cross-language equivalence testing documentation
- `python/README.md` - Package readme (required by hatchling)
- `python/.gitignore` - Excludes .venv, __pycache__, eggs, dist

## Decisions Made
- **Pure Python+NumPy:** Per research recommendation -- no Rust toolchain needed for pip install
- **4-tuple tau_to_ar2 return:** Returns (g1, g2, d, r) instead of Rust's (g1, g2), exposing characteristic roots for testing and downstream use
- **np.fft.fft for Lipschitz:** Uses NumPy FFT with matched padding (next_power_of_two(2*n)) rather than explicit DFT loop. Cross-validated by explicit loop test to rtol=1e-10
- **Virtual environment:** Created python/.venv for isolated development since system pip was unavailable

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Created README.md for hatchling metadata requirement**
- **Found during:** Task 1 (pip install -e)
- **Issue:** pyproject.toml references `readme = "README.md"` but file did not exist, causing hatchling build failure
- **Fix:** Created minimal python/README.md with package description and usage examples
- **Files modified:** python/README.md
- **Verification:** pip install -e succeeded after fix
- **Committed in:** aeb0866 (Task 1 commit)

**2. [Rule 3 - Blocking] Created virtual environment for pip/pytest**
- **Found during:** Task 1 (verifying pip availability)
- **Issue:** System Python had no pip installed (Debian/Ubuntu policy blocks ensurepip for system python). python3-pip and python3-venv not installed at system level
- **Fix:** Used `python3 -m venv` (venv module was available) to create python/.venv, then installed via .venv/bin/pip
- **Files modified:** python/.gitignore (added .venv/)
- **Verification:** pip install -e ".[dev]" succeeded, pytest runs all tests
- **Committed in:** aeb0866 (Task 1 commit)

**3. [Rule 3 - Blocking] Created python/.gitignore**
- **Found during:** Task 1 (before commit)
- **Issue:** .venv, __pycache__, egg-info directories would be tracked by git without exclusion
- **Fix:** Created .gitignore with standard Python exclusions
- **Files modified:** python/.gitignore
- **Committed in:** aeb0866 (Task 1 commit)

**4. [Rule 2 - Missing Critical] Added tests/__init__.py**
- **Found during:** Task 2 (test setup)
- **Issue:** pytest may not discover test modules without __init__.py in the tests directory
- **Fix:** Created empty tests/__init__.py
- **Files modified:** python/tests/__init__.py
- **Committed in:** 83a29e9 (Task 2 commit)

---

**Total deviations:** 4 auto-fixed (2 blocking, 1 missing critical, 1 blocking)
**Impact on plan:** All auto-fixes necessary for correct package building and testing. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Python package scaffold complete, ready for Plan 02 (FISTA solver + I/O)
- Shared fixtures in conftest.py available for Plan 02 test files
- build_kernel and compute_lipschitz will be imported by _fista.py
- Virtual environment at python/.venv has numpy and pytest installed

---
*Phase: 08-python-companion*
*Completed: 2026-02-11*
