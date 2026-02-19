# Contributing to CaTune

## Prerequisites

- **Node.js 22** (LTS) — use `.nvmrc`: `nvm use`
- **Rust stable** — use `rust-toolchain.toml`: `rustup show`
- **wasm-pack** — `cargo install wasm-pack`

## Setup

```bash
git clone <repo-url>
cd CaTune
nvm use              # Node 22
npm install          # JS dependencies (all workspaces)
npm run build:wasm   # Compile Rust → WASM (only needed if changing solver)
npm run dev          # Start dev server
```

## Workspace Structure

CaTune is an npm workspaces monorepo:

| Workspace           | Path                  | Description                                     |
| ------------------- | --------------------- | ----------------------------------------------- |
| `catune`            | `apps/catune/`        | SolidJS app — deconvolution parameter tuning    |
| `carank`            | `apps/carank/`        | SolidJS app — CNMF trace quality ranking        |
| `@catune/core`      | `packages/core/`      | Shared types, pure math, WASM adapter           |
| `@catune/compute`   | `packages/compute/`   | Generic worker pool, warm-start cache           |
| `@catune/io`        | `packages/io/`        | File parsers (.npy/.npz), validation, export    |
| `@catune/community` | `packages/community/` | Supabase DAL, submission logic, field options   |
| `@catune/tutorials` | `packages/tutorials/` | Tutorial type definitions, progress persistence |
| `@catune/ui`        | `packages/ui/`        | Shared layout: Shell, Panel, VizLayout          |

All packages are consumed as TypeScript source — Vite transpiles them directly via path aliases. No separate build step needed for development.

## npm Scripts

Run from the repo root:

| Script                 | Description                                       |
| ---------------------- | ------------------------------------------------- |
| `npm run dev`          | Start CaTune dev server                           |
| `npm run dev:carank`   | Start CaRank dev server                           |
| `npm run build`        | Build WASM + both apps                            |
| `npm run build:pages`  | Build + combine dist for GitHub Pages             |
| `npm run build:wasm`   | Compile Rust solver to WASM                       |
| `npm run test`         | Run Vitest tests across all workspaces            |
| `npm run test:watch`   | Run tests in watch mode (`apps/catune`)           |
| `npm run lint`         | Run ESLint on `apps/` + `packages/`               |
| `npm run lint:fix`     | Auto-fix ESLint issues                            |
| `npm run typecheck`    | Run TypeScript type checking (all packages + app) |
| `npm run format`       | Format all files with Prettier                    |
| `npm run format:check` | Check formatting (CI gate)                        |

You can also run scripts in a specific workspace:

```bash
npm run dev -w apps/catune      # Start CaTune dev server
npm run dev -w apps/carank      # Start CaRank dev server
npm run test -w apps/catune     # Run app tests only
npm run test -w packages/io     # Run io package tests only
```

## Creating a New Package

1. Create `packages/<name>/` with `package.json`, `tsconfig.json`, and `src/index.ts`
2. Add `@catune/<name>` to `apps/catune/package.json` dependencies as `"*"`
3. Add path mapping to `apps/catune/tsconfig.json` and `apps/catune/vite.config.ts`
4. Add the package to the root `typecheck` script in `package.json`
5. Run `npm install` to link the workspace

## Code Style

Code style is enforced automatically:

- **Prettier** — single quotes, trailing commas, 100 char width
- **ESLint** — TypeScript recommended + SolidJS plugin + boundary rules
- **TypeScript** — strict mode, project build mode for type checking

Run `npm run lint && npm run format:check && npm run typecheck` before pushing.

## Module Boundaries

ESLint enforces these import boundaries:

- **WASM**: Only `packages/core/src/wasm-adapter.ts` may import from `wasm/catune-solver/pkg/`
- **Supabase**: Only `packages/community/src/supabase.ts` may import `@supabase/supabase-js`
- **Package barrels**: App files import from `@catune/<pkg>`, never from `@catune/<pkg>/src/*`

## CI

The CI pipeline runs on every PR to `main`:

1. Format check (`prettier --check`)
2. Lint (`eslint`)
3. Type check (`tsc -b`)
4. Tests (`vitest run` across all workspaces)
5. Build (`vite build`)

The WASM package is committed to the repo, so CI does not require Rust.

## Commit Conventions

- Use descriptive commit messages: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`
- Keep commits focused — one logical change per commit
- The formatting commit (Prettier) should be separate from logic changes

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for module layout, dependency DAG, state management patterns, and boundary rules.
