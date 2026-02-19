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
npm install          # JS dependencies
npm run build:wasm   # Compile Rust → WASM (only needed if changing solver)
npm run dev          # Start dev server
```

## npm Scripts

| Script                 | Description                         |
| ---------------------- | ----------------------------------- |
| `npm run dev`          | Start Vite dev server               |
| `npm run build`        | Build WASM + Vite production bundle |
| `npm run build:wasm`   | Compile Rust solver to WASM         |
| `npm run test`         | Run Vitest tests                    |
| `npm run test:watch`   | Run tests in watch mode             |
| `npm run lint`         | Run ESLint on `src/`                |
| `npm run lint:fix`     | Auto-fix ESLint issues              |
| `npm run format`       | Format all files with Prettier      |
| `npm run format:check` | Check formatting (CI gate)          |
| `npm run typecheck`    | Run TypeScript type checking        |

## Code Style

Code style is enforced automatically:

- **Prettier** — single quotes, trailing commas, 100 char width
- **ESLint** — TypeScript recommended + SolidJS plugin
- **TypeScript** — strict mode, `noEmit` for type checking

Run `npm run lint && npm run format:check && npm run typecheck` before pushing.

## CI

The CI pipeline runs on every PR to `main`:

1. Format check (`prettier --check`)
2. Lint (`eslint`)
3. Type check (`tsc --noEmit`)
4. Tests (`vitest run`)
5. Build (`vite build`)

The WASM package is committed to the repo, so CI does not require Rust.

## Commit Conventions

- Use descriptive commit messages: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`
- Keep commits focused — one logical change per commit
- The formatting commit (Prettier) should be separate from logic changes

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for module layout, state management patterns, and boundary rules.
