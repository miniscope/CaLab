# calab-cala-core

Numerical core for **CaLa** — CaLab's streaming calcium imaging demixing pipeline. See `.planning/CALA_DESIGN.md` (repo root) for the full design.

This crate is the single source of truth for all CaLa numerics. It compiles to:

- **WASM** (`--features jsbindings`) for the browser app at `apps/cala/`.
- **Python extension** (`--features pybindings`) via PyO3, consumed by `python/calab/cala/`.

## Status

Phase 1 (preprocess + assets scaffold) is in progress. The crate is intentionally empty until each module lands with tests-first.

## Build

```
# Browser (WASM) feature surface — matches CI
cargo check --no-default-features --features jsbindings
cargo test  --no-default-features --features jsbindings

# Python (PyO3) feature surface — requires python dev headers
cargo check --no-default-features --features pybindings
```
