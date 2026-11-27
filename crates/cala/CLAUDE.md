# crates/cala: conventions

The cala engine (`calab-cala`): raw 1-photon video to footprints and traces, compiled to WASM for
`apps/cala`. Repo-wide rules (comment policy, PRs) are in `/CLAUDE.md`; the domain glossary
(Discover, Final settle, Extract, look-back, Background settle, visits, factors) is in
`apps/cala/CLAUDE.md`. Use those terms here too.

## Layout (`src/`, pipeline order; module docs in `src/lib.rs`)

| Module       | Role                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------- |
| `avi`        | AVI header and frame-offset parsing on byte ranges (`js_avi.rs` is its binding)          |
| `preprocess` | hot pixels, flattening, line artifacts, flicker, flat field, background floor, noise map |
| `motion`     | rigid and piecewise-rigid registration, warps, session alignment                         |
| `discover`   | the slow loop: add, merge, refine; visits, reservoir, look-back scheduling, visit rate   |
| `trace`      | the fast loop: traces from a swappable footprint library                                 |
| `compress`   | windowed low-rank factors, factor files, history review, Extract on factors              |
| `qc`         | online QC of traces, footprints and demixing                                             |

Each module's WASM binding is its `js.rs`; the Python stub is `src/py_api.rs`. Tests: unit tests in
`*/tests.rs`, integration and property tests in `tests/` (shared helpers in `tests/common/`).

## Features and CI

- `jsbindings` (default): the WASM surface. `pybindings`: a version-only stub, kept on purpose so
  cala can be exposed to Python later; CI lints it. `diagnostics`: opt-in capture for evals,
  never in shipped builds. `timing`: stage timers for measurement, no result changes.
- CI runs, in this directory: `cargo fmt --all --check`; `cargo clippy --all-targets
--no-default-features --features <jsbindings|pybindings|diagnostics> -- -D warnings`;
  `cargo test --no-default-features --features jsbindings`; and
  `cargo test --no-default-features --features diagnostics --lib discover::diagnostics`.
- `npm run build:wasm` (repo root) builds `pkg/` with wasm-pack and `+simd128` (`.cargo/config.toml`).

## WASM bindings

- Exports use `#[wasm_bindgen(js_name = camelCase)]` for methods, getters and functions; Rust
  names stay snake_case. (`cala_version` is the one existing snake_case export.)
- Errors cross the boundary as `JsError` through one helper (`js_err`, in `src/js_util.rs` if
  present); do not add another per-module copy. Public paths return typed errors and never panic:
  a panic traps and leaves the module unusable in its worker.
- No binding without a caller in `apps/cala` (or a script that loads `pkg/`). Exception: the
  motion and preprocess option setters (`MotionOptions`, `PreprocessConfig`) are a capability
  surface kept on purpose for features still to be wired; do not trim them.
- Changing a binding means changing, in the same PR: `apps/cala/src/lib/cala-wasm.ts` (the only
  import point), hand-written TS mirrors such as `SlowLoopLike` in `src/lib/slow-runner.ts`,
  and the test fakes that implement them. Then run `npm run typecheck` and the cala tests.
- Wire formats (library bytes, factor files, `CALA*` headers) are versioned: bump the version and
  keep reading the old one when existing exports or run records depend on it.

## Determinism

- Output depends only on input, settings and seeds: never on wall time, thread count, worker
  count or machine speed. Schedules count frames or data, not milliseconds.
- The SIMD build is bit-identical to the scalar build; keep it so (no float reassociation tricks).
- A refactor is bit-identical. Gate: build `qc_eval` on `main` and on the branch
  (`cargo build --release --example qc_eval`), run both with the same sims, flags and
  `--slow-seed`, including the app's shipped settings (look-back + settle), and require identical
  output files; say so in the PR body. Anything that changes bits is a behaviour change and needs
  a paired multi-seed eval (`tools/cala-eval/README.md`) with a results note.
- Shared numeric helpers (median, MAD, Pearson, NNLS) are merged only when bit-identical.

## Eval and benchmark code (protected)

- `examples/` (`qc_eval`, `discover_eval`, `motion_eval`, `compress_bench`, ...) and
  `tools/cala-eval` are the measurement record. `qc_eval` silently ignores unknown flags.
- Before removing an example flag, an arm or a code path it reaches, grep `tools/`,
  `tools/cala-eval/results/` and `apps/cala/scripts/` for it. If a results note relies on it, it
  stays unless the experiment is concluded and the removal PR says so.
- New engine behaviour gets its `qc_eval` switch and a results note in `tools/cala-eval/results/`
  (`YYYY-MM-DD-topic.md`); code comments link the note instead of quoting its numbers.
