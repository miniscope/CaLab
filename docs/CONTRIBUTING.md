# Contributing to CaLab

## Prerequisites

- **Node.js 22** (LTS): use `.nvmrc` (`nvm use`)
- **Rust stable** with the `wasm32-unknown-unknown` target, plus **wasm-pack**. These are
  required for any JS work, not just solver changes. `crates/solver/pkg/` is gitignored, so
  `npm run dev`/`test`/`typecheck`/`build:apps` build it first (`scripts/ensure-wasm.mjs`).
  Install with [rustup](https://rustup.rs), then `cargo install wasm-pack` (or
  `brew install wasm-pack`). `rust-toolchain.toml` pins the channel and the wasm target.
- **Python >= 3.11** + **maturin**: only needed for the Python package (`python/`)
- **Docker**: only needed to run the Supabase RLS tests locally (`scripts/test-rls.sh`)

## Setup

```bash
git clone https://github.com/miniscope/CaLab.git
cd CaLab
nvm use              # Node 22
npm install          # JS dependencies (all workspaces)
npm run dev          # Start CaTune; builds crates/solver/pkg/ first if missing or stale
```

## Workspace Structure

CaLab is an npm workspaces monorepo:

| Workspace          | Path                  | Description                                                                    |
| ------------------ | --------------------- | ------------------------------------------------------------------------------ |
| `catune`           | `apps/catune/`        | SolidJS app — deconvolution parameter tuning                                   |
| `carank`           | `apps/carank/`        | SolidJS app — CNMF trace quality ranking                                       |
| `cadecon`          | `apps/cadecon/`       | SolidJS app — automated InDeCa deconvolution                                   |
| `admin`            | `apps/admin/`         | SolidJS app — community-submission admin                                       |
| `@calab/core`      | `packages/core/`      | Shared types, pure math, WASM adapter                                          |
| `@calab/compute`   | `packages/compute/`   | Generic worker pool, warm-start cache                                          |
| `@calab/io`        | `packages/io/`        | File parsers (.npy/.npz), validation, export                                   |
| `@calab/community` | `packages/community/` | Supabase DAL, submission logic, field options                                  |
| `@calab/tutorials` | `packages/tutorials/` | Tutorial type definitions, progress persistence                                |
| `@calab/ui`        | `packages/ui/`        | Shared layout (Shell, Panel, VizLayout) + chart primitives (`@calab/ui/chart`) |

All packages are consumed as TypeScript source — Vite transpiles them directly via path aliases. No separate build step needed for development.

## npm Scripts

Run from the repo root:

| Script                 | Description                                      |
| ---------------------- | ------------------------------------------------ |
| `npm run dev`          | Start CaTune dev server                          |
| `npm run dev:carank`   | Start CaRank dev server                          |
| `npm run dev:cadecon`  | Start CaDecon dev server                         |
| `npm run dev:admin`    | Start admin dev server                           |
| `npm run build`        | Build WASM + every app in `apps/`                |
| `npm run build:pages`  | Build + combine dist for GitHub Pages            |
| `npm run build:wasm`   | Compile Rust solver to WASM                      |
| `npm run test`         | Run Vitest tests across all workspaces           |
| `npm run test:watch`   | Run tests in watch mode (`apps/catune`)          |
| `npm run lint`         | Run ESLint on `apps/` + `packages/`              |
| `npm run lint:fix`     | Auto-fix ESLint issues                           |
| `npm run typecheck`    | `tsc -b` every `apps/*` and `packages/*` project |
| `npm run format`       | Format all files with Prettier                   |
| `npm run format:check` | Check formatting (CI gate)                       |

You can also run scripts in a specific workspace:

```bash
npm run dev -w apps/catune      # Start CaTune dev server
npm run dev -w apps/carank      # Start CaRank dev server
npm run dev -w apps/cadecon     # Start CaDecon dev server
npm run dev -w apps/admin       # Start admin dev server
npm run test -w apps/catune     # Run app tests only
npm run test -w packages/io     # Run io package tests only
```

## Creating a New Package

1. Create `packages/<name>/` with `package.json`, `tsconfig.json`, and `src/index.ts`
2. Add `@calab/<name>` to `apps/catune/package.json` dependencies as `"*"`
3. Add path mapping to `apps/catune/tsconfig.json` and `apps/catune/vite.config.ts`
4. Run `npm install` to link the workspace

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
4. Tests (`vitest run` across all workspaces)
5. Build (`vite build`)

`crates/solver/pkg/` is not committed: CI installs Rust + wasm-pack and builds it before
these steps. Separate jobs run `cargo fmt`/`clippy`/`test` for the solver, the Python
package's ruff/mypy/pytest, and the Supabase RLS policy tests.

## Commit Conventions

- Use descriptive commit messages: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`
- Keep commits focused — one logical change per commit
- The formatting commit (Prettier) should be separate from logic changes

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for module layout, dependency DAG, state management patterns, and boundary rules.

## License

CaLab is licensed under the [MIT License](../LICENSE).
