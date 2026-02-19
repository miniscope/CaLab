# CaTune Architecture

CaTune is a browser-based calcium imaging deconvolution tool built with SolidJS, TypeScript, and a Rust/WASM solver.

## Directory Layout

```
src/
  App.tsx                  # Root component, routing, layout
  components/              # UI components organized by feature
    cards/                 # Cell cards, trace overview, zoom window
    community/             # Community browser, submit form, scatter plot
    import/                # File drop zone, trace preview, validation
    layout/                # Header, sidebar, panels, overlays
    spectrum/              # Power spectrum visualization
    traces/                # Trace panel, kernel display
    tutorial/              # Tutorial launcher, popover
  lib/                     # Core logic (non-UI)
    chart/                 # Chart helpers: kernel math, downsample, series config
    community/             # Community service, store, types
    metrics/               # Quality metrics
    schemas/               # Runtime validation schemas (Valibot)
    spectrum/              # Spectrum computation
    tutorial/              # Tutorial engine, content, progress
    ar2.ts                 # AR(2) coefficient computation
    cell-solve-manager.ts  # Orchestrates per-cell solver jobs
    data-store.ts          # Global data state (signals)
    export.ts              # JSON export/import
    multi-cell-store.ts    # Multi-cell selection state
    solver-types.ts        # Worker protocol types
    supabase.ts            # Supabase singleton (lazy, isolated)
    viz-store.ts           # Visualization state (signals)
    warm-start-cache.ts    # Solver warm-start state cache
    wasm-adapter.ts        # Single WASM import point
    worker-pool.ts         # Web Worker pool with typed dispatch
  workers/
    pool-worker.ts         # WASM solver worker (raw postMessage)
  styles/                  # CSS files
wasm/
  catune-solver/           # Rust FISTA solver crate
    pkg/                   # wasm-pack output (committed)
```

## State Management

CaTune uses **module-level SolidJS signals** instead of Context providers. State modules export signals and setters directly:

- `data-store.ts` — loaded traces, parameters, solver results
- `viz-store.ts` — zoom range, selected cell, UI toggles
- `multi-cell-store.ts` — multi-cell selection and ranking

This pattern avoids provider nesting and makes state accessible from non-component code (e.g., the tutorial engine).

## Solver Pipeline

```
User adjusts params
  → data-store signals update
  → cell-solve-manager debounces and dispatches
  → worker-pool assigns job to idle Web Worker
  → pool-worker.ts (in worker thread):
      → wasm-adapter.ts → WASM Solver
      → cooperative cancellation via MessageChannel yields
      → intermediate results posted at ~100ms intervals
  → worker-pool routes results back to data-store
```

Key design decisions:

- **Raw postMessage** (not Comlink) so the event loop can process cancel messages between solver batches
- **MessageChannel yields** (<1ms) instead of setTimeout(0) (~4ms) for cooperative multitasking
- **Warm-start caching** reuses solver state when only lambda changes (kernel unchanged)

## Module Boundaries

### WASM Adapter Rule

Only `src/lib/wasm-adapter.ts` imports from `wasm/catune-solver/pkg/`. All other code imports `{ initWasm, Solver }` from the adapter. Enforced by ESLint `no-restricted-imports`.

### Supabase Isolation

Only `src/lib/supabase.ts` dynamically imports `@supabase/supabase-js` (~45KB). The SDK is lazy-loaded on first use. The `supabaseEnabled` boolean is read by layout components to conditionally render community features. Enforced by ESLint `no-restricted-imports`.

### Barrel Files

Each sub-module (`chart/`, `community/`, `tutorial/`) has an `index.ts` barrel file that re-exports the public API. Prefer importing from the barrel rather than internal files.

## CSS Conventions

- Pure CSS with custom properties (no CSS-in-JS)
- Design tokens in `styles/global.css` (colors, spacing, shadows)
- Component styles co-located in `styles/` directory
- Dark theme throughout (scientific instrument aesthetic)
- `DashboardPanel` component with `data-panel-id` for layout targeting
