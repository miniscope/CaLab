# Adding a New App to CaLab

This guide walks through creating a new app in the CaLab monorepo.

## Steps

### 1. Copy the template

```bash
cp -r apps/_template apps/<name>
```

### 2. Replace placeholders

In your new `apps/<name>/` directory, find-and-replace these tokens:

| Placeholder            | Replace with                                    | Example  |
| ---------------------- | ----------------------------------------------- | -------- |
| `app-template`         | npm workspace name (lowercase)                  | `caview` |
| `__APP_ID__`           | App id slug (`^[a-z][a-z0-9_-]{1,31}$`)         | `caview` |
| `__APP_DISPLAY_NAME__` | Human-readable name (PascalCase), URL path name | `CaView` |

`calab.id` is the app's identity everywhere: the analytics `app_name`, the
GitHub issue label, and the `__APP_ID__` global that app code reads (injected
by `@calab/vite-config`). The build fails with a clear error until it is set.
No database migration, edge-function deploy, or `@calab/community` type edit
is needed for a new id.

Files that contain placeholders:

- `package.json` — name (`app-template`), calab.id, calab.displayName, calab.description
- `index.html` — `<title>`
- `src/App.tsx` — header title, placeholder text

Also fill in the following `calab` fields in `package.json`:

| Field             | Description                              | Example                             |
| ----------------- | ---------------------------------------- | ----------------------------------- |
| `description`     | Short tagline for the app                | `"Trace visualization"`             |
| `longDescription` | One-paragraph app description            | `"Interactively explore traces..."` |
| `features`        | Array of feature strings                 | `["Feature 1", "Feature 2"]`        |
| `status`          | `"stable"`, `"beta"`, or `"coming-soon"` | `"beta"`                            |
| `screenshot`      | Filename of app screenshot (or `""`)     | `"screenshot.png"`                  |

These fields populate the CaLab landing page. Apps with `status: "stable"` appear first, then `"beta"`, then `"coming-soon"`.

### 3. Install dependencies

From the repo root:

```bash
npm install
```

npm auto-discovers the new workspace under `apps/*`.

### 4. (Optional) Add a dev script to root package.json

`npm run dev -w apps/<name>` works without it; a root shortcut is a convenience:

```jsonc
// package.json (root)
"scripts": {
  "dev:<name>": "npm run dev -w apps/<name>"
}
```

### 5. Verify

```bash
npm run dev:<name>     # Dev server starts
npm run typecheck      # No errors
npm run build:apps     # Builds all apps including yours
```

The build, typecheck and deploy scripts auto-discover apps (`apps/*/package.json`
and `apps/*/tsconfig.json`), so no changes are needed to `build-apps.mjs`,
`typecheck.mjs`, `combine-dist.mjs`, or CI.

## Build config

`vite.config.ts` is one call to the shared factory:

```ts
import { defineCalabApp } from '@calab/vite-config';

export default defineCalabApp(import.meta.dirname); // { wasm: true } if it loads the solver
```

It sets the GitHub Pages `base`, the Solid plugin, the Vitest environment and
`__APP_ID__`; `{ wasm: true }` adds the WASM plugin to the main and worker
builds. `tsconfig.json` just extends `../../tsconfig.app.json`.

## Adding more `@calab/*` packages

Add the package to `dependencies` in the app's `package.json` (e.g.
`"@calab/compute": "*"`) and run `npm install` from the root. No Vite alias or
tsconfig path is needed: every package's `package.json` points at its
TypeScript source, and Vite and tsc both resolve the workspace link.
