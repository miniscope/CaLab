# Adding a New App to CaLab

This guide walks through creating a new app in the CaLab monorepo.

## Steps

### 1. Copy the template

```bash
cp -r apps/_template apps/<name>
```

### 2. Replace placeholders

In your new `apps/<name>/` directory, find-and-replace these tokens:

| Placeholder            | Replace with                     | Example  |
| ---------------------- | -------------------------------- | -------- |
| `app-template`         | npm workspace name (lowercase)   | `caview` |
| `__APP_DISPLAY_NAME__` | Human-readable name (PascalCase) | `CaView` |

Files that contain placeholders:

- `package.json` — name (`app-template`), calab.displayName, calab.description
- `index.html` — `<title>`
- `src/App.tsx` — header title, placeholder text

Also fill in `calab.description` in `package.json` (e.g., `"Trace visualization"`).

### 3. Install dependencies

From the repo root:

```bash
npm install
```

npm auto-discovers the new workspace under `apps/*`.

### 4. Add dev script to root package.json

```jsonc
// package.json (root)
"scripts": {
  "dev:<name>": "npm run dev -w apps/<name>"
}
```

### 5. Add to typecheck

```jsonc
// package.json (root)
"scripts": {
  "typecheck": "tsc -b apps/catune apps/carank apps/<name>"
}
```

### 6. Verify

```bash
npm run dev:<name>     # Dev server starts
npm run typecheck      # No errors
npm run build:apps     # Builds all apps including yours
```

The build and deploy scripts auto-discover apps from `apps/*/package.json`,
so no changes are needed to `build-apps.mjs`, `combine-dist.mjs`, or CI.

## Adding more `@calab/*` packages

The template includes `@calab/core`, `@calab/io`, and `@calab/ui` by default.
To add another package (e.g., `@calab/compute`):

1. **package.json** — add to `dependencies`:

   ```json
   "@calab/compute": "*"
   ```

2. **vite.config.ts** — add alias:

   ```ts
   '@calab/compute': path.resolve(repoRoot, 'packages/compute/src'),
   ```

3. **tsconfig.json** — add path mapping and reference:

   ```json
   "paths": {
     "@calab/compute": ["../../packages/compute/src/index.ts"],
     "@calab/compute/*": ["../../packages/compute/src/*"]
   }
   ```

   ```json
   "references": [
     { "path": "../../packages/compute" }
   ]
   ```

4. Run `npm install` from the root to link the workspace dependency.
