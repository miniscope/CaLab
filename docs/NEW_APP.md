# Adding a New App to CaLab

## One command

```bash
npm run new-app caview CaView
npm run dev caview
```

The first argument is the app id, the second its display name:

- **id**: a lowercase slug matching `^[a-z][a-z0-9_-]{1,31}$` (`APP_ID_PATTERN`
  in `@calab/vite-config`). It names the directory (`apps/<id>`) and the npm
  workspace, and becomes `calab.id`: the analytics `app_name`, the GitHub issue
  label, and the `__APP_ID__` global in app code. No database migration,
  edge-function deploy or `@calab/community` edit is needed for a new id.
- **display name**: PascalCase, no spaces. It is the page title and the URL
  path (`/CaLab/<DisplayName>/`).

Flags (npm needs `--` before them): `npm run new-app -- caview CaView --wasm --status beta`.

| Flag           | Effect                                                         |
| -------------- | -------------------------------------------------------------- |
| `--wasm`       | `defineCalabApp(import.meta.dirname, { wasm: true })`          |
| `--status <s>` | `stable`, `beta` or `coming-soon` (default `coming-soon`)      |
| `--no-install` | skip `npm install` (run it yourself before `npm run dev <id>`) |

The scaffolder refuses an existing directory, id or display name. It copies
`apps/_template`, fills in the placeholders, sets `calab.hidden: false`, runs
prettier and `npm install`, and prints the next steps. Commit `apps/<id>` and
the `package-lock.json` change.

## What you get

A minimal app that already runs, tests, lints, type-checks and builds:

- `src/index.tsx`: the startup every CaLab app uses: a tutorial-progress
  storage key derived from `__APP_ID__`, `initCommunityStore()`, render, then
  `initSession(__APP_ID__)` (anonymous analytics; a no-op without Supabase).
- `src/App.tsx`: the magic-link sign-in page (`isAuthCallback` /
  `AuthCallback`), the shared import flow (`ImportOverlay` from
  `@calab/ui/import` on the `createImportStore()` in `src/lib/data-store.ts`),
  and a `DashboardShell` once data is loaded, with a `FeedbackMenu` and the
  sign-in menu in the header.
- `src/components/TraceView.tsx`: a placeholder result view (a cell picker and
  a `TraceOverview` chart). Replace it with your analysis.
- `src/__tests__/App.test.tsx`: renders the app, checks the import overlay,
  then loads data through the store and checks the dashboard.
- `vite.config.ts`: one `defineCalabApp` call; `tsconfig.json` extends
  `../../tsconfig.app.json`.

Demo data comes from the Rust simulator, imported on first click on the main
thread, which needs no WASM plugin.

## Optional pieces

- **WASM in a worker** (running the solver off the main thread, as CaTune and
  CaDecon do): `{ wasm: true }` in `vite.config.ts`, or `--wasm` at creation.
- **Community submissions**: `SubmitForm`, `SubmitFormModal` and the payload
  helpers in `@calab/community-ui`, backed by `@calab/community`. See
  `apps/catune/src/components/community/`.
- **Python bridge** (`calab.launch('<id>', traces)` opens the app on data from
  Python): `getBridgeUrl` and `loadFromBridge` in `@calab/io`, see
  `apps/cadecon/src/lib/bridge-effects.ts`. The bridge finds the app's URL in
  `apps.json`; the shape of the results it sends back is declared by an
  `AppSpec` entry in `python/src/calab/_bridge/_registry.py`.
- **More `@calab/*` packages**: add `"@calab/<pkg>": "*"` to `dependencies` and
  run `npm install`. No Vite alias or tsconfig path is needed.

## The `calab` block

The `calab` block in the app's `package.json` is the only place an app is
registered.

| Field             | Effect                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| `id`              | App identity (see above). The build fails on anything not matching the slug pattern.                          |
| `displayName`     | Card title, page title, URL path and `apps.json` `path`.                                                      |
| `description`     | Card tagline and `apps.json` `description`.                                                                   |
| `longDescription` | One paragraph about the app.                                                                                  |
| `features`        | Bullet list on the card.                                                                                      |
| `status`          | Badge and order: `stable`, then `beta`, then `coming-soon`. Every card links to its app.                      |
| `hidden`          | `true`: still built and deployed at its URL, but no landing card and no `apps.json` entry (so no bridge use). |
| `screenshot`      | Image file in the app directory for the card thumbnail, or `""`.                                              |

`apps/_template` itself is `hidden: true` and is never built or deployed: its
`calab.id` is the `__APP_ID__` placeholder, which `@calab/vite-config` accepts
only under Vitest. It is linted, type-checked and tested like any app, so the
template cannot rot.

## Browser smoke test

`e2e/landing.spec.ts` covers the new card automatically (it links to
`<DisplayName>/` and the page mounts). Add `e2e/<id>.spec.ts` for the app's
main path; see "Adding a spec for a new app" in `e2e/README.md`.

## Nothing else lists apps

Every tool discovers apps from `apps/*/package.json`: lint, typecheck
(`scripts/typecheck.mjs`), the test-script check (`scripts/check-app-tests.mjs`),
`npm test`, `npm run test:coverage`, `npm run dev <app>`, the build
(`scripts/build-apps.mjs`), the landing page and `apps.json`
(`scripts/combine-dist.mjs`), the e2e landing spec and the Python bridge's app URLs
(read from `apps.json`). CI runs the scaffolder end to end on every PR.
