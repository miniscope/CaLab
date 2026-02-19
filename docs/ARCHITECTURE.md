# CaTune Architecture

CaTune is a browser-based calcium imaging deconvolution tool built with SolidJS, TypeScript, and a Rust/WASM solver.

## Monorepo Structure

CaTune uses npm workspaces with seven packages and two applications:

```
.
├── apps/
│   ├── catune/                  # SolidJS SPA — deconvolution parameter tuning
│       ├── index.html
│       ├── src/
│       │   ├── App.tsx          # Root component, routing, layout
│       │   ├── components/      # UI components organized by feature
│       │   │   ├── cards/       # Cell cards, trace overview, zoom window
│       │   │   ├── community/   # Community browser, submit form, scatter plot
│       │   │   ├── controls/    # Parameter sliders, cell selector
│       │   │   ├── import/      # File drop zone, trace preview, validation
│       │   │   ├── layout/      # Header, sidebar, panels, overlays
│       │   │   ├── metrics/     # Quality metrics display
│       │   │   ├── spectrum/    # Power spectrum visualization
│       │   │   ├── traces/      # Trace panel, kernel display
│       │   │   └── tutorial/    # Tutorial launcher, popover
│       │   ├── lib/             # App-specific logic (SolidJS stores + wiring)
│       │   │   ├── chart/       # Chart helpers: kernel math, downsample, series config
│       │   │   ├── community/   # Barrel re-exports @catune/community + local store
│       │   │   ├── spectrum/    # spectrum-store (SolidJS signals, imports @catune/core fft)
│       │   │   ├── tutorial/    # Barrel re-exports @catune/tutorials + engine, store, content
│       │   │   ├── data-store.ts        # SolidJS signals for loaded data
│       │   │   ├── viz-store.ts         # SolidJS signals for visualization state
│       │   │   ├── multi-cell-store.ts  # SolidJS signals for multi-cell selection
│       │   │   └── cell-solve-manager.ts  # SolidJS orchestrator for solver
│       │   ├── workers/
│       │   │   └── pool-worker.ts  # WASM solver worker (Vite bundled)
│       │   └── styles/          # CSS files
│       ├── vite.config.ts
│       ├── vitest.config.ts
│       ├── tsconfig.json        # Extends ../../tsconfig.base.json
│       └── package.json
│   └── carank/                  # SolidJS SPA — trace quality ranking
│       ├── index.html
│       ├── src/
│       │   ├── App.tsx          # Root: file import → ranking dashboard
│       │   ├── components/      # Header, FileImport, RankingDashboard
│       │   ├── types.ts         # CnmfData interface
│       │   └── styles/          # Design tokens + app-specific styles
│       ├── vite.config.ts
│       ├── tsconfig.json
│       └── package.json
├── packages/
│   ├── core/                    # @catune/core — shared types, pure math, WASM adapter
│   │   └── src/
│   │       ├── index.ts         # Barrel re-exports
│   │       ├── wasm-adapter.ts  # Single WASM import point
│   │       ├── solver-types.ts  # Worker protocol types
│   │       ├── types.ts         # NpyResult, ValidationResult, etc.
│   │       ├── ar2.ts           # AR(2) coefficient derivation
│   │       ├── param-config.ts  # Parameter ranges
│   │       ├── format-utils.ts  # Number formatting
│   │       ├── metrics/         # snr.ts, solver-metrics.ts
│   │       ├── spectrum/        # fft.ts (periodogram computation)
│   │       └── schemas/
│   │           └── export-schema.ts  # Valibot export validation
│   ├── compute/                 # @catune/compute — worker pool + warm-start cache
│   │   └── src/
│   │       ├── index.ts
│   │       ├── worker-pool.ts   # Generic worker pool (accepts worker URL)
│   │       └── warm-start-cache.ts
│   ├── io/                      # @catune/io — file parsers, validation, export
│   │   └── src/
│   │       ├── index.ts
│   │       ├── npy-parser.ts    # NumPy .npy parser
│   │       ├── npz-parser.ts    # NumPy .npz parser
│   │       ├── validation.ts    # Trace data validation
│   │       ├── array-utils.ts   # Cell extraction, transpose
│   │       ├── cell-ranking.ts  # Activity-based ranking
│   │       ├── export.ts        # JSON export builder
│   │       └── __tests__/       # Parser and validation tests
│   ├── community/               # @catune/community — Supabase DAL, submission logic
│   │   └── src/
│   │       ├── index.ts
│   │       ├── supabase.ts      # Lazy client singleton
│   │       ├── community-service.ts  # CRUD operations
│   │       ├── types.ts         # CommunitySubmission, FilterState, etc.
│   │       ├── submitAction.ts  # Form → payload logic
│   │       ├── quality-checks.ts
│   │       ├── field-options.ts # Hardcoded option arrays
│   │       ├── dataset-hash.ts  # SHA-256 hash
│   │       └── github-issue-url.ts
│   ├── tutorials/               # @catune/tutorials — types + progress persistence
│   │   └── src/
│   │       ├── index.ts
│   │       ├── types.ts         # Tutorial, TutorialStep, TutorialProgress
│   │       └── progress.ts      # localStorage persistence
│   └── ui/                      # @catune/ui — shared layout components
│       └── src/
│           ├── index.ts         # Barrel: DashboardShell, DashboardPanel, VizLayout
│           ├── DashboardShell.tsx  # 3-section grid (header/main/sidebar)
│           ├── DashboardPanel.tsx  # Variant-based panel wrapper
│           ├── VizLayout.tsx    # Scroll/dashboard mode switcher
│           └── styles/
│               └── layout.css   # Layout CSS rules
├── wasm/
│   └── catune-solver/           # Rust FISTA solver crate
│       └── pkg/                 # wasm-pack output (committed)
├── supabase/                    # Supabase config
├── python/                      # Python utilities
├── test/                        # Test fixtures
├── docs/                        # Documentation
├── scripts/
│   └── combine-dist.mjs         # Merges app dists for GitHub Pages
├── package.json                 # Workspace root
├── tsconfig.base.json           # Shared TS compiler options
└── eslint.config.js             # Shared lint config
```

## Dependency DAG

```
@catune/core          ← leaf (no local deps)
@catune/compute       ← @catune/core
@catune/io            ← @catune/core
@catune/community     ← @catune/core
@catune/tutorials     ← leaf (no local deps)
@catune/ui            ← leaf (solid-js only)
apps/catune           ← all packages
apps/carank           ← @catune/core, @catune/io, @catune/ui
```

## Package Responsibilities

| Package             | Responsibility                                             | Key deps                                   |
| ------------------- | ---------------------------------------------------------- | ------------------------------------------ |
| `@catune/core`      | Shared types, pure utilities, domain math, WASM adapter    | `valibot`                                  |
| `@catune/compute`   | Generic worker pool, warm-start caching                    | `@catune/core`                             |
| `@catune/io`        | File parsers (.npy/.npz), data validation, JSON export     | `@catune/core`, `fflate`, `valibot`        |
| `@catune/community` | Supabase DAL, submission logic, field options              | `@catune/core`, `@supabase/supabase-js`    |
| `@catune/tutorials` | Tutorial type definitions, progress persistence            | none                                       |
| `@catune/ui`        | Shared layout: DashboardShell, DashboardPanel, VizLayout   | `solid-js`                                 |
| `apps/catune`       | SolidJS app — UI components, reactive stores, worker entry | all packages                               |
| `apps/carank`       | SolidJS app — CNMF trace quality ranking                   | `@catune/core`, `@catune/io`, `@catune/ui` |

Packages export pure logic. The app wires packages to SolidJS signals.

## State Management

CaTune uses **module-level SolidJS signals** instead of Context providers. State modules export signals and setters directly:

- `data-store.ts` — loaded traces, parameters, solver results
- `viz-store.ts` — zoom range, selected cell, UI toggles
- `multi-cell-store.ts` — multi-cell selection and ranking
- `spectrum-store.ts` — power spectrum computation
- `community-store.ts` — auth state, field options (imports from `@catune/community`)
- `tutorial-store.ts` — active tutorial state (imports from `@catune/tutorials`)

This pattern avoids provider nesting and makes state accessible from non-component code (e.g., the tutorial engine).

## Solver Pipeline

```
User adjusts params
  → data-store signals update
  → cell-solve-manager debounces and dispatches
  → @catune/compute worker-pool assigns job to idle Web Worker
  → pool-worker.ts (in worker thread):
      → @catune/core wasm-adapter → WASM Solver
      → cooperative cancellation via MessageChannel yields
      → intermediate results posted at ~100ms intervals
  → worker-pool routes results back to data-store
```

Key design decisions:

- **Raw postMessage** (not Comlink) so the event loop can process cancel messages between solver batches
- **MessageChannel yields** (<1ms) instead of setTimeout(0) (~4ms) for cooperative multitasking
- **Warm-start caching** (`@catune/compute`) reuses solver state when only lambda changes (kernel unchanged)
- **Worker URL injection** — `createWorkerPool(url)` accepts a URL so the Vite worker entry stays in the app

## Module Boundaries

### WASM Adapter Rule

Only `packages/core/src/wasm-adapter.ts` imports from `wasm/catune-solver/pkg/`. All other code imports `{ initWasm, Solver }` from `@catune/core`. Enforced by ESLint `no-restricted-imports`.

### Supabase Isolation

Only `packages/community/src/supabase.ts` dynamically imports `@supabase/supabase-js` (~45KB). The SDK is lazy-loaded on first use. The `supabaseEnabled` boolean is re-exported through the community barrel. Enforced by ESLint `no-restricted-imports`.

### Package Barrel Rule

App files import from package barrels (`@catune/core`, `@catune/io`, etc.) — never from internal paths like `@catune/core/src/ar2.ts`. Enforced by ESLint `no-restricted-imports`.

### App Barrels

Each app sub-module (`community/`, `tutorial/`) has a thin `index.ts` barrel that re-exports from both the package and local SolidJS stores. Components import from these barrels.

## CSS Conventions

- Pure CSS with custom properties (no CSS-in-JS)
- Design tokens in `styles/global.css` (colors, spacing, shadows)
- Component styles co-located in `styles/` directory
- Dark theme throughout (scientific instrument aesthetic)
- `DashboardPanel` component with `data-panel-id` for layout targeting
