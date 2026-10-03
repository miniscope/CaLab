# Contributing to CaLab

## Prerequisites

- **Node.js 22** (LTS): use `.nvmrc` (`nvm use`)
- **Rust stable** with the `wasm32-unknown-unknown` target, plus **wasm-pack**. These are
  required for any JS work, not just solver changes. `crates/solver/pkg/` is gitignored, so
  `npm run dev`/`test`/`typecheck`/`build:apps` build it first (`scripts/ensure-wasm.mjs`).
  Install with [rustup](https://rustup.rs), then `cargo install wasm-pack` (or
  `brew install wasm-pack`). `rust-toolchain.toml` pins the channel and the wasm target.
- **Python >= 3.11** + **maturin**: only needed for the Python package (`python/`)
- **Playwright Chromium**: only needed for the browser smoke tests
  (`npx playwright install chromium`, once per Playwright version)
- **Docker**: only needed to run the Supabase RLS tests locally (`scripts/test-rls.sh`)

## Setup

```bash
git clone https://github.com/miniscope/CaLab.git
cd CaLab
nvm use              # Node 22
npm install          # JS dependencies (all workspaces)
npm run dev          # Start CaTune; builds crates/solver/pkg/ first if missing or stale
npm run dev cadecon  # Any other app: directory name, calab.id or display name
```

## Workspace Structure

CaLab is an npm workspaces monorepo:

| Workspace             | Path                     | Description                                                                    |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `catune`              | `apps/catune/`           | SolidJS app — deconvolution parameter tuning                                   |
| `carank`              | `apps/carank/`           | SolidJS app — CNMF trace quality ranking                                       |
| `cadecon`             | `apps/cadecon/`          | SolidJS app — automated InDeCa deconvolution                                   |
| `admin`               | `apps/admin/`            | SolidJS app — community-submission admin                                       |
| `@calab/core`         | `packages/core/`         | Shared types, pure math, WASM adapter                                          |
| `@calab/compute`      | `packages/compute/`      | Generic worker pool, warm-start cache                                          |
| `@calab/io`           | `packages/io/`           | File parsers (.npy/.npz), validation, export                                   |
| `@calab/community`    | `packages/community/`    | Supabase DAL, submission logic, field options                                  |
| `@calab/community-ui` | `packages/community-ui/` | SolidJS widgets coupled to the community backend (auth, browser, submit)       |
| `@calab/tutorials`    | `packages/tutorials/`    | Tutorial type definitions, progress persistence                                |
| `@calab/ui`           | `packages/ui/`           | Shared layout (Shell, Panel, VizLayout) + chart primitives (`@calab/ui/chart`) |
| `@calab/vite-config`  | `packages/vite-config/`  | `defineCalabApp()`: the shared Vite/Vitest config for every app                |

All packages are consumed as TypeScript source: each package's `package.json` points
`main`/`exports` at `src/`, so Vite and `tsc` resolve the workspace symlinks directly (no
path aliases, no separate build step for development).

## npm Scripts

Run from the repo root:

| Script                        | Description                                                         |
| ----------------------------- | ------------------------------------------------------------------- |
| `npm run dev [app]`           | Start an app's dev server (default: CaTune)                         |
| `npm run build`               | Build WASM + every app in `apps/`                                   |
| `npm run build:pages`         | Build + combine dist for GitHub Pages                               |
| `npm run build:wasm`          | Compile Rust solver to WASM                                         |
| `npm run test`                | Run Vitest tests across all workspaces                              |
| `npm run test:watch`          | Run tests in watch mode (`apps/catune`)                             |
| `npm run test:coverage`       | Run all tests once under V8 coverage (floors in `vitest.config.ts`) |
| `npm run build:e2e`           | Build the combined site for the smoke tests                         |
| `npm run test:e2e`            | Playwright smoke tests against that build                           |
| `npm run test:e2e:ui`         | The smoke tests in Playwright UI mode                               |
| `npm run check:app-tests`     | Fail if an app has no `test` script                                 |
| `npm run check:apps-manifest` | Check `dist/CaLab/apps.json` lists every non-hidden app             |
| `npm run lint`                | Run ESLint on `apps/`, `packages/`, `scripts/`, `e2e/`              |
| `npm run lint:fix`            | Auto-fix ESLint issues                                              |
| `npm run typecheck`           | `tsc -b` every `apps/*` and `packages/*` project                    |
| `npm run typecheck:e2e`       | Type-check the Playwright suite                                     |
| `npm run format`              | Format all files with Prettier                                      |
| `npm run format:check`        | Check formatting (CI gate)                                          |

Apps are discovered from `apps/*/package.json` by the build, dev, typecheck and deploy
scripts, so adding one needs no edit to the root `package.json` or `scripts/`.

You can also run scripts in a specific workspace. These skip the root `pre*` hooks, so run
`npm run ensure-wasm` (or any root `dev`/`test`/`build` script) once first on a fresh clone:

```bash
npm run dev -w apps/carank      # CaRank dev server, without the WASM check
npm run test -w apps/catune     # Run app tests only
npm run test -w packages/io     # Run io package tests only
```

### Browser smoke tests and coverage

`npm run build:e2e && npm run test:e2e` builds the combined site with the production base
path and loads every app in headless Chromium (see [`e2e/README.md`](../e2e/README.md)).
`npm run test:coverage` reruns the unit tests under V8 coverage and fails if a
`packages/*` floor in `vitest.config.ts` regresses; the report lands in `coverage/`.

## Creating a New Package

1. Create `packages/<name>/` with `package.json` (`main`/`types`/`exports` pointing at
   `src/`), `tsconfig.json`, and `src/index.ts`
2. Add `@calab/<name>` as `"*"` to the `dependencies` of each app that uses it
3. Run `npm install` to link the workspace

`npm run typecheck` discovers every `apps/*` and `packages/*` directory that has a
`tsconfig.json` (`scripts/typecheck.mjs`), so there is no list to update.

## Code Style

Code style is enforced automatically:

- **Prettier** — single quotes, trailing commas, 100 char width
- **ESLint** — TypeScript recommended + SolidJS plugin + boundary rules
- **TypeScript** — strict mode, project build mode for type checking

Run `npm run lint && npm run format:check && npm run typecheck` before pushing.

## Module Boundaries

ESLint enforces these import boundaries:

- **WASM**: Only `packages/core/src/wasm-adapter.ts` may import from `crates/solver/pkg/`
- **Supabase**: Only `packages/community/src/supabase.ts` may import `@supabase/supabase-js`
- **Package barrels**: App files import from `@calab/<pkg>`, never from `@calab/<pkg>/src/*`

## CI

The CI pipeline runs on every PR and on pushes to `main`:

1. Format check (`prettier --check`)
2. Lint (`eslint`)
3. Type check (`tsc -b`)
4. Every app has a `test` script (`check:app-tests`)
5. Tests (`vitest run` across all workspaces)
6. Coverage (`test:coverage`, per-package floors; the lcov report is uploaded)
7. Build (`build:apps`)
8. Apps manifest (`combine-dist.mjs` + `check:apps-manifest`)

`crates/solver/pkg/` is not committed: CI installs Rust + wasm-pack and builds it before
these steps. Separate jobs run the Playwright smoke tests (`e2e`), `cargo fmt`/`clippy`/`test`
for the solver, the Python package's ruff/mypy/pytest, and the Supabase RLS policy tests.
A `v*` tag deploys to GitHub Pages only after `deploy.yml` reruns the check, e2e, Rust,
Python and Supabase jobs.

## Commit Conventions

- Use descriptive commit messages: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`
- Keep commits focused — one logical change per commit
- The formatting commit (Prettier) should be separate from logic changes

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for module layout, dependency DAG, state management patterns, and boundary rules.

## License

CaLab is licensed under the [MIT License](../LICENSE).
