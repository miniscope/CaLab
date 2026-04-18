# @calab/cala-core

Adapter package for the `crates/cala-core` WASM build.

## What this is

A thin, lazily-initialized JS facade over `crates/cala-core/pkg/` (produced by `wasm-pack build --target web`). Exports the `AviReader`, `Preprocessor`, `Fitter`, `MutationQueueHandle`, and `SnapshotHandle` bindings plus an `initCalaCore()` helper that guarantees the WASM module boots exactly once per worker.

Mirrors the pattern `@calab/core` uses to front the `crates/solver` WASM module. Keeping the two adapters structurally identical makes it obvious which Rust crate each type comes from and prevents cross-contamination of init promises.

## Rule

Never import from `crates/cala-core/pkg/` directly — always go through `@calab/cala-core`. The ESLint `no-restricted-imports` rule enforces this at the workspace level.

## Building

```
npm run build:wasm:cala    # wraps wasm-pack build in crates/cala-core
```

`npm run build:wasm` (root) builds both the solver and cala-core artifacts.

## Tests

```
npm test -w packages/cala-core
```

Tests mock the WASM pkg so they run in Node without needing the artifact loaded — they verify init-promise idempotency, the single-shot panic-hook install, and the public re-export surface. Real WASM execution is covered in the Phase 5 exit E2E (apps/cala browser run).
