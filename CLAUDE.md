# CaLab: conventions for coding agents

Coding agents copy what they see. Treat these rules as stronger than the style of any one file:
where existing code breaks them, follow the rules, and fix what you touch.

More specific rules: `apps/cala/CLAUDE.md` and `crates/cala/CLAUDE.md` (they load when you work
in those folders). Human docs: `README.md`, `docs/ARCHITECTURE.md`, `docs/CONTRIBUTING.md`,
`docs/NEW_APP.md`.

## What lives where

| Path                | What it is                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `apps/catune`       | CaTune: interactive deconvolution parameter tuning (SolidJS)                                              |
| `apps/cadecon`      | CaDecon: automated InDeCa deconvolution                                                                   |
| `apps/cala`         | cala: streaming raw 1-photon video to footprints and traces, in the browser (WASM + WebGPU)               |
| `apps/cabana`       | CaBaNA: behavioural and neural analysis (placeholder)                                                     |
| `apps/admin`        | Admin: community submissions and analytics                                                                |
| `apps/_template`    | Scaffold for `npm run new-app` (see `docs/NEW_APP.md`)                                                    |
| `packages/*`        | Shared TS (`@calab/core`, `compute`, `io`, `project`, `ui`, `community`, `community-ui`, `tutorials`, `vite-config`) |
| `crates/solver`     | Rust deconvolution solver: WASM (`jsbindings`) and the Python extension (`pybindings`)                    |
| `crates/cala`       | Rust cala engine (WASM); eval binaries in `crates/cala/examples`                                          |
| `python/`           | `calab` Python package: a bridge only (data in and out of the browser apps, PyO3 of the solver)           |
| `tools/cala-eval`   | Paired multi-seed evaluation of cala; `results/` holds the dated results notes                            |
| `e2e/`, `supabase/` | Playwright smoke tests; Supabase migrations, RLS tests and edge functions                                 |

Packages are consumed as TS source (`main`/`exports` point at `src/`). Module boundaries are
ESLint-enforced: only `packages/core/src/wasm-adapter.ts` imports `crates/solver/pkg/`, only
`apps/cala/src/lib/cala-wasm.ts` imports `crates/cala/pkg/`, only
`packages/community/src/supabase.ts` imports Supabase, and apps import `@calab/<pkg>`, never
`@calab/<pkg>/src/*`. Python never gets its own GPU or algorithm code: algorithms live in Rust.

## Commands

Node 22 (`.nvmrc`), Rust stable + `wasm32-unknown-unknown` + wasm-pack. Root scripts:

- `npm run dev [app]` (default CaTune), `npm run build:wasm`, `npm run build:apps`
- `npm run format` / `format:check`, `npm run lint`, `npm run typecheck`
- `npm run test` (all workspaces), `npm run test -w apps/cala` (one workspace; run `npm run ensure-wasm` first on a fresh clone), `npm run test:coverage`
- `npm run build:e2e && npm run test:e2e` (Playwright smoke tests)

Rust has no workspace: run per crate (`crates/solver`, `crates/cala`), always with explicit features,
exactly as CI does:

```bash
cargo fmt --all --check
cargo clippy --all-targets --no-default-features --features jsbindings -- -D warnings
cargo clippy --all-targets --no-default-features --features pybindings -- -D warnings
cargo test --no-default-features --features jsbindings   # pybindings cannot link under cargo test
# crates/cala also: clippy with --features diagnostics, and
cargo test --no-default-features --features diagnostics --lib discover::diagnostics
```

Python (in `python/`, after `maturin develop --features pybindings` in a venv):
`ruff check src/ tests/`, `mypy src/`, `pytest -m "not integration"`.

Before pushing: format, lint, typecheck, the tests of what you touched, and the Rust/Python
checks if you touched those trees. Full CI: `.github/workflows/ci.yml`.

## Pull requests

- One theme per PR. Branch from `origin/main`; open it ready for review unless it is truly a draft.
- `main` merges are squash-only and the branch must be up to date with `main`; there is no
  auto-merge. Maintainers merge: never merge your own PR.
- Stacked PRs: after the parent lands, rebase the child onto `main`.
- History, evidence and measurements go in the commit message and PR body (and in
  `tools/cala-eval/results/` for cala experiments), not in code comments.
- User-visible changes get a line in `docs/CHANGELOG.md`; changed behaviour updates the app's docs.

## Comment policy

Comments say what the code guarantees and why. They are read as current truth, and
agents copy them, so a stale or narrative comment does damage twice.

Write:

- **Invariants and contracts**: what holds on entry and exit, what callers may rely on.
- **Units and ranges**: `/** Visits per observed frame, in [0, 1]. */`, frames vs seconds, px vs µm.
- **Non-obvious reasons**: why this order, this constant, this workaround. If the reason is
  empirical, state the conclusion and point to the note:
  `// See tools/cala-eval/results/<note>.md` (that path is the only place a date may appear).
- **Doc comments on every export** (`/** */` in TS, `///` and `//!` in Rust): one line is fine.

Do not write:

- PR or issue numbers, dates, meeting or decision history, or who decided
  (bad: `// chosen in PR #123 after the review on 3 May`).
- Numbers measured in an experiment (`// 12 % faster on sim 5`): they go stale; link the note.
- Change narration: "previously", "used to", "no longer", "now", "new", "the old path", "we
  changed X to Y". Describe the code as it is; git holds what it was.
- Status words that are never revisited: "experimental", "for now", "temporary", "prototype".
  If something really is opt-in or provisional, say what turns it on and how it will be removed.
- Commented-out code. Delete it.
- `TODO` / `FIXME` without an issue (`// TODO(#123): ...` is the one allowed issue reference).
- Comments that restate the code (`// increment i`).

Maintenance: when you change code, update or delete the comments it invalidates in the same
change. Delete a comment rather than leave one you cannot verify. In files you touch, bring
comments in line with this policy.

## Flags and switches

- No new behaviour behind a flag or option without saying, in the PR, what decides it and how
  the flag gets removed (adopt and delete the old path, or drop the experiment).
- Debug URL flags (`?debug&...`) are measurement knobs, not features: each is parsed and listed in
  one place per app (cala: `apps/cala/CLAUDE.md`), recorded in the run record, and never removed
  while a measurement script or results note uses it.
- Concluded experiments get deleted, code and flag together, in their own PR.

## Reuse before writing

Search before adding a helper; extend the shared one rather than copying it. Shared homes:

- Math, types, formatting: `@calab/core` (`packages/core/src`, e.g. `format-utils.ts`).
- Workers, pools, scheduling: `@calab/compute`. File parsing and export: `@calab/io`.
- UI layout, tiles, charts, tokens: `@calab/ui` (`packages/ui/src`, `src/chart`, `src/styles/tokens.css`).
- cala app helpers (some are being created by in-flight cleanup PRs; use them if present):
  `lib/stats.ts` (median, quantile), `lib/idb.ts` (IndexedDB), `lib/fs-handles.ts` (file-system
  handle types), `lib/page-flags.ts` (URL flags), an `errMsg(e)` helper for
  `e instanceof Error ? e.message : String(e)`; Rust: `crates/cala/src/js_util.rs` (`js_err`).
- If two copies of a helper differ (NaN handling, rounding, empty input), they are two contracts:
  do not merge them silently; name the contract in the doc comment.

## Tests

- Tests sit in `__tests__/` beside the code (Vitest) or in the crate (`tests.rs`, `tests/`).
- Use the shared fixtures and fakes of the area before writing a new one; when you copy a setup a
  second time, move it into a fixture module instead.
- Test behaviour through the public interface; a test-only export is a smell.

## Naming

One concept, one name, in code, UI text and docs. Use the glossary of the area (cala:
`apps/cala/CLAUDE.md`). Never rename persisted strings (export keys, run-record fields, URL
flags, file formats, e2e test ids) to match a new name: rename identifiers only.
